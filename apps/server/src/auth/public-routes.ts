import {
  emailVerifySchema,
  inviteInspectSchema,
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  registerRequestSchema,
  type InviteInfo,
} from '@bokydo/shared';
import { and, eq, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { audit } from '../audit.js';
import { newId } from '../db/ids.js';
import { sessions as sessionsTable, users } from '../db/schema.js';
import { clientMeta, parseBody } from '../http/validation.js';
import { hashPassword } from '../security/password.js';
import { pgCode } from '../sync/handlers/common.js';
import type { AuthDeps } from './deps.js';
import { issueSession } from './issue-session.js';
import { validateNewPassword } from './password-check.js';
import { RateLimiter } from './rate-limiter.js';

const RESET_TTL_MS = 30 * 60_000;
const VERIFY_TTL_MS = 24 * 60 * 60_000;

/** Account recovery and self-service registration. Anonymous, so heavily rate-limited. */
export function registerPublicAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, settings, tokens, notifier, events } = deps;
  const window = (ms: number, max: number) =>
    new RateLimiter({ windowMs: ms, maxPerWindow: max, freeFailures: Infinity, maxBackoffMs: 0 });
  const resetPerIp = window(15 * 60_000, 10);
  const resetPerLogin = window(60 * 60_000, 3);
  const registerPerIp = window(60 * 60_000, 5);
  const tokenPerIp = window(15 * 60_000, 30);

  const tooMany = (reply: FastifyReply) => reply.status(429).send({ error: 'too_many_requests' });

  /**
   * Always answers 202, whether or not the account exists, has a verified email, or email is set
   * up (no account enumeration). Mail is sent in the background so timing doesn't leak either.
   */
  app.post('/api/v1/auth/password-reset', { config: { access: 'public' } }, async (req, reply) => {
    const body = parseBody(passwordResetRequestSchema, req.body, reply);
    if (!body) return;
    if (!resetPerIp.attempt(req.ip).allowed) return tooMany(reply);
    const login = body.login.toLowerCase();
    if (resetPerLogin.attempt(login).allowed && notifier.canEmail) {
      const [user] = await db
        .select()
        .from(users)
        .where(or(eq(sql`lower(${users.username})`, login), eq(sql`lower(${users.email})`, login)))
        .limit(1);
      // Only to a *verified* address: an unverified one could be a typo belonging to someone else.
      if (user?.email && user.emailVerifiedAt && !user.disabledAt) {
        const { token } = await tokens.create({
          kind: 'password_reset',
          userId: user.id,
          email: user.email,
          ttlMs: RESET_TTL_MS,
        });
        await audit(db, {
          action: 'auth.password_reset_requested',
          actorType: 'user',
          actorUserId: user.id,
          ip: req.ip,
        });
        void notifier
          .sendLink(user.email, 'password_reset', notifier.link('/reset-password', token))
          .catch((err: unknown) => req.log.warn({ err }, 'reset email failed'));
      }
    }
    return reply.status(202).send({ ok: true });
  });

  app.post(
    '/api/v1/auth/password-reset/complete',
    { config: { access: 'public' } },
    async (req, reply) => {
      const body = parseBody(passwordResetCompleteSchema, req.body, reply);
      if (!body) return;
      if (!tokenPerIp.attempt(req.ip).allowed) return tooMany(reply);
      const pending = await tokens.peek('password_reset', body.token);
      const [user] = pending?.userId
        ? await db.select().from(users).where(eq(users.id, pending.userId))
        : [];
      if (!pending || !user || user.disabledAt)
        return reply.status(400).send({ error: 'invalid_token' });

      const problem = await validateNewPassword(
        settings,
        { password: body.newPassword, username: user.username },
        deps.fetchImpl,
      );
      if (problem) return reply.status(400).send({ error: 'weak_password', message: problem });

      const passwordHash = await hashPassword(body.newPassword);
      const ok = await db.transaction(async (tx) => {
        if (!(await tokens.consume('password_reset', body.token, tx))) return false;
        await tx
          .update(users)
          .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
          .where(eq(users.id, user.id));
        // A reset signs out everywhere. Two-factor stays on: a reset link alone never bypasses it.
        await tx.delete(sessionsTable).where(eq(sessionsTable.userId, user.id));
        await audit(tx, {
          action: 'auth.password_reset',
          actorType: 'user',
          actorUserId: user.id,
          ip: req.ip,
        });
        return true;
      });
      if (!ok) return reply.status(400).send({ error: 'invalid_token' });
      events.closeUser(user.id);
      notifier.security(user.id, 'password_changed', clientMeta(req));
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/v1/auth/email/verify',
    { config: { access: 'public', setup: 'always' } },
    async (req, reply) => {
      const body = parseBody(emailVerifySchema, req.body, reply);
      if (!body) return;
      if (!tokenPerIp.attempt(req.ip).allowed) return tooMany(reply);
      const used = await tokens.consume('email_verify', body.token);
      if (!used?.userId || !used.email) return reply.status(400).send({ error: 'invalid_token' });
      // Only verifies the address the token was issued for, and only if it's still the user's address.
      const updated = await db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(
          and(eq(users.id, used.userId), eq(sql`lower(${users.email})`, used.email.toLowerCase())),
        )
        .returning({ id: users.id });
      if (updated.length === 0) return reply.status(400).send({ error: 'invalid_token' });
      await audit(db, {
        action: 'user.email_verified',
        actorType: 'user',
        actorUserId: used.userId,
        ip: req.ip,
      });
      return reply.status(204).send();
    },
  );

  app.post('/api/v1/auth/invite', { config: { access: 'public' } }, async (req, reply) => {
    const body = parseBody(inviteInspectSchema, req.body, reply);
    if (!body) return;
    if (!tokenPerIp.attempt(req.ip).allowed) return tooMany(reply);
    const invite = await tokens.peek('invite', body.token);
    return { valid: Boolean(invite), email: invite?.email ?? null } satisfies InviteInfo;
  });

  app.post('/api/v1/auth/register', { config: { access: 'public' } }, async (req, reply) => {
    const body = parseBody(registerRequestSchema, req.body, reply);
    if (!body) return;
    const mode = settings.get('access.registrationMode');
    if (mode === 'closed' || (mode === 'invite' && !body.inviteToken)) {
      return reply.status(403).send({ error: 'registration_closed' });
    }
    if (!registerPerIp.attempt(req.ip).allowed) return tooMany(reply);
    const invite = body.inviteToken ? await tokens.peek('invite', body.inviteToken) : null;
    if (body.inviteToken && !invite) return reply.status(400).send({ error: 'invalid_token' });

    const problem = await validateNewPassword(
      settings,
      { password: body.password, username: body.username },
      deps.fetchImpl,
    );
    if (problem) return reply.status(400).send({ error: 'weak_password', message: problem });

    // An emailed invite proves the address; otherwise the address must be verified separately.
    const email = invite?.email ?? body.email ?? null;
    const emailVerified = Boolean(invite?.email && (invite.data as { emailed?: boolean }).emailed);
    const isAdmin = Boolean((invite?.data as { isAdmin?: boolean } | undefined)?.isAdmin);
    const id = newId();
    const passwordHash = await hashPassword(body.password);
    let created: boolean;
    try {
      created = await db.transaction(async (tx) => {
        if (body.inviteToken && !(await tokens.consume('invite', body.inviteToken, tx)))
          return false;
        await tx.insert(users).values({
          id,
          username: body.username,
          email,
          emailVerifiedAt: emailVerified ? new Date() : null,
          passwordHash,
          isAdmin,
        });
        await audit(tx, {
          action: 'user.registered',
          actorType: 'user',
          actorUserId: id,
          ip: req.ip,
          meta: { via: invite ? 'invite' : 'open', inviteRef: invite?.ref ?? null, isAdmin },
        });
        return true;
      });
    } catch (err) {
      if (pgCode(err) === '23505')
        return reply.status(409).send({ error: 'conflict', message: 'username_or_email_taken' });
      throw err;
    }
    if (!created) return reply.status(400).send({ error: 'invalid_token' });

    if (email && !emailVerified && notifier.canEmail) {
      const { token } = await tokens.create({
        kind: 'email_verify',
        userId: id,
        email,
        ttlMs: VERIFY_TTL_MS,
      });
      void notifier
        .sendLink(email, 'email_verify', notifier.link('/verify-email', token))
        .catch(() => undefined);
    }
    return issueSession(
      deps,
      req,
      reply,
      { id, username: body.username, isAdmin, mustChangePassword: false },
      'registration',
    );
  });
}
