import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AttachmentStore } from '../attachments/store.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Mailer } from '../email/mailer.js';
import { clearSessionCookies, requireRecentAuth, requireSession } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import type { ApiTokenStore } from '../oauth/token-store.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { EventBus } from '../sync/events.js';
import type { SyncService } from '../sync/sync-service.js';
import { deleteAccount, deletionBlockers } from './deletion.js';
import { buildExport } from './export.js';

export interface AccountDataDeps {
  db: Database;
  sync: SyncService;
  events: EventBus;
  settings: SettingsService;
  mailer: Mailer;
  store: AttachmentStore;
  tokens: ApiTokenStore;
}

const confirmSchema = z.object({ confirm: z.string().max(200) }).strict();
const idParams = z.object({ id: z.uuid() });

/** Export everything and delete the account (GDPR): the user's own, and the admin's view. */
export function registerAccountDataRoutes(app: FastifyInstance, deps: AccountDataDeps): void {
  const { db, sync, events, settings, mailer } = deps;
  const user = { config: { access: 'user' } } as const;
  const admin = { config: { access: 'admin' } } as const;
  const exports = new RateLimiter({
    windowMs: 3600_000,
    maxPerWindow: 5,
    freeFailures: Number.POSITIVE_INFINITY,
    maxBackoffMs: 0,
  });

  /** A full copy of the account's data: needs a recent password/passkey check, like other bulk actions. */
  app.get('/api/v1/account/export', user, async (req, reply) => {
    if (!requireRecentAuth(req, reply)) return;
    const userId = requireSession(req).user.id;
    if (!exports.attempt(userId).allowed)
      return reply.status(429).send({ error: 'too_many_requests' });
    const zip = buildExport({ ...deps, publicUrl: settings.get('instance.publicUrl') }, userId);
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="bokydo-export-${day}.zip"`)
      .header('cache-control', 'no-store')
      .send(zip.stream);
  });

  app.get('/api/v1/account/deletion', user, async (req) =>
    deletionBlockers(db, requireSession(req).user.id),
  );

  /** Delete my account: recent re-authentication plus typing the username. */
  app.post('/api/v1/account/delete', user, async (req, reply) => {
    const body = parseBody(confirmSchema, req.body, reply);
    if (!body) return;
    if (!requireRecentAuth(req, reply)) return;
    const session = requireSession(req);
    if (body.confirm !== session.user.username)
      return reply
        .status(400)
        .send({ error: 'validation_failed', message: 'confirmation_mismatch' });
    const result = await remove(req, session.user.id, session.user.id);
    if (!result.deleted)
      return reply.status(409).send({ error: 'conflict', blockers: result.blockers });
    clearSessionCookies(reply);
    return reply.status(204).send();
  });

  app.get('/api/v1/admin/users/:id/deletion', admin, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, params.data.id));
    if (!target) return reply.status(404).send({ error: 'not_found' });
    return deletionBlockers(db, target.id);
  });

  /** An admin deletes someone else's account (their own goes through Settings like anyone's). */
  app.post('/api/v1/admin/users/:id/delete', admin, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    const body = parseBody(confirmSchema, req.body, reply);
    if (!body) return;
    if (!requireRecentAuth(req, reply)) return;
    const me = requireSession(req).user.id;
    if (params.data.id === me)
      return reply
        .status(400)
        .send({ error: 'validation_failed', message: 'use_account_deletion' });
    const [target] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, params.data.id));
    if (!target) return reply.status(404).send({ error: 'not_found' });
    if (body.confirm !== target.username)
      return reply
        .status(400)
        .send({ error: 'validation_failed', message: 'confirmation_mismatch' });
    const result = await remove(req, target.id, me);
    if (!result.deleted)
      return reply.status(409).send({ error: 'conflict', blockers: result.blockers });
    return reply.status(204).send();
  });

  async function remove(req: FastifyRequest, userId: string, actorId: string) {
    const [person] = await db
      .select({ email: users.email, verified: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId));
    const result = await deleteAccount({ db, sync }, userId, { userId: actorId, ip: req.ip });
    if (!result.deleted) return result;
    events.closeUser(userId);
    // A last word to a verified address: deletion by someone else must not go unnoticed.
    if (person?.email && person.verified && mailer.isConfigured()) {
      void mailer
        .send({
          to: person.email,
          subject: `${settings.get('instance.name')}: your account was deleted`,
          text:
            (actorId === userId
              ? 'Your account was deleted as you asked.'
              : 'An administrator deleted your account.') +
            ' Your tasks, projects and settings are gone; tasks and comments in projects shared with others remain there without your name.\n',
        })
        .catch((err: unknown) => req.log.warn({ err }, 'deletion email failed'));
    }
    return result;
  }
}
