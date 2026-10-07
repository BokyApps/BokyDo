import type {
  ApiScope,
  AuthorizedApp,
  PatCreate,
  PersonalAccessToken,
  TokenAudience,
} from '@bokydo/shared';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { mfaRequiredFor } from '../auth/factors.js';
import type { SessionUserRow } from '../auth/sessions.js';
import { newToken, tokenId } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { apiTokens, oauthClients, oauthGrants, users } from '../db/schema.js';
import type { SettingsService } from '../settings/settings-service.js';

/**
 * Token prefixes make leaked tokens recognisable to secret scanners and let us reject a token
 * presented in the wrong place (a refresh token is never a bearer credential).
 */
export const TOKEN_PREFIX = { pat: 'bkd_pat_', access: 'bkd_at_', refresh: 'bkd_rt_' } as const;
type TokenKind = keyof typeof TOKEN_PREFIX;

export const ACCESS_TOKEN_TTL_S = 3600;
/** A refresh token unused for this long expires; each refresh issues a fresh one. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000;
export const MAX_PATS_PER_USER = 50;
const TOUCH_INTERVAL_MS = 60_000;

/** Who a valid bearer token speaks for, and what it may do. */
export interface TokenPrincipal {
  id: string;
  kind: 'pat' | 'access';
  user: SessionUserRow;
  scopes: ApiScope[];
  grantId: string | null;
  clientId: string | null;
}

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export class PatLimitError extends Error {}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export class ApiTokenStore {
  constructor(
    private readonly db: Database,
    private readonly key: Buffer,
    private readonly settings: SettingsService,
  ) {}

  private hash(kind: TokenKind, token: string): string {
    return tokenId(this.key, `api:${kind}`, token);
  }

  private mint(kind: TokenKind): { token: string; hash: string } {
    const token = TOKEN_PREFIX[kind] + newToken();
    return { token, hash: this.hash(kind, token) };
  }

  /**
   * Resolve a bearer token for `audience`. Refresh tokens, revoked or expired tokens, tokens of
   * revoked grants, disabled users and the wrong audience all give null.
   */
  async authenticate(raw: string, audience: TokenAudience): Promise<TokenPrincipal | null> {
    const kind: TokenKind | null = raw.startsWith(TOKEN_PREFIX.pat)
      ? 'pat'
      : raw.startsWith(TOKEN_PREFIX.access)
        ? 'access'
        : null;
    if (!kind || raw.length > 100) return null;
    const [row] = await this.db
      .select({
        id: apiTokens.id,
        kind: apiTokens.kind,
        scopes: apiTokens.scopes,
        audience: apiTokens.audience,
        expiresAt: apiTokens.expiresAt,
        revokedAt: apiTokens.revokedAt,
        lastUsedAt: apiTokens.lastUsedAt,
        grantId: apiTokens.grantId,
        grantRevokedAt: oauthGrants.revokedAt,
        clientId: oauthGrants.clientId,
        userId: users.id,
        username: users.username,
        isAdmin: users.isAdmin,
        mustChangePassword: users.mustChangePassword,
        disabledAt: users.disabledAt,
        totpEnabledAt: users.totpEnabledAt,
        hasPasskey: sql<boolean>`exists(select 1 from webauthn_credentials wc where wc.user_id = "users"."id")`,
      })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .leftJoin(oauthGrants, eq(oauthGrants.id, apiTokens.grantId))
      .where(eq(apiTokens.hash, this.hash(kind, raw)));
    if (!row || row.kind !== kind) return null;
    const now = Date.now();
    if (row.revokedAt || row.disabledAt || row.grantRevokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= now) return null;
    if (row.grantId && !row.clientId) return null; // grant vanished
    if (row.audience !== null && row.audience !== audience) return null;
    if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db
        .update(apiTokens)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(apiTokens.id, row.id));
      if (row.grantId)
        await this.db
          .update(oauthGrants)
          .set({ lastUsedAt: new Date(now) })
          .where(eq(oauthGrants.id, row.grantId));
    }
    const hasFactor = Boolean(row.totpEnabledAt) || row.hasPasskey;
    return {
      id: row.id,
      kind,
      scopes: row.scopes as ApiScope[],
      grantId: row.grantId,
      clientId: row.clientId,
      user: {
        id: row.userId,
        username: row.username,
        isAdmin: row.isAdmin,
        mustChangePassword: row.mustChangePassword,
        mustEnrollMfa: !hasFactor && mfaRequiredFor(this.settings, { isAdmin: row.isAdmin }),
      },
    };
  }

  // ---- personal access tokens ----

  async createPat(
    userId: string,
    input: PatCreate,
  ): Promise<{ token: string; pat: PersonalAccessToken }> {
    const { token, hash } = this.mint('pat');
    const id = newId();
    const expiresAt =
      input.expiresInDays === null ? null : new Date(Date.now() + input.expiresInDays * 86_400_000);
    const row = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bokydo:pats:${userId}`}))`);
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(apiTokens)
        .where(activePats(userId))) as [{ n: number }];
      if (n >= MAX_PATS_PER_USER) throw new PatLimitError();
      const [inserted] = await tx
        .insert(apiTokens)
        .values({
          id,
          hash,
          kind: 'pat',
          userId,
          name: input.name,
          scopes: [...new Set(input.scopes)],
          audience: null,
          expiresAt,
        })
        .returning();
      if (!inserted) throw new Error('insert returned nothing');
      return inserted;
    });
    return { token, pat: toPat(row) };
  }

  async listPats(userId: string): Promise<PersonalAccessToken[]> {
    const rows = await this.db
      .select()
      .from(apiTokens)
      .where(activePats(userId))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(toPat);
  }

  async revokePat(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiTokens.id, id),
          eq(apiTokens.userId, userId),
          eq(apiTokens.kind, 'pat'),
          isNull(apiTokens.revokedAt),
        ),
      )
      .returning({ id: apiTokens.id });
    return rows.length > 0;
  }

  // ---- OAuth tokens ----

  /** Access + refresh token pair for a grant (inside the caller's transaction). */
  async issue(
    tx: Tx,
    grant: { id: string; userId: string; scopes: ApiScope[]; audience: TokenAudience },
  ): Promise<IssuedTokens> {
    const access = this.mint('access');
    const refresh = this.mint('refresh');
    const now = Date.now();
    await tx.insert(apiTokens).values([
      {
        id: newId(),
        hash: access.hash,
        kind: 'access',
        userId: grant.userId,
        grantId: grant.id,
        scopes: grant.scopes,
        audience: grant.audience,
        expiresAt: new Date(now + ACCESS_TOKEN_TTL_S * 1000),
      },
      {
        id: newId(),
        hash: refresh.hash,
        kind: 'refresh',
        userId: grant.userId,
        grantId: grant.id,
        scopes: grant.scopes,
        audience: grant.audience,
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      },
    ]);
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refresh.token,
      scope: grant.scopes.join(' '),
    };
  }

  /**
   * Rotate a refresh token. Each refresh token works once: presenting it again (an attacker
   * replaying a stolen one, or the real client after the attacker) revokes the whole grant, so
   * both lose access and the user must re-authorize (OAuth 2.1 §4.3.1).
   */
  async refresh(
    raw: string,
    clientId: string,
    narrowTo: ApiScope[] | null,
  ): Promise<IssuedTokens | 'invalid_grant' | 'invalid_scope'> {
    if (!raw.startsWith(TOKEN_PREFIX.refresh) || raw.length > 100) return 'invalid_grant';
    const hash = this.hash('refresh', raw);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: apiTokens.id,
          usedAt: apiTokens.usedAt,
          revokedAt: apiTokens.revokedAt,
          expiresAt: apiTokens.expiresAt,
          grantId: apiTokens.grantId,
          kind: apiTokens.kind,
        })
        .from(apiTokens)
        .where(eq(apiTokens.hash, hash))
        .for('update');
      if (!row || row.kind !== 'refresh' || !row.grantId) return 'invalid_grant';
      const [grant] = await tx
        .select()
        .from(oauthGrants)
        .innerJoin(users, eq(users.id, oauthGrants.userId))
        .where(eq(oauthGrants.id, row.grantId));
      if (!grant || grant.oauth_grants.clientId !== clientId) return 'invalid_grant';
      if (row.usedAt) {
        await revokeGrant(tx, row.grantId, 'refresh_token_reuse');
        return 'invalid_grant';
      }
      if (
        row.revokedAt ||
        grant.oauth_grants.revokedAt ||
        grant.users.disabledAt ||
        (row.expiresAt && row.expiresAt.getTime() <= Date.now())
      )
        return 'invalid_grant';
      const granted = grant.oauth_grants.scopes as ApiScope[];
      let scopes = granted;
      if (narrowTo) {
        if (narrowTo.length === 0 || narrowTo.some((s) => !granted.includes(s)))
          return 'invalid_scope';
        scopes = narrowTo;
      }
      await tx.update(apiTokens).set({ usedAt: new Date() }).where(eq(apiTokens.id, row.id));
      // The previous access tokens of this grant end with the rotation.
      await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiTokens.grantId, row.grantId),
            eq(apiTokens.kind, 'access'),
            isNull(apiTokens.revokedAt),
          ),
        );
      await tx
        .update(oauthGrants)
        .set({ lastUsedAt: new Date() })
        .where(eq(oauthGrants.id, row.grantId));
      return this.issue(tx, {
        id: row.grantId,
        userId: grant.oauth_grants.userId,
        scopes,
        audience: grant.oauth_grants.audience,
      });
    });
  }

  /**
   * RFC 7009 revocation by the client. Revoking a refresh token ends the whole grant; an access
   * token just itself. Tokens of other clients are left alone (and the reply doesn't say so).
   */
  async revokeByClient(raw: string, clientId: string): Promise<void> {
    const kind: TokenKind | null = raw.startsWith(TOKEN_PREFIX.refresh)
      ? 'refresh'
      : raw.startsWith(TOKEN_PREFIX.access)
        ? 'access'
        : null;
    if (!kind || raw.length > 100) return;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: apiTokens.id, grantId: apiTokens.grantId, clientId: oauthGrants.clientId })
        .from(apiTokens)
        .innerJoin(oauthGrants, eq(oauthGrants.id, apiTokens.grantId))
        .where(eq(apiTokens.hash, this.hash(kind, raw)));
      if (!row || row.clientId !== clientId || !row.grantId) return;
      if (kind === 'refresh') await revokeGrant(tx, row.grantId, 'revoked_by_client');
      else
        await tx.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, row.id));
    });
  }

  // ---- the user's view ----

  async listApps(userId: string): Promise<AuthorizedApp[]> {
    const rows = await this.db
      .select({
        clientId: oauthClients.id,
        name: oauthClients.name,
        redirectUris: oauthClients.redirectUris,
        scopes: oauthGrants.scopes,
        createdAt: oauthGrants.createdAt,
        lastUsedAt: oauthGrants.lastUsedAt,
      })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
      .orderBy(asc(oauthGrants.createdAt));
    const byClient = new Map<string, AuthorizedApp>();
    for (const r of rows) {
      const app = byClient.get(r.clientId) ?? {
        clientId: r.clientId,
        name: r.name,
        redirectHosts: [...new Set(r.redirectUris.map(redirectHost))],
        scopes: [],
        firstAuthorizedAt: r.createdAt.toISOString(),
        lastUsedAt: null,
      };
      app.scopes = [...new Set([...app.scopes, ...(r.scopes as ApiScope[])])];
      const last = r.lastUsedAt?.toISOString() ?? null;
      if (last && (!app.lastUsedAt || last > app.lastUsedAt)) app.lastUsedAt = last;
      byClient.set(r.clientId, app);
    }
    return [...byClient.values()];
  }

  /** The user withdraws an app: every grant (and so every token) it holds for them. */
  async revokeApp(userId: string, clientId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const grants = await tx
        .select({ id: oauthGrants.id })
        .from(oauthGrants)
        .where(
          and(
            eq(oauthGrants.userId, userId),
            eq(oauthGrants.clientId, clientId),
            isNull(oauthGrants.revokedAt),
          ),
        );
      for (const g of grants) await revokeGrant(tx, g.id, 'revoked_by_user');
      return grants.length > 0;
    });
  }

  /**
   * Account-level reset (password change or reset, admin disabling or resetting MFA): every
   * personal access token and app authorization of the user stops working.
   */
  async revokeAllForUser(userId: string): Promise<void> {
    await revokeApiAccess(this.db, userId);
  }

  /** Housekeeping: drop tokens that can never be used again. */
  async purge(now = new Date()): Promise<void> {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    await this.db
      .delete(apiTokens)
      .where(
        and(
          inArray(apiTokens.kind, ['access', 'refresh']),
          or(
            lt(apiTokens.expiresAt, weekAgo),
            lt(apiTokens.revokedAt, weekAgo),
            lt(apiTokens.usedAt, weekAgo),
          ),
        ),
      );
  }
}

const activePats = (userId: string) =>
  and(
    eq(apiTokens.userId, userId),
    eq(apiTokens.kind, 'pat'),
    isNull(apiTokens.revokedAt),
    or(isNull(apiTokens.expiresAt), sql`${apiTokens.expiresAt} > now()`),
  );

/** Every personal access token and app authorization of a user (usable inside a transaction). */
export async function revokeApiAccess(db: Pick<Database, 'update'>, userId: string): Promise<void> {
  const now = new Date();
  await db
    .update(oauthGrants)
    .set({ revokedAt: now, revokedReason: 'account_reset' })
    .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)));
  await db
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
}

export async function revokeGrant(tx: Tx, grantId: string, reason: string): Promise<void> {
  const now = new Date();
  await tx
    .update(oauthGrants)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)));
  await tx
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(and(eq(apiTokens.grantId, grantId), isNull(apiTokens.revokedAt)));
}

export function redirectHost(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : url.protocol;
  } catch {
    return '?';
  }
}

function toPat(row: typeof apiTokens.$inferSelect): PersonalAccessToken {
  return {
    id: row.id,
    name: row.name ?? '',
    scopes: row.scopes as ApiScope[],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}
