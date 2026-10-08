import {
  webhookCreateSchema,
  webhookUpdateSchema,
  type WebhookSubscriptionInfo,
} from '@bokydo/shared';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { webhookDeliveries, webhookSubscriptions } from '../db/schema.js';
import { requireRecentAuth, requireSession } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import type { SettingsService } from '../settings/settings-service.js';
import { MAX_SUBSCRIPTIONS_PER_USER, newWebhookSecret, type Webhooks } from './webhooks.js';

export interface WebhookRouteDeps {
  db: Database;
  settings: SettingsService;
  webhooks: Webhooks;
}

const idParams = z.object({ id: z.uuid() }).strict();
type Out = { status: number; body?: unknown };

/**
 * Managing webhook endpoints (Settings → Webhooks). Session-only like calendar feeds: this is a
 * user-settings surface, not the token-facing REST API. The signing secret is returned once, on
 * create and rotate — the database keeps only its ciphertext. Creating or rotating a webhook
 * needs recent re-authentication: a webhook is a standing data-export channel, like a token.
 */
export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  const { db, settings, webhooks } = deps;
  const user = { config: { access: 'user' } } as const;
  const tests = new RateLimiter({
    windowMs: 3_600_000,
    maxPerWindow: 10,
    freeFailures: 1_000_000,
    maxBackoffMs: 0,
  });
  // Creating, re-pointing and rotating are rare; a burst means a script or a stolen session.
  const changes = new RateLimiter({
    windowMs: 3_600_000,
    maxPerWindow: 30,
    freeFailures: 1_000_000,
    maxBackoffMs: 0,
  });
  const tooMany = (reply: FastifyReply, retryAfterSeconds: number) =>
    reply
      .header('retry-after', String(retryAfterSeconds))
      .status(429)
      .send({ error: 'rate_limited' });
  const send = (reply: FastifyReply, out: Out) =>
    out.body === undefined
      ? reply.status(out.status).send()
      : reply.status(out.status).send(out.body);

  app.get('/api/v1/webhooks', user, async (req) => {
    const me = requireSession(req).user;
    return db.transaction(async (tx) => {
      const subs = await tx
        .select()
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.userId, me.id))
        .orderBy(asc(webhookSubscriptions.createdAt));
      // The newest delivery per subscription, so the UI can show endpoint health at a glance.
      const latest = subs.length
        ? await tx
            .selectDistinctOn([webhookDeliveries.subscriptionId], {
              subscriptionId: webhookDeliveries.subscriptionId,
              status: webhookDeliveries.status,
              createdAt: webhookDeliveries.createdAt,
              lastError: webhookDeliveries.lastError,
            })
            .from(webhookDeliveries)
            .where(
              inArray(
                webhookDeliveries.subscriptionId,
                subs.map((s) => s.id),
              ),
            )
            .orderBy(webhookDeliveries.subscriptionId, desc(webhookDeliveries.createdAt))
        : [];
      const bySub = new Map(latest.map((l) => [l.subscriptionId, l]));
      const webhooksOut: WebhookSubscriptionInfo[] = subs.map((s) => {
        const l = bySub.get(s.id);
        return {
          id: s.id,
          url: s.url,
          events: s.events,
          createdAt: s.createdAt.toISOString(),
          lastDeliveryAt: l ? l.createdAt.toISOString() : null,
          lastDeliveryStatus: l
            ? (l.status as WebhookSubscriptionInfo['lastDeliveryStatus'])
            : null,
          lastError: l ? l.lastError : null,
        };
      });
      return { webhooks: webhooksOut };
    });
  });

  app.post('/api/v1/webhooks', user, async (req, reply) => {
    if (!settings.get('api.webhooksEnabled'))
      return reply.status(409).send({ error: 'webhooks_disabled' });
    if (!requireRecentAuth(req, reply)) return;
    const body = parseBody(webhookCreateSchema, req.body, reply);
    if (!body) return;
    const me = requireSession(req).user;
    const allowed = changes.attempt(me.id);
    if (!allowed.allowed) return tooMany(reply, allowed.retryAfterSeconds);
    const secret = newWebhookSecret();
    const id = newId();
    const out = await db.transaction(async (tx): Promise<Out> => {
      const [n] = await tx
        .select({ n: count() })
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.userId, me.id));
      if ((n?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_USER)
        return { status: 429, body: { error: 'limit_exceeded' } };
      await tx.insert(webhookSubscriptions).values({
        id,
        userId: me.id,
        url: body.url,
        secret: webhooks.sealSecret(id, me.id, secret),
        events: body.events,
      });
      await audit(tx, {
        action: 'webhook.created',
        actorType: 'user',
        actorUserId: me.id,
        targetType: 'webhook',
        targetId: id,
        ip: req.ip,
        // Never the URL: it can carry the receiver's own credentials.
        meta: { events: body.events },
      });
      return { status: 201, body: { id, secret } };
    });
    return send(reply, out);
  });

  app.patch('/api/v1/webhooks/:id', user, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const body = parseBody(webhookUpdateSchema, req.body, reply);
    if (!body) return;
    if (!settings.get('api.webhooksEnabled'))
      return reply.status(409).send({ error: 'webhooks_disabled' });
    // Pointing an existing webhook somewhere else is as sensitive as creating one: it redirects
    // a standing data-export channel. Changing only the events is not.
    if (body.url !== undefined && !requireRecentAuth(req, reply)) return;
    const me = requireSession(req).user;
    const allowed = changes.attempt(me.id);
    if (!allowed.allowed) return tooMany(reply, allowed.retryAfterSeconds);
    const out = await db.transaction(async (tx): Promise<Out> => {
      const [row] = await tx
        .update(webhookSubscriptions)
        .set({
          ...(body.url !== undefined ? { url: body.url } : {}),
          ...(body.events !== undefined ? { events: body.events } : {}),
        })
        .where(
          and(eq(webhookSubscriptions.id, params.data.id), eq(webhookSubscriptions.userId, me.id)),
        )
        .returning({ id: webhookSubscriptions.id });
      if (!row) return { status: 404, body: { error: 'not_found' } };
      await audit(tx, {
        action: 'webhook.updated',
        actorType: 'user',
        actorUserId: me.id,
        targetType: 'webhook',
        targetId: row.id,
        ip: req.ip,
        meta: {
          ...(body.url !== undefined ? { urlChanged: true } : {}),
          ...(body.events !== undefined ? { events: body.events } : {}),
        },
      });
      return { status: 204 };
    });
    return send(reply, out);
  });

  /** A new signing secret for the same endpoint; the old one stops working at once. */
  app.post('/api/v1/webhooks/:id/rotate', user, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    if (!requireRecentAuth(req, reply)) return;
    const me = requireSession(req).user;
    const allowed = changes.attempt(me.id);
    if (!allowed.allowed) return tooMany(reply, allowed.retryAfterSeconds);
    const secret = newWebhookSecret();
    const out = await db.transaction(async (tx): Promise<Out> => {
      const [row] = await tx
        .update(webhookSubscriptions)
        .set({ secret: webhooks.sealSecret(params.data.id, me.id, secret) })
        .where(
          and(eq(webhookSubscriptions.id, params.data.id), eq(webhookSubscriptions.userId, me.id)),
        )
        .returning({ id: webhookSubscriptions.id });
      if (!row) return { status: 404, body: { error: 'not_found' } };
      await audit(tx, {
        action: 'webhook.rotated',
        actorType: 'user',
        actorUserId: me.id,
        targetType: 'webhook',
        targetId: row.id,
        ip: req.ip,
      });
      return { status: 200, body: { id: row.id, secret } };
    });
    return send(reply, out);
  });

  /** Queue a signed `test` delivery so the endpoint's verification can be checked end to end. */
  app.post('/api/v1/webhooks/:id/test', user, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    if (!settings.get('api.webhooksEnabled'))
      return reply.status(409).send({ error: 'webhooks_disabled' });
    const me = requireSession(req).user;
    const attempt = tests.attempt(me.id);
    if (!attempt.allowed)
      return reply
        .header('retry-after', String(attempt.retryAfterSeconds))
        .status(429)
        .send({ error: 'rate_limited' });
    const deliveryId = await webhooks.createTestDelivery(me.id, params.data.id);
    if (!deliveryId) return reply.status(404).send({ error: 'not_found' });
    await db.transaction(async (tx) => {
      await audit(tx, {
        action: 'webhook.tested',
        actorType: 'user',
        actorUserId: me.id,
        targetType: 'webhook',
        targetId: params.data.id,
        ip: req.ip,
        meta: { deliveryId },
      });
    });
    return reply.status(202).send({ id: deliveryId });
  });

  app.delete('/api/v1/webhooks/:id', user, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    const out = await db.transaction(async (tx): Promise<Out> => {
      const [row] = await tx
        .delete(webhookSubscriptions)
        .where(
          and(eq(webhookSubscriptions.id, params.data.id), eq(webhookSubscriptions.userId, me.id)),
        )
        .returning({ id: webhookSubscriptions.id });
      if (!row) return { status: 404, body: { error: 'not_found' } };
      await audit(tx, {
        action: 'webhook.deleted',
        actorType: 'user',
        actorUserId: me.id,
        targetType: 'webhook',
        targetId: row.id,
        ip: req.ip,
      });
      return { status: 204 };
    });
    return send(reply, out);
  });
}
