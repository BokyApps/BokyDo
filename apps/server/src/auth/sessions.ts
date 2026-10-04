import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, lt, ne, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import type { SettingsService } from '../settings/settings-service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Avoid a DB write on every request: extend idle expiry at most once a minute. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionUserRow {
  id: string;
  username: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export interface SessionContext {
  id: string;
  csrfToken: string;
  expiresAt: Date;
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
    user: SessionUserRow,
    meta: { ip: string | null; userAgent: string | null },
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
      idleExpiresAt,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
    });
    return { token, session: { id, csrfToken, expiresAt, user } };
  }

  /** Resolve a cookie token to a live session, sliding the idle window. */
  async lookup(token: string): Promise<SessionContext | null> {
    if (token.length < 32 || token.length > 128) return null;
    const id = this.idFor(token);
    const [row] = await this.db
      .select({
        id: sessions.id,
        csrfToken: sessions.csrfToken,
        lastSeenAt: sessions.lastSeenAt,
        idleExpiresAt: sessions.idleExpiresAt,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        username: users.username,
        isAdmin: users.isAdmin,
        mustChangePassword: users.mustChangePassword,
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
    return {
      id: row.id,
      csrfToken: row.csrfToken,
      expiresAt: row.expiresAt,
      user: {
        id: row.userId,
        username: row.username,
        isAdmin: row.isAdmin,
        mustChangePassword: row.mustChangePassword,
      },
    };
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
