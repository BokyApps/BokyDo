import { CSRF_HEADER, isLoopbackHost, type ApiScope } from '@bokydo/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { REAUTH_WINDOW_MS, type SessionContext, type SessionStore } from '../auth/sessions.js';
import type { SessionUserRow } from '../auth/sessions.js';
import type { ApiTokenStore, TokenPrincipal } from '../oauth/token-store.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { ProjectScope } from '../sync/policy.js';

/**
 * Who may call a route:
 *  - public:     anyone
 *  - restricted: any signed-in user, even one who must still change their password or enrol in
 *                two-factor authentication (used for exactly those screens)
 *  - user:       signed-in user with nothing pending
 *  - admin:      `user` + instance admin
 */
export type Access = 'public' | 'restricted' | 'user' | 'admin';

/**
 * When a route is reachable relative to first-run setup:
 *  - after (default): only once setup is complete
 *  - always:          before and after
 *  - before:          only during setup (404 afterwards)
 */
export type SetupPhase = 'after' | 'always' | 'before';

export interface ApiRoute {
  method: string;
  url: string;
  access: Access;
  setup: SetupPhase;
  scopes: readonly ApiScope[] | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every /api route with its declared access level (drives the authz matrix test). */
    apiRoutes: ApiRoute[];
  }
  interface FastifyContextConfig {
    access?: Access;
    setup?: SetupPhase;
    /**
     * Bearer tokens (personal access tokens, OAuth) may call this route if they hold every one of
     * these scopes. Routes without it are session-only. Never set on admin routes.
     */
    scopes?: readonly ApiScope[];
  }
  interface FastifyRequest {
    session: SessionContext | null;
    /** Set instead of `session` when the caller authenticated with a bearer token. */
    token: TokenPrincipal | null;
  }
}

const SESSION_COOKIE_SECURE = '__Host-bokydo_session';
const SESSION_COOKIE_PLAIN = 'bokydo_session';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AccessDeps {
  settings: SettingsService;
  sessions: SessionStore;
  tokens: ApiTokenStore;
}

/**
 * Registers the authorization pipeline. Must run before any /api route is registered: every
 * /api route has to declare `config.access`, or registration throws (fail closed).
 */
export function registerAccessControl(app: FastifyInstance, deps: AccessDeps): void {
  app.decorateRequest('session', null);
  app.decorateRequest('token', null);
  const apiRoutes: ApiRoute[] = [];
  app.decorate('apiRoutes', apiRoutes);

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const access = route.config?.access;
    if (!access) throw new Error(`Route ${route.method} ${route.url} must declare config.access`);
    const scopes = route.config?.scopes ?? null;
    if (scopes && (access === 'admin' || access === 'public' || scopes.length === 0))
      throw new Error(
        `Route ${route.method} ${route.url}: token scopes need user/restricted access`,
      );
    for (const method of [route.method].flat()) {
      apiRoutes.push({
        method,
        url: route.url,
        access,
        setup: route.config?.setup ?? 'after',
        scopes,
      });
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.is404) return;
    const config = req.routeOptions.config;
    const access = config.access ?? 'admin';
    const phase = config.setup ?? 'after';

    const setupComplete = deps.settings.isSetupComplete();
    if (phase === 'after' && !setupComplete) return deny(reply, 403, 'setup_required');
    if (phase === 'before' && setupComplete) return deny(reply, 404, 'not_found');

    // Bearer tokens: no cookies are consulted at all, so there is nothing for CSRF to ride on.
    if (req.headers.authorization !== undefined) return bearer(req, reply, access, config.scopes);

    const unsafe = UNSAFE_METHODS.has(req.method);
    if (unsafe && !originAllowed(req, deps.settings)) return deny(reply, 403, 'csrf_failed');

    const token = readSessionToken(req);
    req.session = token ? await deps.sessions.lookup(token) : null;

    if (access === 'public') return;
    if (!req.session) return deny(reply, 401, 'unauthenticated');
    if (unsafe && !csrfTokenValid(req, req.session)) return deny(reply, 403, 'csrf_failed');
    if (access === 'restricted') return;
    if (req.session.user.mustChangePassword) return deny(reply, 403, 'password_change_required');
    if (req.session.user.mustEnrollMfa) return deny(reply, 403, 'mfa_enrollment_required');
    if (access === 'admin' && !req.session.user.isAdmin) return deny(reply, 403, 'forbidden');
  });

  async function bearer(
    req: FastifyRequest,
    reply: FastifyReply,
    access: Access,
    scopes: readonly ApiScope[] | undefined,
  ) {
    const challenge = (error: string, extra = '') => {
      const base = deps.settings.get('instance.publicUrl');
      const meta = base ? `, resource_metadata="${base}/.well-known/oauth-protected-resource"` : '';
      reply.header('www-authenticate', `Bearer error="${error}"${extra}${meta}`);
    };
    if (access === 'public') return deny(reply, 400, 'unexpected_authorization');
    const match = /^Bearer ([A-Za-z0-9_-]{1,100})$/.exec(req.headers.authorization ?? '');
    if (!match?.[1]) {
      challenge('invalid_request');
      return deny(reply, 401, 'invalid_access_token');
    }
    if (!deps.settings.get('api.enabled')) return deny(reply, 403, 'api_disabled');
    if (!scopes) return deny(reply, 403, 'token_not_accepted');
    const token = await deps.tokens.authenticate(match[1], 'api');
    if (!token) {
      challenge('invalid_token');
      return deny(reply, 401, 'invalid_access_token');
    }
    if (token.user.mustChangePassword) return deny(reply, 403, 'password_change_required');
    if (token.user.mustEnrollMfa) return deny(reply, 403, 'mfa_enrollment_required');
    if (!scopes.every((s) => token.scopes.includes(s))) {
      challenge('insufficient_scope', `, scope="${scopes.join(' ')}"`);
      return deny(reply, 403, 'insufficient_scope');
    }
    // `sync` is whole-account access: a project-limited token can't be created with it, and
    // never reaches a route that needs it even if one were stored.
    if (token.projectIds && scopes.includes('sync')) {
      challenge('insufficient_scope', `, scope="${scopes.join(' ')}"`);
      return deny(reply, 403, 'insufficient_scope');
    }
    req.token = token;
  }
}

