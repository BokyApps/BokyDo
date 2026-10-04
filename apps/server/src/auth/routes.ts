import { changePasswordRequestSchema, loginRequestSchema, type SessionInfo } from '@bokydo/shared';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { clearSessionCookies, setSessionCookie, requireSession } from '../http/access.js';
import { clientMeta, parseBody } from '../http/validation.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { EventBus } from '../sync/events.js';
import { checkPassword } from './password-policy.js';
import { RateLimiter } from './rate-limiter.js';
import type { SessionContext, SessionStore } from './sessions.js';

export interface AuthDeps {
  db: Database;
  settings: SettingsService;
  sessions: SessionStore;
  events: EventBus;
}

const sessionInfo = (s: SessionContext): SessionInfo => ({ user: s.user, csrfToken: s.csrfToken });

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { db, settings, sessions, events } = deps;
  // Verifying against a real hash when the user doesn't exist keeps response timing uniform.
  const dummyHash = await hashPassword(randomBytes(32).toString('base64url'));
  const perIp = new RateLimiter({
    windowMs: 15 * 60_000,
    maxPerWindow: 30,
    freeFailures: Number.POSITIVE_INFINITY,
    maxBackoffMs: 0,
  });
  const perAccount = new RateLimiter({
    windowMs: 15 * 60_000,
    maxPerWindow: Number.POSITIVE_INFINITY,
    freeFailures: 5,
    maxBackoffMs: 15 * 60_000,
  });
  const always = { setup: 'always' } as const;

  app.post(
    '/api/v1/auth/login',
    { config: { access: 'public', ...always } },
    async (req, reply) => {
      const body = parseBody(loginRequestSchema, req.body, reply);
      if (!body) return;
      const accountKey = `login:${body.username.toLowerCase()}`;
      for (const check of [perIp.attempt(`ip:${req.ip}`), perAccount.attempt(accountKey)]) {
        if (!check.allowed) {
          reply.header('Retry-After', String(check.retryAfterSeconds));
          return reply.status(429).send({ error: 'too_many_requests' });
        }
      }

      const [user] = await db
        .select()
        .from(users)
        .where(eq(sql`lower(${users.username})`, body.username.toLowerCase()));
      const ok = await verifyPassword(user?.passwordHash ?? dummyHash, body.password);
      if (!user || !ok || user.disabledAt) {
        perAccount.failure(accountKey);
        await audit(db, {
          action: 'auth.login_failed',
          actorType: 'user',
          actorUserId: user?.id ?? null,
          ip: req.ip,
          meta: { username: body.username.slice(0, 64) },
        });
        return reply.status(401).send({ error: 'invalid_credentials' });
      }

      perAccount.success(accountKey);
      const { token, session } = await sessions.create(
        {
          id: user.id,
          username: user.username,
          isAdmin: user.isAdmin,
          mustChangePassword: user.mustChangePassword,
        },
        clientMeta(req),
      );
      await audit(db, {
        action: 'auth.login',
        actorType: 'user',
        actorUserId: user.id,
        ip: req.ip,
      });
      setSessionCookie(req, reply, settings, token, session.expiresAt);
      return sessionInfo(session);
    },
  );

  app.post(
    '/api/v1/auth/logout',
    { config: { access: 'restricted', ...always } },
    async (req, reply) => {
      const session = requireSession(req);
      await sessions.revoke(session.id);
      events.closeSession(session.id);
      await audit(db, {
        action: 'auth.logout',
        actorType: 'user',
        actorUserId: session.user.id,
        ip: req.ip,
      });
      clearSessionCookies(reply);
      return reply.status(204).send();
    },
  );

  app.get('/api/v1/auth/session', { config: { access: 'restricted', ...always } }, async (req) =>
    sessionInfo(requireSession(req)),
  );

  app.post(
    '/api/v1/auth/password',
    { config: { access: 'restricted', ...always } },
    async (req, reply) => {
      const body = parseBody(changePasswordRequestSchema, req.body, reply);
      if (!body) return;
      const current = requireSession(req);
      const key = `password:${current.user.id}`;
      const check = perAccount.attempt(key);
      if (!check.allowed) {
        reply.header('Retry-After', String(check.retryAfterSeconds));
        return reply.status(429).send({ error: 'too_many_requests' });
      }

      const [user] = await db.select().from(users).where(eq(users.id, current.user.id));
      if (!user || !(await verifyPassword(user.passwordHash, body.currentPassword))) {
        perAccount.failure(key);
        return reply.status(403).send({ error: 'invalid_credentials' });
      }
      perAccount.success(key);

      const problem = checkPassword(body.newPassword, {
        minLength: settings.get('security.passwordMinLength'),
        username: user.username,
        currentPassword: body.currentPassword,
      });
      if (problem) return reply.status(400).send({ error: 'weak_password', message: problem });

      await db
        .update(users)
        .set({
          passwordHash: await hashPassword(body.newPassword),
          mustChangePassword: false,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      // Every existing session (including this one) is replaced by a fresh one.
      await sessions.revokeAllForUser(user.id);
      events.closeUser(user.id);
      const { token, session } = await sessions.create(
        { id: user.id, username: user.username, isAdmin: user.isAdmin, mustChangePassword: false },
        clientMeta(req),
      );
      await audit(db, {
        action: 'auth.password_changed',
        actorType: 'user',
        actorUserId: user.id,
        ip: req.ip,
      });
      setSessionCookie(req, reply, settings, token, session.expiresAt);
      return sessionInfo(session);
    },
  );
}
