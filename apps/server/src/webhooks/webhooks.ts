import type { WebhookDeliveryPayload, WebhookEventName } from '@bokydo/shared';
import { webhookEventNames } from '@bokydo/shared';
import { and, asc, count, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { newToken } from '../auth/tokens.js';
import type { EncryptedValue } from '../crypto/envelope.js';
import { decryptSecret, encryptSecret } from '../crypto/envelope.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  activity,
  projectMembers,
  projects,
  users,
  webhookDeliveries,
  webhookState,
  webhookSubscriptions,
} from '../db/schema.js';
import type { OutboundFetch } from '../net/outbound.js';
import { OutboundError } from '../net/outbound.js';
import type { SettingsService } from '../settings/settings-service.js';
import { projectAccess } from '../sync/policy.js';
import type { Tx } from '../sync/context.js';

/** A webhook is a standing data-export channel, so keep the per-user count small. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
/** How many deliveries one endpoint may receive per hour; excess is deferred, never dropped. */
const MAX_DELIVERIES_PER_HOUR = 500;
/** Attempts before a delivery is dead-lettered (the row stays for the UI). */
const MAX_ATTEMPTS = 8;
/** Wait before attempt n (1-based): a minute, then 5, 15, an hour, 6 hours, then daily. */
const BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  24 * 60 * 60_000,
];
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** The serialized body must stay small; if the snapshot exceeds it, ids-only plus `truncated`. */
const MAX_PAYLOAD_BYTES = 64 * 1024;
const ENQUEUE_BATCH = 500;
const DISPATCH_BATCH = 100;

/** The envelope-encryption context binds a secret to its subscription row and owner. */
const secretContext = (id: string, userId: string): string => `webhook:${id}:${userId}`;

export interface WebhooksDeps {
  db: Database;
  settings: SettingsService;
  masterKey: Buffer;
  fetch: OutboundFetch;
}

/**
 * Outgoing webhooks (W10d). Events come from the project activity log: every task/project/comment
 * event is already written there inside the command's transaction, with the actor and a small
 * snapshot. This service tails that log with a watermark (`webhook_state`), freezes one payload
 * per (event, subscription) pair into `webhook_deliveries`, and posts each one through the
 * SSRF-safe outbound client with the public-only policy — user webhooks never reach private
 * networks, whatever DNS says. Delivery is at-least-once: receivers dedupe on the delivery id.
 */
export class Webhooks {
  /** The outbound POST. Swappable in tests (the same way tests patch the mailer). */
  fetch: OutboundFetch;

  constructor(private readonly deps: WebhooksDeps) {
    this.fetch = deps.fetch;
  }

  private get db(): Database {
    return this.deps.db;
  }

  private get enabled(): boolean {
    return this.deps.settings.get('api.webhooksEnabled');
  }

  /** Seal a fresh signing secret for a subscription row. */
  sealSecret(id: string, userId: string, secret: string): EncryptedValue {
    return encryptSecret(this.deps.masterKey, secret, secretContext(id, userId));
  }

