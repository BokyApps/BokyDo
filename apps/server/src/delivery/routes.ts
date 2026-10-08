import { resolvePreferences } from '@bokydo/shared';
import { and, asc, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { pushSubscriptions, users } from '../db/schema.js';
import { requireUser } from '../http/access.js';
import type { SyncService } from '../sync/sync-service.js';
import type { Delivery } from './delivery.js';
import { readUnsubscribeToken } from './unsubscribe.js';
import { encryptPayload, type VapidKeys } from './webpush.js';

const MAX_SUBSCRIPTIONS_PER_USER = 20;

const b64u = z.string().regex(/^[A-Za-z0-9_-]+$/);
const subscriptionSchema = z
  .object({
    endpoint: z.string().max(1024),
    keys: z.object({ p256dh: b64u.max(100), auth: b64u.max(40) }).strip(),
    // Browsers include this in PushSubscription.toJSON(); it isn't used.
    expirationTime: z.number().nullable().optional(),
  })
  .strict();
const endpointSchema = z.object({ endpoint: z.string().max(1024) }).strict();
const unsubscribeSchema = z.object({ token: z.string().max(200) }).strict();

export interface DeliveryRouteDeps {
  db: Database;
  sync: SyncService;
  delivery: Delivery;
  vapid: VapidKeys;
  sessionKey: Buffer;
}

export function registerDeliveryRoutes(app: FastifyInstance, deps: DeliveryRouteDeps): void {
  // The Android app registers for UnifiedPush with its own (sync-scoped) token.
  const userOrApp = { config: { access: 'user', scopes: ['sync'] } } as const;
  const tests = new RateLimiter({
    windowMs: 3600_000,
    maxPerWindow: 10,
    freeFailures: 0,
    maxBackoffMs: 0,
  });

  app.get('/api/v1/push/key', userOrApp, async () => ({ publicKey: deps.vapid.publicKey }));

  /**
   * Register this browser (or app) for push. The subscription belongs to the current session, or
   * for the app to its OAuth grant, and ends with it. An endpoint registered before (by anyone,
   * e.g. on a shared computer) is taken over, so it only ever reaches the person signed in now.
   * Personal access tokens can't register: nothing would end the subscription with the device.
   */
  app.post('/api/v1/push/subscriptions', userOrApp, async (req, reply) => {
    const body = subscriptionSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'validation_failed' });
    const { endpoint, keys } = body.data;
    if (!deps.delivery.acceptsPushEndpoint(endpoint))
      return reply.status(400).send({ error: 'unsupported_push_service' });
    try {
      encryptPayload(Buffer.from('{}'), keys); // proves the keys are usable
    } catch {
      return reply.status(400).send({ error: 'validation_failed' });
    }
    const me = requireUser(req);
    const owner = req.session
      ? { sessionId: req.session.id }
      : req.token?.grantId
        ? { grantId: req.token.grantId }
        : null;
    if (!owner) return reply.status(403).send({ error: 'forbidden', message: 'push_needs_app' });
    await deps.db.transaction(async (tx) => {
      await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
      await tx.insert(pushSubscriptions).values({
        id: newId(),
        userId: me.id,
        ...owner,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: (req.headers['user-agent'] ?? '').slice(0, 200) || null,
      });
      const [n] = await tx
        .select({ n: count() })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, me.id));
      if ((n?.n ?? 0) > MAX_SUBSCRIPTIONS_PER_USER) {
        const [oldest] = await tx
          .select({ id: pushSubscriptions.id })
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.userId, me.id))
          .orderBy(asc(pushSubscriptions.createdAt))
          .limit(1);
        if (oldest) await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.id, oldest.id));
      }
    });
    return reply.status(201).send({ ok: true });
  });

  app.delete('/api/v1/push/subscriptions', userOrApp, async (req, reply) => {
    const body = endpointSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'validation_failed' });
    await deps.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, body.data.endpoint),
          eq(pushSubscriptions.userId, requireUser(req).id),
        ),
      );
    return reply.status(204).send();
  });

  app.post('/api/v1/push/test', userOrApp, async (req, reply) => {
    const me = requireUser(req);
    if (!tests.attempt(me.id).allowed) return reply.status(429).send({ error: 'rate_limited' });
    const sent = await deps.delivery.push(me.id, {
      title: 'Notifications are working',
      body: 'This is how BokyDo will let you know about reminders and more.',
      url: '/settings/notifications',
      tag: 'test',
    });
    return { sent };
  });

  /** Turn off one kind of email from a signed link (opened from the email, confirmed in the app). */
  app.post(
    '/api/v1/notifications/unsubscribe',
    { config: { access: 'public' } },
    async (req, reply) => {
      const body = unsubscribeSchema.safeParse(req.body);
      const parsed = body.success ? readUnsubscribeToken(deps.sessionKey, body.data.token) : null;
      if (!parsed) return reply.status(400).send({ error: 'invalid_token' });
      const { userId, topic } = parsed;
      const found = await deps.sync.write(async (tx, changes) => {
        const [row] = await tx
          .select({ preferences: users.preferences })
          .from(users)
          .where(eq(users.id, userId));
        if (!row) return false;
        const prefs = resolvePreferences(row.preferences);
        const n = prefs.notifications;
        const next =
          topic === 'digest'
            ? { ...n, digest: { ...n.digest, enabled: false } }
            : topic === 'report'
              ? { ...n, report: { ...n.report, enabled: false } }
              : {
                  ...n,
                  channels: { ...n.channels, [topic]: { ...n.channels[topic], email: false } },
                };
        await tx
          .update(users)
          .set({ preferences: { ...prefs, notifications: next }, updatedAt: new Date() })
          .where(eq(users.id, userId));
        changes.forUser('user', userId, userId);
        return true;
      });
      if (!found) return reply.status(400).send({ error: 'invalid_token' });
      return { topic };
    },
  );
}
