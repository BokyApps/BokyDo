import {
  AI_FEATURES,
  AI_PROVIDERS,
  aiCredentialCreateSchema,
  aiCredentialUpdateSchema,
  aiRoutingSchema,
  providerSupports,
  type AiFeature,
  type AiRouting,
} from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireSession } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import type { SettingsService } from '../settings/settings-service.js';
import {
  CredentialInputError,
  CredentialLimitError,
  type AiCredentialStore,
  type CredentialOwner,
} from './credentials.js';
import type { AiService } from './service.js';
import { instanceUsageByUser, userUsageSummary } from './usage.js';

export interface AiRouteDeps {
  db: Database;
  settings: SettingsService;
  credentials: AiCredentialStore;
  ai: AiService;
}

const idParams = z.object({ id: z.uuid() });

/**
 * AI credentials, routing and usage. Users manage only their own credentials; admins manage
 * instance credentials. No route lists or touches another user's credentials, admins included,
 * and no response ever contains a key or header value.
 */
export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const { db, settings, credentials, ai } = deps;
  const user = { config: { access: 'user' } } as const;
  const admin = { config: { access: 'admin' } } as const;
  // Each test makes an outbound request: keep them rare.
  const tests = new RateLimiter({
    windowMs: 60_000,
    maxPerWindow: 10,
    freeFailures: 0,
    maxBackoffMs: 0,
  });

  const actor = (req: FastifyRequest) => ({ userId: requireSession(req).user.id, ip: req.ip });
  const userKeysOff = (reply: FastifyReply) =>
    reply.status(403).send({ error: 'forbidden', message: 'user_keys_disabled' });

  /** Shared handlers for both scopes; `owner` comes from the route, never from the request. */
  const credentialRoutes = (
    prefix: string,
    opts: { config: { access: 'user' | 'admin' } },
    ownerOf: (req: FastifyRequest) => CredentialOwner,
    allowedToWrite: () => boolean,
    afterDelete: (req: FastifyRequest, id: string) => Promise<void>,
  ) => {
    app.get(prefix, opts, async (req) => ({ credentials: await credentials.list(ownerOf(req)) }));

    app.post(prefix, opts, async (req, reply) => {
      if (!allowedToWrite()) return userKeysOff(reply);
      const body = parseBody(aiCredentialCreateSchema, req.body, reply);
      if (!body) return;
      try {
        return reply.status(201).send(await credentials.create(ownerOf(req), body, actor(req)));
      } catch (err) {
        return credentialError(err, reply);
      }
    });

    app.patch(`${prefix}/:id`, opts, async (req, reply) => {
      if (!allowedToWrite()) return userKeysOff(reply);
      const params = idParams.safeParse(req.params);
      if (!params.success) return reply.status(404).send({ error: 'not_found' });
      const body = parseBody(aiCredentialUpdateSchema, req.body, reply);
      if (!body) return;
      try {
        const updated = await credentials.update(ownerOf(req), params.data.id, body, actor(req));
        return updated ?? reply.status(404).send({ error: 'not_found' });
      } catch (err) {
        return credentialError(err, reply);
      }
    });

    // Deleting stays possible when own keys are switched off, so people can remove them.
    app.delete(`${prefix}/:id`, opts, async (req, reply) => {
      const params = idParams.safeParse(req.params);
      if (!params.success) return reply.status(404).send({ error: 'not_found' });
      const deleted = await credentials.delete(ownerOf(req), params.data.id, actor(req));
      if (!deleted) return reply.status(404).send({ error: 'not_found' });
      await afterDelete(req, params.data.id);
      return reply.status(204).send();
    });

    app.post(`${prefix}/:id/test`, opts, async (req, reply) => {
      if (!allowedToWrite()) return userKeysOff(reply);
      const params = idParams.safeParse(req.params);
      if (!params.success) return reply.status(404).send({ error: 'not_found' });
      if (!tests.attempt(requireSession(req).user.id).allowed)
        return reply.status(429).send({ error: 'too_many_requests' });
      const result = await ai.test(ownerOf(req), params.data.id);
      return result ?? reply.status(404).send({ error: 'not_found' });
    });
  };

  credentialRoutes(
    '/api/v1/ai/credentials',
    user,
    (req) => requireSession(req).user.id,
    () => settings.get('ai.userKeys'),
    async (req, id) => {
      const userId = requireSession(req).user.id;
      const routing = await ai.userRouting(userId);
      await db
        .update(users)
        .set({ aiRouting: withoutCredential(routing, id) })
        .where(eq(users.id, userId));
    },
  );

  credentialRoutes(
    '/api/v1/admin/ai/credentials',
    admin,
    () => null,
    () => true,
    async (req, id) => {
      const routing = settings.get('ai.routing');
      const next = withoutCredential(routing, id);
      if (Object.keys(next).length !== Object.keys(routing).length)
        await settings.update({ 'ai.routing': next }, actor(req));
    },
  );

  /** Check every route points at a credential of `owner` that can serve the feature. */
  const routingIssues = async (owner: CredentialOwner, routing: AiRouting) => {
    const issues: { path: string; message: string }[] = [];
    for (const [feature, route] of Object.entries(routing)) {
      const provider = await credentials.owned(owner, route.credentialId);
      if (!provider) issues.push({ path: feature, message: 'Unknown credential' });
      else if (!providerSupports(provider, AI_FEATURES[feature as AiFeature]))
        issues.push({ path: feature, message: `${AI_PROVIDERS[provider].name} can't do this` });
    }
    return issues;
  };

  app.get('/api/v1/ai/catalog', user, async (req) => {
    const session = requireSession(req);
    const me = { id: session.user.id, isAdmin: session.user.isAdmin };
    return {
      providers: AI_PROVIDERS,
      features: AI_FEATURES,
      policy: { userKeys: settings.get('ai.userKeys'), instance: ai.mayUseInstance(me) },
      available: await ai.availableFeatures(me),
    };
  });

  app.get('/api/v1/ai/routing', user, async (req) => ({
    routing: await ai.userRouting(requireSession(req).user.id),
  }));

  app.put('/api/v1/ai/routing', user, async (req, reply) => {
    if (!settings.get('ai.userKeys')) return userKeysOff(reply);
    const routing = parseBody(aiRoutingSchema, req.body, reply);
    if (!routing) return;
    const userId = requireSession(req).user.id;
    const issues = await routingIssues(userId, routing);
    if (issues.length) return reply.status(400).send({ error: 'validation_failed', issues });
    await db.update(users).set({ aiRouting: routing }).where(eq(users.id, userId));
    return { routing };
  });

  app.put('/api/v1/admin/ai/routing', admin, async (req, reply) => {
    const routing = parseBody(aiRoutingSchema, req.body, reply);
    if (!routing) return;
    const issues = await routingIssues(null, routing);
    if (issues.length) return reply.status(400).send({ error: 'validation_failed', issues });
    await settings.update({ 'ai.routing': routing }, actor(req));
    return { routing: settings.get('ai.routing') };
  });

  app.get('/api/v1/ai/usage', user, async (req) =>
    userUsageSummary(db, requireSession(req).user.id, ai.budget()),
  );

  app.get('/api/v1/admin/ai/usage', admin, async () => ({
    budget: ai.budget(),
    users: await instanceUsageByUser(db),
  }));
}

function withoutCredential(routing: AiRouting, credentialId: string): AiRouting {
  return Object.fromEntries(
    Object.entries(routing).filter(([, route]) => route.credentialId !== credentialId),
  ) as AiRouting;
}

function credentialError(err: unknown, reply: FastifyReply) {
  if (err instanceof CredentialInputError)
    return reply.status(400).send({ error: 'validation_failed', issues: err.issues });
  if (err instanceof CredentialLimitError)
    return reply.status(409).send({ error: 'conflict', message: 'credential_limit' });
  throw err;
}