  /**
   * Fan new activity out to matching subscriptions. Runs in one transaction per batch so the
   * watermark only ever advances over rows whose deliveries are committed. When the admin has
   * webhooks off, the watermark still advances: events during the outage are not delivered, the
   * same way a disabled GitHub webhook misses events.
   */
  async enqueue(now: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      const [state] = await tx.select().from(webhookState).where(eq(webhookState.id, 1));
      if (!state) {
        // First run ever: start at the head of the log. History is not replayed.
        const [head] = await tx
          .select({ maxId: sql<number>`coalesce(max(${activity.id}), 0)` })
          .from(activity);
        await tx
          .insert(webhookState)
          .values({ id: 1, lastActivityId: head?.maxId ?? 0 })
          .onConflictDoNothing();
        return 0;
      }
      if (!this.enabled) {
        // Skip past everything that happened while disabled, without queueing anything.
        await tx
          .update(webhookState)
          .set({
            lastActivityId: sql`greatest(${webhookState.lastActivityId}, coalesce((select max(${activity.id}) from ${activity}), 0))`,
          })
          .where(eq(webhookState.id, 1));
        return 0;
      }
      let last = state.lastActivityId;
      let processed = 0;
      for (let round = 0; round < 10; round++) {
        const rows = await tx
          .select()
          .from(activity)
          .where(and(gt(activity.id, last), inArray(activity.type, [...webhookEventNames])))
          .orderBy(asc(activity.id))
          .limit(ENQUEUE_BATCH);
        if (rows.length === 0) break;
        await this.fanOut(tx, rows, now);
        last = rows[rows.length - 1]!.id;
        processed += rows.length;
        if (rows.length < ENQUEUE_BATCH) break;
      }
      if (last !== state.lastActivityId)
        await tx.update(webhookState).set({ lastActivityId: last }).where(eq(webhookState.id, 1));
      return processed;
    });
  }

  /** One delivery row per (activity row, subscription) pair, payload frozen at enqueue time. */
  private async fanOut(tx: Tx, rows: (typeof activity.$inferSelect)[], now: Date): Promise<void> {
    const projectIds = [...new Set(rows.map((r) => r.projectId))];
    const memberIds = new Set<string>();
    for (const projectId of projectIds) {
      const members = await tx
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(and(eq(projectMembers.projectId, projectId), isNull(users.disabledAt)));
      for (const m of members) memberIds.add(m.userId);
    }
    if (memberIds.size === 0) return;
    const subscriptions = await tx
      .select()
      .from(webhookSubscriptions)
      .where(inArray(webhookSubscriptions.userId, [...memberIds]));
    if (subscriptions.length === 0) return;
    const names = new Map(
      (
        await tx
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      ).map((p) => [p.id, p.name]),
    );
    const inserts: (typeof webhookDeliveries.$inferInsert)[] = [];
    for (const row of rows) {
      const matching = subscriptions.filter(
        (s) =>
          memberIds.has(s.userId) &&
          s.events.includes(row.type as WebhookEventName) &&
          s.createdAt <= row.at,
      );
      if (matching.length === 0) continue;
      const base: Omit<WebhookDeliveryPayload, 'id'> = {
        event: row.type as WebhookEventName,
        createdAt: row.at.toISOString(),
        actorId: row.actorId,
        project: { id: row.projectId, name: names.get(row.projectId) ?? null },
        taskId: row.taskId,
        data: (row.data ?? {}) as Record<string, unknown>,
      };
      for (const subscription of matching) {
        const payload = this.sizePayload({ ...base, id: newId() });
        inserts.push({
          id: payload.id,
          subscriptionId: subscription.id,
          event: payload.event,
          sourceActivityId: row.id,
          payload,
          status: 'pending',
          nextAttemptAt: now,
        });
      }
    }
    if (inserts.length) await tx.insert(webhookDeliveries).values(inserts);
  }

  /** Keeps the frozen body within the size cap by dropping the snapshot if it is huge. */
  private sizePayload(payload: WebhookDeliveryPayload): WebhookDeliveryPayload {
    if (JSON.stringify(payload).length <= MAX_PAYLOAD_BYTES) return payload;
    return { ...payload, data: {}, truncated: true };
  }

  /**
   * Post every delivery that is due. Success is a 2xx; anything else (network error, refusal
   * code, redirect, timeout) retries on the backoff schedule until `MAX_ATTEMPTS`, then the row
   * is dead-lettered as `failed`. Returns how many deliveries were handled.
   */
  async dispatch(now: Date): Promise<number> {
    if (!this.enabled) return 0;
    const due = await this.db
      .select({ delivery: webhookDeliveries, subscription: webhookSubscriptions })
      .from(webhookDeliveries)
      .innerJoin(
        webhookSubscriptions,
        eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId),
      )
      .where(
        and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now)),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(DISPATCH_BATCH);
    for (const { delivery, subscription } of due)
      await this.deliverOne(delivery, subscription, now);
    return due.length;
  }

  private async deliverOne(
    delivery: typeof webhookDeliveries.$inferSelect,
    subscription: typeof webhookSubscriptions.$inferSelect,
    now: Date,
  ): Promise<void> {
    const payload = delivery.payload;

    // Access is judged at delivery time, never at enqueue time only (the feed rule, T110/T78).
    if (payload.project) {
      const access = await this.db.transaction((tx) =>
        projectAccess(tx, subscription.userId, payload.project!.id),
      );
      if (!access) {
        await this.finish(delivery.id, { status: 'dropped', error: 'access_lost', now });
        return;
      }
    }
    const [owner] = await this.db
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, subscription.userId));
    if (!owner || owner.disabledAt) {
      await this.finish(delivery.id, { status: 'dropped', error: 'owner_disabled', now });
      return;
    }

    // A busy project must not turn one user's endpoint into a firehose: defer past the cap.
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const [recentRow] = await this.db
      .select({ recent: count() })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.subscriptionId, subscription.id),
          gt(webhookDeliveries.createdAt, hourAgo),
        ),
      );
    if ((recentRow?.recent ?? 0) >= MAX_DELIVERIES_PER_HOUR) {
      await this.db
        .update(webhookDeliveries)
        .set({ nextAttemptAt: new Date(now.getTime() + 60_000) })
        .where(eq(webhookDeliveries.id, delivery.id));
      return;
    }

    let secret: string;
    try {
      secret = decryptSecret(
        this.deps.masterKey,
        subscription.secret as EncryptedValue,
        secretContext(subscription.id, subscription.userId),
      );
    } catch {
      // A moved or re-encrypted ciphertext (or a rotated master key) must not retry forever.
      await this.finish(delivery.id, {
        status: 'failed',
        error: 'secret_invalid',
        now,
        attempts: MAX_ATTEMPTS,
      });
      return;
    }

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    try {
      const res = await this.fetch(subscription.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': 'BokyDo-Webhooks',
          'x-bokydo-event': delivery.event,
          'x-bokydo-delivery': delivery.id,
          'x-bokydo-timestamp': timestamp,
          'x-bokydo-signature': `sha256=${signature}`,
        },
        body,
        timeoutMs: DELIVERY_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      // The status is all we need; the response body is never read or echoed anywhere.
      res.cancel();
      if (res.status >= 200 && res.status < 300) {
        await this.finish(delivery.id, {
          status: 'delivered',
          now,
          responseStatus: res.status,
          subscription,
        });
      } else {
        await this.retry(delivery, subscription, now, `http_${res.status}`, res.status);
      }
    } catch (err) {
      const reason = err instanceof OutboundError ? err.reason : 'network';
      await this.retry(delivery, subscription, now, reason);
    }
  }

  private async finish(
    id: string,
    opts: {
      status: 'delivered' | 'dropped' | 'failed';
      now: Date;
      error?: string;
      responseStatus?: number;
      attempts?: number;
      subscription?: typeof webhookSubscriptions.$inferSelect;
    },
  ): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({
        status: opts.status,
        attempts: opts.attempts,
        lastAttemptAt: opts.now,
        lastError: opts.error ?? null,
        responseStatus: opts.responseStatus ?? null,
        deliveredAt: opts.status === 'delivered' ? opts.now : null,
      })
      .where(eq(webhookDeliveries.id, id));
    if (opts.status === 'delivered' && opts.subscription) {
      await this.db
        .update(webhookSubscriptions)
        .set({ lastSuccessAt: opts.now, lastError: null })
        .where(eq(webhookSubscriptions.id, opts.subscription.id));
    } else if (opts.error && opts.subscription) {
      await this.db
        .update(webhookSubscriptions)
        .set({ lastFailureAt: opts.now, lastError: opts.error })
        .where(eq(webhookSubscriptions.id, opts.subscription.id));
    }
  }

  private async retry(
    delivery: typeof webhookDeliveries.$inferSelect,
    subscription: typeof webhookSubscriptions.$inferSelect,
    now: Date,
    reason: string,
    responseStatus?: number,
  ): Promise<void> {
    const attempts = delivery.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.finish(delivery.id, {
        status: 'failed',
        now,
        error: reason,
        ...(responseStatus !== undefined ? { responseStatus } : {}),
        attempts,
        subscription,
      });
      return;
    }
    await this.db
      .update(webhookDeliveries)
      .set({
        attempts,
        lastAttemptAt: now,
        lastError: reason,
        responseStatus: responseStatus ?? null,
        nextAttemptAt: new Date(
          now.getTime() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!,
        ),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    await this.db
      .update(webhookSubscriptions)
      .set({ lastFailureAt: now, lastError: reason })
      .where(eq(webhookSubscriptions.id, subscription.id));
  }

  /** Queue a synthetic delivery so a user can verify their endpoint and signature check. */
  async createTestDelivery(userId: string, subscriptionId: string): Promise<string | null> {
    const [subscription] = await this.db
      .select()
      .from(webhookSubscriptions)
      .where(
        and(eq(webhookSubscriptions.id, subscriptionId), eq(webhookSubscriptions.userId, userId)),
      );
    if (!subscription) return null;
    const payload: WebhookDeliveryPayload = {
      id: newId(),
      event: 'test',
      createdAt: new Date().toISOString(),
      actorId: userId,
      project: null,
      taskId: null,
      data: { message: 'BokyDo webhook test delivery' },
    };
    await this.db.insert(webhookDeliveries).values({
      id: payload.id,
      subscriptionId,
      event: payload.event,
      payload,
      status: 'pending',
      nextAttemptAt: new Date(),
    });
    return payload.id;
  }
}

/** A fresh signing secret, base64url (256 bits) — the same format as every other BokyDo secret. */
export function newWebhookSecret(): string {
  return newToken();
}
