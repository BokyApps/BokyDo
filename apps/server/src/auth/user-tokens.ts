import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { userTokens } from '../db/schema.js';
import { newToken, tokenId } from './tokens.js';

export type UserTokenKind = (typeof userTokens.$inferSelect)['kind'];
export type UserTokenRow = typeof userTokens.$inferSelect;
type Db = Pick<Database, 'select' | 'insert' | 'update'>;

/** Single-use tokens sent by email or link (password reset, email verification, invitations). */
export class UserTokenStore {
  constructor(
    private readonly db: Database,
    private readonly key: Buffer,
  ) {}

  private id(kind: UserTokenKind, token: string) {
    return tokenId(this.key, `user-token:${kind}`, token);
  }

  async create(input: {
    kind: UserTokenKind;
    userId?: string | null;
    email?: string | null;
    data?: Record<string, unknown>;
    createdById?: string | null;
    ttlMs: number;
  }): Promise<{ token: string; ref: string }> {
    const token = newToken();
    if (input.userId && input.kind !== 'invite') {
      // Only the newest reset/verification link for a user stays valid.
      await this.invalidate(input.kind, input.userId);
    }
    const [row] = await this.db
      .insert(userTokens)
      .values({
        id: this.id(input.kind, token),
        kind: input.kind,
        userId: input.userId ?? null,
        email: input.email ?? null,
        data: input.data ?? {},
        createdById: input.createdById ?? null,
        expiresAt: new Date(Date.now() + input.ttlMs),
      })
      .returning({ ref: userTokens.ref });
    if (!row) throw new Error('user token insert returned no row');
    return { token, ref: row.ref };
  }

  /** A valid (unused, unexpired) token, without consuming it. */
  async peek(kind: UserTokenKind, token: string, db: Db = this.db): Promise<UserTokenRow | null> {
    const [row] = await db
      .select()
      .from(userTokens)
      .where(
        and(
          eq(userTokens.id, this.id(kind, token)),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      );
    return row ?? null;
  }

  /** Atomically mark a token used; only one concurrent caller can succeed. */
  async consume(
    kind: UserTokenKind,
    token: string,
    db: Db = this.db,
  ): Promise<UserTokenRow | null> {
    const [row] = await db
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(userTokens.id, this.id(kind, token)),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      )
      .returning();
    return row ?? null;
  }

  async invalidate(kind: UserTokenKind, userId: string, db: Db = this.db): Promise<void> {
    await db
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(
        and(eq(userTokens.kind, kind), eq(userTokens.userId, userId), isNull(userTokens.usedAt)),
      );
  }

  async listInvites(): Promise<UserTokenRow[]> {
    return this.db
      .select()
      .from(userTokens)
      .where(
        and(
          eq(userTokens.kind, 'invite'),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      );
  }

  async revokeInvite(ref: string): Promise<boolean> {
    const rows = await this.db
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(userTokens.ref, ref), eq(userTokens.kind, 'invite'), isNull(userTokens.usedAt)))
      .returning({ ref: userTokens.ref });
    return rows.length === 1;
  }
}
