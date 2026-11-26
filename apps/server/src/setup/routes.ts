import {
  initialAdminRequestSchema,
  setPublicUrlRequestSchema,
  type SetupStatus,
} from '@bokydo/shared';
import { count } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { newId } from '../db/ids.js';
import { instanceSettings, users } from '../db/schema.js';
import { hashPassword } from '../security/password.js';
import type { AuthDeps } from '../auth/deps.js';
import { issueSession } from '../auth/issue-session.js';
import { validateNewPassword } from '../auth/password-check.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { insecurePublicUrl, requireSession } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import { INITIAL_ADMIN_LOCK, SETUP_COMPLETE_KEY } from './instance-settings.js';

/** First-run wizard plus the one-time public claim for a fresh instance. */
export function registerSetupRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { settings, db } = deps;
  const signupPerIp = new RateLimiter({
    windowMs: 10 * 60_000,
    maxPerWindow: 10,
    freeFailures: Infinity,
    maxBackoffMs: 0,
  });
  const config = { access: 'admin', setup: 'before' } as const;

  const status = (): SetupStatus => {
    const publicUrl = settings.get('instance.publicUrl');
    return {
      // Reaching an `admin` route means the password has already been changed.
      passwordChanged: true,
      publicUrl,
      publicUrlWarning: insecurePublicUrl(publicUrl) ? 'insecure_http' : null,
      canComplete: publicUrl !== null,
    };
  };

  app.get('/api/v1/setup', { config }, async () => status());

  app.post(
    '/api/v1/setup/admin',
    { config: { access: 'public', setup: 'always' } },
    async (req, reply) => {
      // Closed installs must not hash passwords or contact a password-check service. The
      // transaction checks again under the lock to resolve simultaneous first signups.
      if ((await db.select({ id: users.id }).from(users).limit(1)).length > 0)
        return reply.status(409).send({ error: 'conflict', message: 'initial_admin_claimed' });
      const limit = signupPerIp.attempt(req.ip);
      if (!limit.allowed) {
        reply.header('Retry-After', String(limit.retryAfterSeconds));
        return reply.status(429).send({ error: 'too_many_requests' });
      }
      const body = parseBody(initialAdminRequestSchema, req.body, reply);
      if (!body) return;
      const problem = await validateNewPassword(settings, body, deps.fetchImpl);
      if (problem) return reply.status(400).send({ error: 'weak_password', message: problem });
      const passwordHash = await hashPassword(body.password);
      const id = newId();
      let created: boolean;
      try {
        created = await db.transaction(async (tx) => {
          await tx.execute(INITIAL_ADMIN_LOCK);
          const [existing] = await tx.select({ n: count() }).from(users);
          if ((existing?.n ?? 0) > 0) return false;
          await tx.insert(users).values({
            id,
            username: body.username,
            passwordHash,
            isAdmin: true,
            mustChangePassword: false,
          });
          await tx
            .insert(instanceSettings)
            .values({ key: SETUP_COMPLETE_KEY, value: false })
            .onConflictDoNothing();
          await audit(tx, {
            actorType: 'user',
            actorUserId: id,
            action: 'user.initial_admin_created',
            targetType: 'user',
            targetId: id,
            ip: req.ip,
          });
          return true;
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          return reply.status(409).send({ error: 'conflict', message: 'initial_admin_claimed' });
        throw err;
      }
      if (!created)
        return reply.status(409).send({ error: 'conflict', message: 'initial_admin_claimed' });
      const session = await issueSession(
        deps,
        req,
        reply,
        { id, username: body.username, isAdmin: true, mustChangePassword: false },
        'registration',
      );
      return reply.status(201).send(session);
    },
  );

  app.put('/api/v1/setup/public-url', { config }, async (req, reply) => {
    const body = parseBody(setPublicUrlRequestSchema, req.body, reply);
    if (!body) return;
    await settings.update(
      { 'instance.publicUrl': body.publicUrl },
      { userId: requireSession(req).user.id, ip: req.ip },
    );
    return status();
  });

  app.post('/api/v1/setup/complete', { config }, async (req, reply) => {
    if (!status().canComplete)
      return reply.status(409).send({ error: 'conflict', message: 'public_url_required' });
    await settings.markSetupComplete({ userId: requireSession(req).user.id, ip: req.ip });
    return reply.status(204).send();
  });
}
