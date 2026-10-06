import {
  API_SCOPE_KEYS,
  clientRegistrationSchema,
  DEFAULT_OAUTH_SCOPES,
  parseScopeString,
  redirectUriMatches,
  type ApiScope,
  type TokenAudience,
} from '@bokydo/shared';
import { and, count, eq, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { RateLimiter } from '../auth/rate-limiter.js';
import { newToken, safeEqual, tokenId } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { oauthClients, oauthCodes, oauthGrants, oauthRequests } from '../db/schema.js';
import type { SettingsService } from '../settings/settings-service.js';
import { revokeGrant, type ApiTokenStore } from './token-store.js';

export const REQUEST_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 60_000;
/** Dynamic clients nobody has authorized are dropped after this long. */
export const UNUSED_CLIENT_TTL_MS = 24 * 3600_000;
const MAX_PENDING_DYNAMIC_CLIENTS = 1000;

export interface OAuthDeps {
  db: Database;
  settings: SettingsService;
  tokens: ApiTokenStore;
  /** Keys the stored hashes of authorization codes and request handles. */
  key: Buffer;
}

export const requestHandleId = (key: Buffer, handle: string) =>
  tokenId(key, 'oauth:request', handle);
export const codeId = (key: Buffer, code: string) => tokenId(key, 'oauth:code', code);

/** The issuer and resource identifiers are the configured public URL; null until it is set. */
export function issuer(settings: SettingsService): string | null {
  return settings.get('instance.publicUrl');
}

/** RFC 8707 resource indicator → audience. Absent means the REST/sync API. */
export function audienceOf(base: string, resource: string | undefined): TokenAudience | null {
  if (resource === undefined) return 'api';
  const r = resource.replace(/\/$/, '');
  if (r === base || r === `${base}/api`) return 'api';
  if (r === `${base}/mcp`) return 'mcp';
  return null;
}

/**
 * The OAuth 2.1 authorization server: metadata (RFC 8414, RFC 9728), dynamic client registration
 * (RFC 7591), the authorization endpoint (code + PKCE S256 only), the token endpoint (code and
 * refresh-token grants, rotation with reuse detection) and revocation (RFC 7009). Consent itself
 * happens in the web app, behind the normal sign-in (MFA, passkeys), via `/api/v1/oauth/...`.
 * These routes live outside /api: they're for other programs and never read the session cookie.
 */
export function registerOAuthServer(app: FastifyInstance, deps: OAuthDeps): void {
  const { db, settings, tokens, key } = deps;
  const perIp = (maxPerWindow: number, windowMs = 60_000) =>
    new RateLimiter({
      windowMs,
      maxPerWindow,
      freeFailures: Number.POSITIVE_INFINITY,
      maxBackoffMs: 0,
    });
  const registrations = perIp(20, 3600_000);
  const authorizations = perIp(60);
  const tokenCalls = perIp(60);

  const available = () => settings.get('api.enabled') && issuer(settings) !== null;

  // ---- metadata ----

  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => {
    const iss = issuer(settings);
    if (!iss || !settings.get('api.enabled')) return reply.status(404).send({ error: 'not_found' });
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      revocation_endpoint: `${iss}/oauth/revoke`,
      ...(settings.get('api.dynamicClientRegistration')
        ? { registration_endpoint: `${iss}/oauth/register` }
        : {}),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: API_SCOPE_KEYS,
      authorization_response_iss_parameter_supported: true,
    };
  });

  const resourceMetadata =
    (path: '' | '/mcp') => async (_req: FastifyRequest, reply: FastifyReply) => {
      const iss = issuer(settings);
      if (!iss || !settings.get('api.enabled'))
        return reply.status(404).send({ error: 'not_found' });
      return {
        resource: `${iss}${path}`,
        authorization_servers: [iss],
        scopes_supported:
          path === '/mcp' ? API_SCOPE_KEYS.filter((s) => s !== 'sync') : API_SCOPE_KEYS,
        bearer_methods_supported: ['header'],
      };
    };
  app.get('/.well-known/oauth-protected-resource', resourceMetadata(''));
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata('/mcp'));

  // ---- dynamic client registration ----

  app.post('/oauth/register', async (req, reply) => {
    noStore(reply);
    if (!available() || !settings.get('api.dynamicClientRegistration'))
      return reply
        .status(403)
        .send({ error: 'access_denied', error_description: 'Registration is disabled' });
    if (!registrations.attempt(req.ip).allowed)
      return reply.status(429).send({ error: 'too_many_requests' });
    const parsed = clientRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      const badUri = parsed.error.issues.some((i) => i.path[0] === 'redirect_uris');
      return reply.status(400).send({
        error: badUri ? 'invalid_redirect_uri' : 'invalid_client_metadata',
        error_description: parsed.error.issues[0]?.message ?? 'Invalid request',
      });
    }
    const [{ pending }] = (await db
      .select({ pending: count() })
      .from(oauthClients)
      .where(
        and(eq(oauthClients.registeredVia, 'dynamic'), isNull(oauthClients.authorizedAt)),
      )) as [{ pending: number }];
    if (pending >= MAX_PENDING_DYNAMIC_CLIENTS)
      return reply.status(429).send({ error: 'too_many_requests' });
    const id = `bkdc_${randomBytes(16).toString('base64url')}`;
    const body = parsed.data;
    const [client] = await db
      .insert(oauthClients)
      .values({
        id,
        name: body.client_name ?? 'Unnamed app',
        redirectUris: [...new Set(body.redirect_uris)],
        registeredVia: 'dynamic',
        registeredIp: req.ip,
      })
      .returning();
    if (!client) throw new Error('insert returned nothing');
    return reply.status(201).send({
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // ---- authorization endpoint ----

  app.get('/oauth/authorize', async (req, reply) => {
    noStore(reply);
    const iss = issuer(settings);
    if (!iss || !settings.get('api.enabled'))
      return errorPage(reply, 'This server does not accept app sign-ins.');
    if (!authorizations.attempt(req.ip).allowed) return errorPage(reply, 'Too many requests.', 429);
    const q = singleParams(req.query);
    if (!q) return errorPage(reply, 'Invalid request: a parameter was repeated.');

    // Until the client and its redirect URI are verified, never redirect anywhere (open redirect).
    const [client] = q.client_id
      ? await db.select().from(oauthClients).where(eq(oauthClients.id, q.client_id))
      : [];
    if (!client) return errorPage(reply, 'Unknown app (client_id).');
    const redirectUri = q.redirect_uri;
    if (!redirectUri || !client.redirectUris.some((r) => redirectUriMatches(r, redirectUri)))
      return errorPage(reply, 'The redirect address is not registered for this app.');

    const fail = (error: string, description: string) =>
      reply.redirect(
        withParams(redirectUri, {
          error,
          error_description: description,
          ...(q.state !== undefined ? { state: q.state } : {}),
          iss,
        }),
      );
    if (q.response_type !== 'code')
      return fail('unsupported_response_type', 'Only code is supported');
    if (q.code_challenge_method !== 'S256')
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    if (!q.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge))
      return fail('invalid_request', 'Invalid code_challenge');
    if (q.state !== undefined && q.state.length > 500)
      return fail('invalid_request', 'state is too long');
    const audience = audienceOf(iss, q.resource);
    if (!audience) return fail('invalid_target', 'Unknown resource');
    let scopes: ApiScope[] | null =
      q.scope === undefined || q.scope.trim() === ''
        ? [...DEFAULT_OAUTH_SCOPES]
        : parseScopeString(q.scope);
    if (!scopes || scopes.length === 0) return fail('invalid_scope', 'Unknown scope');
    if (audience === 'mcp') scopes = scopes.filter((s) => s !== 'sync');
    if (scopes.length === 0) return fail('invalid_scope', 'No usable scope');

    const handle = newToken();
    await db.insert(oauthRequests).values({
      id: requestHandleId(key, handle),
      clientId: client.id,
      redirectUri,
      scopes,
      audience,
      state: q.state ?? null,
      codeChallenge: q.code_challenge,
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    });
    // The handle travels in the fragment: never sent to servers, proxies or Referer headers.
    return reply.redirect(`${iss}/oauth/consent#${handle}`);
  });

  // ---- token and revocation endpoints (form-encoded, per RFC 6749) ----

  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16 * 1024 },
      (_req, body, done) => {
        const params = new URLSearchParams(body as string);
        const out: Record<string, string> = {};
        for (const [k, v] of params) {
          // Parameters must not repeat (RFC 6749 §3.1).
          if (k in out) return done(null, { __duplicate: k });
          out[k] = v;
        }
        done(null, out);
      },
    );

    scope.post('/oauth/token', async (req, reply) => {
      noStore(reply);
      const err = (error: string, description?: string, status = 400) =>
        reply
          .status(status)
          .send({ error, ...(description ? { error_description: description } : {}) });
      if (!available()) return err('invalid_request', 'API access is disabled');
      if (!tokenCalls.attempt(req.ip).allowed) return err('slow_down', undefined, 429);
      const p = req.body as Record<string, string> | undefined;
      if (
        !p ||
        typeof p !== 'object' ||
        '__duplicate' in p ||
        !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
      )
        return err('invalid_request', 'Send form-encoded parameters, each once');
      if (!p.client_id) return err('invalid_client', undefined, 401);

      if (p.grant_type === 'authorization_code') {
        if (!p.code || !p.redirect_uri || !p.code_verifier) return err('invalid_request');
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier)) return err('invalid_grant');
        const clientId = p.client_id;
        const result = await db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(oauthCodes)
            .innerJoin(oauthGrants, eq(oauthGrants.id, oauthCodes.grantId))
            .where(eq(oauthCodes.id, codeId(key, p.code ?? '')))
            .for('update');
          if (!row) return null;
          if (row.oauth_codes.usedAt) {
            // A code presented twice was intercepted: end everything issued from it.
            await revokeGrant(tx, row.oauth_grants.id, 'code_reuse');
            return null;
          }
          await tx
            .update(oauthCodes)
            .set({ usedAt: new Date() })
            .where(eq(oauthCodes.id, row.oauth_codes.id));
          const challenge = createHash('sha256')
            .update(p.code_verifier ?? '')
            .digest('base64url');
          if (
            row.oauth_codes.expiresAt.getTime() <= Date.now() ||
            row.oauth_grants.clientId !== clientId ||
            row.oauth_grants.revokedAt ||
            row.oauth_codes.redirectUri !== p.redirect_uri ||
            !safeEqual(challenge, row.oauth_codes.codeChallenge)
          ) {
            await revokeGrant(tx, row.oauth_grants.id, 'code_exchange_failed');
            return null;
          }
          return tokens.issue(tx, {
            id: row.oauth_grants.id,
            userId: row.oauth_grants.userId,
            scopes: row.oauth_grants.scopes as ApiScope[],
            audience: row.oauth_grants.audience,
          });
        });
        return result ?? err('invalid_grant');
      }

      if (p.grant_type === 'refresh_token') {
        if (!p.refresh_token) return err('invalid_request');
        const narrow = p.scope === undefined ? null : parseScopeString(p.scope);
        if (p.scope !== undefined && !narrow) return err('invalid_scope');
        const result = await tokens.refresh(p.refresh_token, p.client_id, narrow);
        if (result === 'invalid_grant' || result === 'invalid_scope') return err(result);
        return result;
      }
      return err('unsupported_grant_type');
    });

    scope.post('/oauth/revoke', async (req, reply) => {
      noStore(reply);
      if (!tokenCalls.attempt(req.ip).allowed)
        return reply.status(429).send({ error: 'slow_down' });
      const p = req.body as Record<string, string> | undefined;
      if (!p || typeof p !== 'object' || '__duplicate' in p || !p.token || !p.client_id)
        return reply.status(400).send({ error: 'invalid_request' });
      await tokens.revokeByClient(p.token, p.client_id);
      // Same answer whether or not the token existed (RFC 7009 §2.2).
      return reply.status(200).send({});
    });
  });
}

/** Housekeeping for the job runner. */
export async function purgeOAuth(db: Database, now = new Date()): Promise<void> {
  await db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, now));
  await db
    .delete(oauthCodes)
    .where(or(lt(oauthCodes.expiresAt, new Date(now.getTime() - 3600_000))));
  await db
    .delete(oauthClients)
    .where(
      and(
        eq(oauthClients.registeredVia, 'dynamic'),
        isNull(oauthClients.authorizedAt),
        lt(oauthClients.createdAt, new Date(now.getTime() - UNUSED_CLIENT_TTL_MS)),
      ),
    );
}

/** Append query parameters to a redirect URI, keeping any it already has. */
export function withParams(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function singleParams(query: unknown): Record<string, string | undefined> | null {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries((query ?? {}) as Record<string, unknown>)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

function noStore(reply: FastifyReply) {
  reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}

function errorPage(reply: FastifyReply, message: string, status = 400) {
  return reply
    .status(status)
    .type('text/plain; charset=utf-8')
    .send(`Sign-in request not accepted.\n\n${message}\n`);
}
