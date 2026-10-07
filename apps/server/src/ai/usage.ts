import { AI_FEATURE_KEYS, type AiFeature } from '@bokydo/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { aiUsage, users } from '../db/schema.js';

/**
 * A reservation older than this no longer counts against the budget (its call crashed or was
 * killed before settling). Every provider call times out well before.
 */
export const RESERVATION_TTL_MINUTES = 15;

export interface UsageAmounts {
  tokens: number;
  audioSeconds: number;
}

export interface ReportedUsage {
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
}

export class AiBudgetExceededError extends Error {
  constructor(readonly kind: 'tokens' | 'audio') {
    super(`AI ${kind} budget exceeded`);
  }
}

/** Start of the current month in UTC: budgets reset at 00:00 UTC on the 1st. */
const MONTH_START = sql`date_trunc('month', now() at time zone 'utc') at time zone 'utc'`;

/** Budget consumed this month on instance credentials: settled usage plus live reservations. */
const spentSince = (userId: string) => sql`
  select
    coalesce(sum(case when status = 'reserved' then reserved_tokens
                      else input_tokens + output_tokens end), 0)::bigint as tokens,
    coalesce(sum(case when status = 'reserved' then reserved_audio_seconds
                      else audio_seconds end), 0)::bigint as audio
  from ai_usage
  where user_id = ${userId}
    and billing = 'instance'
    and started_at >= ${MONTH_START}
    and (status <> 'reserved'
         or started_at > now() - make_interval(mins => ${RESERVATION_TTL_MINUTES}))`;

export interface ReserveInput {
  userId: string;
  credentialId: string;
  billing: 'own' | 'instance';
  feature: AiFeature;
  provider: string;
  model: string;
  /** Worst case for this call (prompt estimate + max output; audio length). */
  estimate: UsageAmounts;
  /** Monthly limits; null = unlimited. Only applied to instance billing. */
  budget: { tokens: number | null; audioSeconds: number | null };
}

/**
 * Reserve a call's worst-case cost. For instance billing the check and the insert happen under
 * a per-user advisory lock, so parallel requests are serialised and can't jointly overspend.
 */
export async function reserveUsage(db: Database, input: ReserveInput): Promise<string> {
  const id = newId();
  const tokens = Math.max(0, Math.ceil(input.estimate.tokens));
  const audio = Math.max(0, Math.ceil(input.estimate.audioSeconds));
  await db.transaction(async (tx) => {
    if (input.billing === 'instance') {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`bokydo:ai-budget:${input.userId}`}))`,
      );
      const [spent] = (await tx.execute(spentSince(input.userId))) as unknown as {
        tokens: string;
        audio: string;
      }[];
      const usedTokens = Number(spent?.tokens ?? 0);
      const usedAudio = Number(spent?.audio ?? 0);
      const { budget } = input;
      // A call with no estimate still counts as one token, so a budget of 0 really means none.
      const chargedTokens = audio > 0 ? tokens : Math.max(tokens, 1);
      if (budget.tokens !== null && chargedTokens > 0 && usedTokens + chargedTokens > budget.tokens)
        throw new AiBudgetExceededError('tokens');
      if (budget.audioSeconds !== null && audio > 0 && usedAudio + audio > budget.audioSeconds)
        throw new AiBudgetExceededError('audio');
    }
    await tx.insert(aiUsage).values({
      id,
      userId: input.userId,
      credentialId: input.credentialId,
      billing: input.billing,
      feature: input.feature,
      provider: input.provider,
      model: input.model,
      status: 'reserved',
      reservedTokens: tokens,
      reservedAudioSeconds: audio,
    });
  });
  return id;
}

/** Replace a reservation with what the call actually used. */
export async function settleUsage(
  db: Database,
  id: string,
  status: 'done' | 'failed',
  used: ReportedUsage,
): Promise<void> {
  const clamp = (n: number) => Math.min(2_000_000_000, Math.max(0, Math.round(n || 0)));
  await db
    .update(aiUsage)
    .set({
      status,
      inputTokens: clamp(used.inputTokens),
      outputTokens: clamp(used.outputTokens),
      audioSeconds: clamp(used.audioSeconds),
      finishedAt: new Date(),
    })
    .where(and(eq(aiUsage.id, id), eq(aiUsage.status, 'reserved')));
}

export interface UsageSummary {
  /** "YYYY-MM" (UTC). */
  month: string;
  instance: {
    tokens: number;
    audioSeconds: number;
    tokenBudget: number | null;
    audioSecondsBudget: number | null;
  };
  byFeature: {
    feature: AiFeature;
    billing: 'own' | 'instance';
    calls: number;
    tokens: number;
    audioSeconds: number;
  }[];
}

export async function userUsageSummary(
  db: Database,
  userId: string,
  budget: { tokens: number | null; audioSeconds: number | null },
): Promise<UsageSummary> {
  const [spent] = (await db.execute(spentSince(userId))) as unknown as {
    tokens: string;
    audio: string;
  }[];
  const rows = (await db.execute(sql`
    select feature, billing, count(*)::int as calls,
           coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens,
           coalesce(sum(audio_seconds), 0)::bigint as audio
    from ai_usage
    where user_id = ${userId} and status <> 'reserved' and started_at >= ${MONTH_START}
    group by feature, billing
    order by feature, billing`)) as unknown as {
    feature: string;
    billing: 'own' | 'instance';
    calls: number;
    tokens: string;
    audio: string;
  }[];
  return {
    month: new Date().toISOString().slice(0, 7),
    instance: {
      tokens: Number(spent?.tokens ?? 0),
      audioSeconds: Number(spent?.audio ?? 0),
      tokenBudget: budget.tokens,
      audioSecondsBudget: budget.audioSeconds,
    },
    byFeature: rows
      .filter((r) => (AI_FEATURE_KEYS as string[]).includes(r.feature))
      .map((r) => ({
        feature: r.feature as AiFeature,
        billing: r.billing,
        calls: r.calls,
        tokens: Number(r.tokens),
        audioSeconds: Number(r.audio),
      })),
  };
}

/** Admin view: this month's instance-credential usage per user. Own-key usage stays private. */
export async function instanceUsageByUser(db: Database) {
  const rows = (await db.execute(sql`
    select u.id as user_id, u.username, count(*)::int as calls,
           coalesce(sum(a.input_tokens + a.output_tokens), 0)::bigint as tokens,
           coalesce(sum(a.audio_seconds), 0)::bigint as audio
    from ai_usage a join ${users} u on u.id = a.user_id
    where a.billing = 'instance' and a.status <> 'reserved' and a.started_at >= ${MONTH_START}
    group by u.id, u.username
    order by tokens desc, u.username`)) as unknown as {
    user_id: string;
    username: string;
    calls: number;
    tokens: string;
    audio: string;
  }[];
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    calls: r.calls,
    tokens: Number(r.tokens),
    audioSeconds: Number(r.audio),
  }));
}
