import {
  apiScopeSchema,
  patCreateSchema,
  redirectKind,
  type ApiScope,
  type OAuthRequestInfo,
} from '@bokydo/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { newToken } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { oauthClients, oauthCodes, oauthGrants, oauthRequests } from '../db/schema.js';
import type { Notifier } from '../email/notifier.js';
import { requireRecentAuth, requireSession } from '../http/access.js';
import { clientMeta, parseBody } from '../http/validation.js';
import type { SettingsService } from '../settings/settings-service.js';
import { codeId, CODE_TTL_MS, issuer, requestHandleId, withParams } from './server.js';
import { PatLimitError, PatProjectError, redirectHost, type ApiTokenStore } from './token-store.js';

const handleSchema = z.object({ request: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const decisionSchema = z
  .object({
    request: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    approve: z.boolean(),
    /** Optionally grant fewer scopes than asked for. */
    scopes: z.array(apiScopeSchema).min(1).max(20).optional(),
  })
  .strict();
const idParams = z.object({ id: z.uuid() });
const clientParams = z.object({ clientId: z.string().regex(/^bkdc_[A-Za-z0-9_-]{22}$/) });

export interface OAuthRouteDeps {
  db: Database;
  settings: SettingsService;
  tokens: ApiTokenStore;
  notifier: Notifier;
  key: Buffer;
}

/**
 * Session-only routes (never reachable with a bearer token): the consent decision, personal
 * access tokens and the list of authorized apps. A token can't mint or widen other tokens.
 */
export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRouteDeps): void {
  const { db, settings, tokens, notifier, key } = deps;
  const user = { config: { access: 'user' } } as const;

  const pending = async (handle: string) => {
    const [row] = await db
      .select()
      .from(oauthRequests)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthRequests.clientId))
      .where(
        and(
          eq(oauthRequests.id, requestHandleId(key, handle)),
          gt(oauthRequests.expiresAt, new Date()),
        ),
      );
    return row ?? null;
  };

  /** What the consent screen shows. Only the redirect host is verified; the name isn't. */
  app.post('/api/v1/oauth/request', user, async (req, reply) => {
    const body = parseBody(handleSchema, req.body, reply);
    if (!body) return;
    const row = await pending(body.request);
    if (!row) return reply.status(404).send({ error: 'not_found' });
    const info: OAuthRequestInfo = {
      clientName: row.oauth_clients.name,
      redirectHost: redirectHost(row.oauth_requests.redirectUri),
      redirectKind: redirectKind(row.oauth_requests.redirectUri),
      scopes: row.oauth_requests.scopes as ApiScope[],
      audience: row.oauth_requests.audience,
      registeredAt: row.oauth_clients.createdAt.toISOString(),
      verified: row.oauth_clients.registeredVia === 'admin',
    };
    return info;
  });

  /**
   * Approve or deny. Either way the request is consumed and the browser is sent back to the
   * app's registered redirect URI (approval with a one-minute, single-use code).
   */
  app.post('/api/v1/oauth/request/decision', user, async (req, reply) => {
    const body = parseBody(decisionSchema, req.body, reply);
    if (!body) return;
    const iss = issuer(settings);
    if (!iss || !settings.get('api.enabled')) return reply.status(409).send({ error: 'conflict' });
    const session = requireSession(req);
    const outcome = await db.transaction(async (tx) => {
      const [request] = await tx
        .delete(oauthRequests)
        .where(eq(oauthRequests.id, requestHandleId(key, body.request)))
        .returning();
      if (!request || request.expiresAt.getTime() <= Date.now()) return null;
      const back = (params: Record<string, string>) =>
        withParams(request.redirectUri, {
          ...params,
          ...(request.state !== null ? { state: request.state } : {}),
          iss,
        });
      if (!body.approve) return { redirect: back({ error: 'access_denied' }), approved: false };

      const asked = request.scopes as ApiScope[];
      const scopes = body.scopes ? [...new Set(body.scopes)] : asked;
      if (scopes.some((s) => !asked.includes(s))) return 'invalid_scope' as const;
      const grantId = newId();
      await tx.insert(oauthGrants).values({
        id: grantId,
        clientId: request.clientId,
        userId: session.user.id,
        scopes,
        audience: request.audience,
      });
      const code = newToken();
      await tx.insert(oauthCodes).values({
        id: codeId(key, code),
        grantId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
      await tx
        .update(oauthClients)
        .set({ authorizedAt: new Date() })
        .where(and(eq(oauthClients.id, request.clientId), isNull(oauthClients.authorizedAt)));
      await audit(tx, {
        action: 'oauth.app_authorized',
        actorType: 'user',
        actorUserId: session.user.id,
        targetType: 'oauth_client',
        targetId: request.clientId,
        ip: req.ip,
        meta: { scopes, audience: request.audience },
      });
      return { redirect: back({ code }), approved: true };
    });
    if (outcome === null) return reply.status(404).send({ error: 'not_found' });
    if (outcome === 'invalid_scope')
      return reply.status(400).send({ error: 'validation_failed', message: 'invalid_scope' });
    if (outcome.approved) notifier.security(session.user.id, 'app_authorized', clientMeta(req));
    return { redirect: outcome.redirect };
  });

  // ---- authorized apps ----

  app.get('/api/v1/account/apps', user, async (req) => ({
    apps: await tokens.listApps(requireSession(req).user.id),
  }));

  app.delete('/api/v1/account/apps/:clientId', user, async (req, reply) => {
    const params = clientParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    const userId = requireSession(req).user.id;
    if (!(await tokens.revokeApp(userId, params.data.clientId)))
      return reply.status(404).send({ error: 'not_found' });
    await audit(db, {
      action: 'oauth.app_revoked',
      actorType: 'user',
      actorUserId: userId,
      targetType: 'oauth_client',
      targetId: params.data.clientId,
      ip: req.ip,
    });
    return reply.status(204).send();
  });

  // ---- personal access tokens ----

  app.get('/api/v1/account/tokens', user, async (req) => ({
    tokens: await tokens.listPats(requireSession(req).user.id),
  }));

  /** A long-lived credential: needs a recent password/passkey check, and the user is alerted. */
  app.post('/api/v1/account/tokens', user, async (req, reply) => {
    const body = parseBody(patCreateSchema, req.body, reply);
    if (!body) return;
    if (!settings.get('api.enabled'))
      return reply.status(409).send({ error: 'conflict', message: 'api_disabled' });
    if (!requireRecentAuth(req, reply)) return;
    const userId = requireSession(req).user.id;
    try {
      const created = await tokens.createPat(userId, body);
      await audit(db, {
        action: 'api.token_created',
        actorType: 'user',
        actorUserId: userId,
        targetType: 'api_token',
        targetId: created.pat.id,
        ip: req.ip,
        meta: {
          scopes: created.pat.scopes,
          projectIds: created.pat.projectIds,
          expiresAt: created.pat.expiresAt,
        },
      });
      notifier.security(userId, 'api_token_created', clientMeta(req));
      return reply.status(201).send(created);
    } catch (err) {
      if (err instanceof PatLimitError)
        return reply.status(409).send({ error: 'conflict', message: 'token_limit' });
      if (err instanceof PatProjectError)
        return reply.status(400).send({ error: 'validation_failed', message: 'unknown_project' });
      throw err;
    }
  });

  app.delete('/api/v1/account/tokens/:id', user, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    const userId = requireSession(req).user.id;
    if (!(await tokens.revokePat(userId, params.data.id)))
      return reply.status(404).send({ error: 'not_found' });
    await audit(db, {
      action: 'api.token_revoked',
      actorType: 'user',
      actorUserId: userId,
      targetType: 'api_token',
      targetId: params.data.id,
      ip: req.ip,
    });
    return reply.status(204).send();
  });
}