function deny(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error });
}

/**
 * CSRF layer 1: the browser-supplied Origin must be this instance. Once a public URL is set it
 * must match exactly (this also defeats DNS rebinding). During first-run setup, before the public
 * URL is known, the Origin host must equal the Host header; scheme is ignored because a TLS proxy
 * may sit in front without trusted forwarding headers yet.
 */
export function originAllowed(req: FastifyRequest, settings: SettingsService): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  const publicUrl = settings.get('instance.publicUrl');
  if (publicUrl) return origin === publicUrl;
  try {
    return new URL(origin).host === req.host;
  } catch {
    return false;
  }
}

/** CSRF layer 2: synchronizer token tied to the session. */
function csrfTokenValid(req: FastifyRequest, session: SessionContext): boolean {
  const header = req.headers[CSRF_HEADER];
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(session.csrfToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readSessionToken(req: FastifyRequest): string | null {
  return req.cookies[SESSION_COOKIE_SECURE] ?? req.cookies[SESSION_COOKIE_PLAIN] ?? null;
}

/**
 * Cookies are `Secure` (with the `__Host-` prefix) once the public URL is HTTPS, or when the
 * request itself arrived over TLS. Plain-HTTP LAN installs still work, with a setup warning.
 */
function useSecureCookie(req: FastifyRequest, settings: SettingsService): boolean {
  const publicUrl = settings.get('instance.publicUrl');
  if (publicUrl) return publicUrl.startsWith('https:');
  return req.protocol === 'https';
}

export function setSessionCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  settings: SettingsService,
  token: string,
  expiresAt: Date,
): void {
  const secure = useSecureCookie(req, settings);
  reply.clearCookie(secure ? SESSION_COOKIE_PLAIN : SESSION_COOKIE_SECURE, { path: '/' });
  reply.setCookie(secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires: expiresAt,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_SECURE, { path: '/', secure: true });
  reply.clearCookie(SESSION_COOKIE_PLAIN, { path: '/' });
}

/** Warn when the instance is exposed over plain HTTP beyond loopback. */
export function insecurePublicUrl(publicUrl: string | null): boolean {
  if (!publicUrl) return false;
  const url = new URL(publicUrl);
  return url.protocol === 'http:' && !isLoopbackHost(url.hostname);
}

/**
 * The user behind a request, from a session or a bearer token. Only for routes that declare
 * `config.scopes`; everything else must use `requireSession`.
 */
export function requireUser(req: FastifyRequest): SessionUserRow {
  const user = req.session?.user ?? req.token?.user;
  if (!user) throw new Error(`No caller on ${req.method} ${req.url}`);
  return user;
}

/**
 * The projects a request may reach: those of a project-limited token, or null (no limit) for
 * sessions and unrestricted tokens. Pass it to every project lookup on a token route.
 */
export function callerScope(req: FastifyRequest): ProjectScope {
  return req.token?.projectIds ?? null;
}

/**
 * The session of a request on a non-public route. The access hook has already rejected anonymous
 * callers, so a missing session here means a routing bug: fail loudly rather than continue.
 * Bearer-token requests have no session, so this also fails closed on routes not meant for them.
 */
export function requireSession(req: FastifyRequest): SessionContext {
  if (!req.session) throw new Error(`No session on ${req.method} ${req.url}`);
  return req.session;
}

/**
 * "Sudo mode" for sensitive account changes (two-factor, passkeys, email): the user must have
 * entered their password or used a passkey within the last few minutes, so a stolen session
 * cookie alone can't lock the real owner out. Sends 403 `reauth_required` and returns false.
 */
export function requireRecentAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const session = requireSession(req);
  if (Date.now() - session.reauthenticatedAt.getTime() <= REAUTH_WINDOW_MS) return true;
  void reply.status(403).send({ error: 'reauth_required' });
  return false;
}

export function useSecureCookies(req: FastifyRequest, settings: SettingsService): boolean {
  return useSecureCookie(req, settings);
}
