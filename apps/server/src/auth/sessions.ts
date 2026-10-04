import type { AuthMethod } from '@bokydo/shared';
import { createHmac, randomBytes } from 'node:crypto';
import { and, desc, eq, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import type { SettingsService } from '../settings/settings-service.js';
import { mfaRequiredFor } from './factors.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Avoid a DB write on every request: extend idle expiry at most once a minute. */
const TOUCH_INTERVAL_MS = 60 * 1000;
/** Sensitive account changes need a password/passkey check within this window ("sudo mode"). */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export interface SessionUserRow {
  id: string;
  username: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  mustEnrollMfa: boolean;
}

export interface SessionContext {
  id: string;
  publicId: string;
  csrfToken: string;
  authMethod: AuthMethod;
  expiresAt: Date;
  reauthenticatedAt: Date;
  user: SessionUserRow;
}

export interface NewSession {
  token: string;
  session: SessionContext;
}

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly sessionKey: Buffer,
    private readonly settings: SettingsService,
  ) {}

  private idFor(token: string): string {
    return createHmac('sha256', this.sessionKey).update(token).digest('base64url');
  }

  async create(
    user: Omit<SessionUserRow, 'mustEnrollMfa'>,
    meta: { ip: string | null; userAgent: string | null; authMethod: AuthMethod },
  ): Promise<NewSession> {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + this.settings.get('security.sessionMaxDays') * DAY_MS);
    const idleExpiresAt = new Date(
      Math.min(now + this.settings.get('security.sessionIdleDays') * DAY_MS, expiresAt.getTime()),
    );
    const id = this.idFor(token);
    await this.db.insert(sessions).values({
      id,
      userId: user.id,
      csrfToken,
      authMethod: meta.authMethod,
      idleExpiresAt,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
    });
    const session = await this.lookupById(id);
    if (!session) throw new Error('session vanished right after creation');
    return { token, session };
  }

  /** Resolve a cookie token to a live session, sliding the idle window. */
  async lookup(token: string): Promise<SessionContext | null> {
    if (token.length < 32 || token.length > 128) return null;
    return this.lookupById(this.idFor(token));
  }

  private async lookupById(id: string): Promise<SessionContext | null> {
    const [row] = await this.db
      .select({
        id: sessions.id,
        publicId: sessions.publicId,
        csrfToken: sessions.csrfToken,
        authMethod: sessions.authMethod,
        lastSeenAt: sessions.lastSeenAt,
        idleExpiresAt: sessions.idleExpiresAt,
        expiresAt: sessions.expiresAt,
        reauthenticatedAt: sessions.reauthenticatedAt,
        userId: users.id,
        username: users.username,
        isAdmin: users.isAdmin,
        mustChangePassword: users.mustChangePassword,
        totpEnabledAt: users.totpEnabledAt,
        // Fully qualified on purpose: drizzle may render unqualified column names inside sql``.
        hasPasskey: sql<boolean>`exists(select 1 from webauthn_credentials wc where wc.user_id = "users"."id")`,
        disabledAt: users.disabledAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id));
    if (!row) return null;
    const now = Date.now();
    if (row.disabledAt || row.expiresAt.getTime() <= now || row.idleExpiresAt.getTime() <= now) {
      await this.db.delete(sessions).where(eq(sessions.id, id));
      return null;
    }
    if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const idleExpiresAt = new Date(
        Math.min(
          now + this.settings.get('security.sessionIdleDays') * DAY_MS,
          row.expiresAt.getTime(),
        ),
      );
      await this.db
        .update(sessions)
        .set({ lastSeenAt: new Date(now), idleExpiresAt })
        .where(eq(sessions.id, id));
    }
    const hasFactor = Boolean(row.totpEnabledAt) || row.hasPasskey;
    return {
      id: row.id,
      publicId: row.publicId,
      csrfToken: row.csrfToken,
      authMethod: row.authMethod as AuthMethod,
      expiresAt: row.expiresAt,
      reauthenticatedAt: row.reauthenticatedAt,
      user: {
        id: row.userId,
        username: row.username,
        isAdmin: row.isAdmin,
        mustChangePassword: row.mustChangePassword,
        mustEnrollMfa: !hasFactor && mfaRequiredFor(this.settings, { isAdmin: row.isAdmin }),
      },
    };
  }

  async markReauthenticated(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ reauthenticatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }

  async list(userId: string) {
    return this.db
      .select({
        id: sessions.id,
        publicId: sessions.publicId,
        authMethod: sessions.authMethod,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.lastSeenAt));
  }

  /** Revoke one of the user's own sessions by its public ID; returns the internal ID if found. */
  async revokeByPublicId(userId: string, publicId: string): Promise<string | null> {
    const [row] = await this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.publicId, publicId)))
      .returning({ id: sessions.id });
    return row?.id ?? null;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  /** Revoke every session of a user, optionally keeping one. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    await this.db
      .delete(sessions)
      .where(
        exceptSessionId
          ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
          : eq(sessions.userId, userId),
      );
  }

  async purgeExpired(): Promise<void> {
    const now = new Date();
    await this.db
      .delete(sessions)
      .where(or(lt(sessions.expiresAt, now), lt(sessions.idleExpiresAt, now)));
  }
}
