import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { authFlows } from '../db/schema.js';
import { newToken, tokenId } from './tokens.js';

export type FlowKind = (typeof authFlows.$inferSelect)['kind'];
export type FlowRow = typeof authFlows.$inferSelect;

const FLOW_COOKIE = 'bokydo_flow';
export const MAX_FLOW_ATTEMPTS = 5;

/**
 * Short-lived multi-step authentication state. Pre-session flows (MFA after password, passkey
 * login) are found via an HttpOnly, SameSite=Strict cookie scoped to /api/v1/auth; flows inside a
 * session (enrolment) are bound to the session ID instead.
 */
export class FlowStore {
  constructor(
    private readonly db: Database,
    private readonly key: Buffer,
  ) {}

  async create(input: {
    kind: FlowKind;
    userId?: string | null;
    sessionId?: string | null;
    challenge?: string | null;
    secret?: unknown;
    ttlMs: number;
  }): Promise<{ token: string; row: FlowRow }> {
    const token = newToken();
    if (input.sessionId) {
      // One pending flow of each kind per session.
      await this.db
        .delete(authFlows)
        .where(and(eq(authFlows.sessionId, input.sessionId), eq(authFlows.kind, input.kind)));
    }
    const [row] = await this.db
      .insert(authFlows)
      .values({
        id: tokenId(this.key, `flow:${input.kind}`, token),
        kind: input.kind,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        challenge: input.challenge ?? null,
        secret: input.secret ?? null,
        expiresAt: new Date(Date.now() + input.ttlMs),
      })
      .returning();
    if (!row) throw new Error('auth flow insert returned no row');
    return { token, row };
  }

  async byToken(kind: FlowKind, token: string | undefined): Promise<FlowRow | null> {
    if (!token || token.length !== 43) return null;
    const [row] = await this.db
      .select()
      .from(authFlows)
      .where(
        and(
          eq(authFlows.id, tokenId(this.key, `flow:${kind}`, token)),
          gt(authFlows.expiresAt, new Date()),
        ),
      );
    return row ?? null;
  }

  async bySession(kind: FlowKind, sessionId: string): Promise<FlowRow | null> {
    const [row] = await this.db
      .select()
      .from(authFlows)
      .where(
        and(
          eq(authFlows.sessionId, sessionId),
          eq(authFlows.kind, kind),
          gt(authFlows.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(authFlows.createdAt))
      .limit(1);
    return row ?? null;
  }

  async setChallenge(id: string, challenge: string): Promise<void> {
    await this.db.update(authFlows).set({ challenge }).where(eq(authFlows.id, id));
  }

  /** Count an attempt; returns false (and burns the flow) once the limit is exceeded. */
  async attempt(row: FlowRow): Promise<boolean> {
    const [updated] = await this.db
      .update(authFlows)
      .set({ attempts: sql`${authFlows.attempts} + 1` })
      .where(eq(authFlows.id, row.id))
      .returning({ attempts: authFlows.attempts });
    if (!updated || updated.attempts > MAX_FLOW_ATTEMPTS) {
      await this.consume(row.id);
      return false;
    }
    return true;
  }

  /** Delete a flow; returns true only for the caller that actually removed it (single use). */
  async consume(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(authFlows)
      .where(eq(authFlows.id, id))
      .returning({ id: authFlows.id });
    return deleted.length === 1;
  }

  async purgeExpired(): Promise<void> {
    await this.db.delete(authFlows).where(lt(authFlows.expiresAt, new Date()));
  }

  static readCookie(req: FastifyRequest): string | undefined {
    return req.cookies[FLOW_COOKIE];
  }

  static setCookie(reply: FastifyReply, token: string, secure: boolean, ttlMs: number): void {
    reply.setCookie(FLOW_COOKIE, token, {
      path: '/api/v1/auth',
      httpOnly: true,
      sameSite: 'strict',
      secure,
      expires: new Date(Date.now() + ttlMs),
    });
  }

  static clearCookie(reply: FastifyReply): void {
    reply.clearCookie(FLOW_COOKIE, { path: '/api/v1/auth' });
  }
}
