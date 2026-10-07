import { eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from './db/schema.js';
import type { Access, ApiRoute, SetupPhase } from './http/access.js';
import { Client, createUser, testApp, type TestApp } from './test/app.js';
import { TEST_DATABASE_URL } from './test/db.js';

/**
 * The authorization matrix. Every /api route must be listed here with its intended access level
 * and setup phase; adding a route without updating this table fails CI, and so does any change
 * that loosens a route. Each route is then exercised as every kind of caller, before and after
 * setup, and the outcome must match what its declaration promises.
 */
const EXPECTED: Record<string, `${Access}/${SetupPhase}`> = {
  'GET /api/v1/instance': 'public/always',
  // Sign-in and second factor
  'POST /api/v1/auth/login': 'public/always',
  'POST /api/v1/auth/mfa/totp': 'public/always',
  'POST /api/v1/auth/mfa/recovery': 'public/always',
  'POST /api/v1/auth/mfa/passkey/options': 'public/always',
  'POST /api/v1/auth/mfa/passkey': 'public/always',
  'POST /api/v1/auth/passkey/options': 'public/always',
  'POST /api/v1/auth/passkey': 'public/always',
  'POST /api/v1/auth/logout': 'restricted/always',
  'GET /api/v1/auth/session': 'restricted/always',
  'POST /api/v1/auth/password': 'restricted/always',
  'POST /api/v1/auth/reauth': 'restricted/always',
  'POST /api/v1/auth/reauth/passkey/options': 'restricted/always',
  'POST /api/v1/auth/reauth/passkey': 'restricted/always',
  // Recovery and registration
  'POST /api/v1/auth/password-reset': 'public/after',
  'POST /api/v1/auth/password-reset/complete': 'public/after',
  'POST /api/v1/auth/email/verify': 'public/always',
  'POST /api/v1/auth/invite': 'public/after',
  'POST /api/v1/auth/register': 'public/after',
  // Account security
  'GET /api/v1/account/security': 'restricted/always',
  'GET /api/v1/account/sessions': 'user/always',
  'DELETE /api/v1/account/sessions/:id': 'user/always',
  'POST /api/v1/account/sessions/revoke-others': 'user/always',
  'POST /api/v1/account/totp/setup': 'restricted/always',
  'POST /api/v1/account/totp/confirm': 'restricted/always',
  'POST /api/v1/account/totp/disable': 'restricted/always',
  'POST /api/v1/account/recovery-codes': 'restricted/always',
  'POST /api/v1/account/passkeys/options': 'restricted/always',
  'POST /api/v1/account/passkeys': 'restricted/always',
  'PATCH /api/v1/account/passkeys/:id': 'restricted/always',
  'DELETE /api/v1/account/passkeys/:id': 'restricted/always',
  'PUT /api/v1/account/email': 'user/always',
  'GET /api/v1/account/export': 'user/after',
  'GET /api/v1/account/deletion': 'user/after',
  'POST /api/v1/account/delete': 'user/after',
  // Setup and administration
  'GET /api/v1/setup': 'admin/before',
  'PUT /api/v1/setup/public-url': 'admin/before',
  'POST /api/v1/setup/complete': 'admin/before',
  'GET /api/v1/admin/settings': 'admin/always',
  'PATCH /api/v1/admin/settings': 'admin/always',
  'POST /api/v1/admin/email/test': 'admin/always',
  'GET /api/v1/admin/backups': 'admin/always',
  'POST /api/v1/admin/backups': 'admin/always',
  'GET /api/v1/admin/backups/:name': 'admin/always',
  'DELETE /api/v1/admin/backups/:name': 'admin/always',
  'POST /api/v1/admin/backups/upload': 'admin/always',
  'POST /api/v1/admin/backups/:name/restore': 'admin/always',
  'GET /api/v1/admin/ai/credentials': 'admin/after',
  'POST /api/v1/admin/ai/credentials': 'admin/after',
  'PATCH /api/v1/admin/ai/credentials/:id': 'admin/after',
  'DELETE /api/v1/admin/ai/credentials/:id': 'admin/after',
  'POST /api/v1/admin/ai/credentials/:id/test': 'admin/after',
  'POST /api/v1/admin/ai/credentials/:id/try': 'admin/after',
  'PUT /api/v1/admin/ai/routing': 'admin/after',
  'GET /api/v1/admin/ai/usage': 'admin/after',
  // OAuth consent, authorized apps, personal access tokens
  'POST /api/v1/oauth/request': 'user/after',
  'POST /api/v1/oauth/request/decision': 'user/after',
  'GET /api/v1/account/apps': 'user/after',
  'DELETE /api/v1/account/apps/:clientId': 'user/after',
  'GET /api/v1/account/tokens': 'user/after',
  'POST /api/v1/account/tokens': 'user/after',
  'DELETE /api/v1/account/tokens/:id': 'user/after',
  // AI (own credentials, routing, usage)
  'GET /api/v1/ai/catalog': 'user/after',
  'GET /api/v1/ai/credentials': 'user/after',
  'POST /api/v1/ai/credentials': 'user/after',
  'PATCH /api/v1/ai/credentials/:id': 'user/after',
  'DELETE /api/v1/ai/credentials/:id': 'user/after',
  'POST /api/v1/ai/credentials/:id/test': 'user/after',
  'POST /api/v1/ai/credentials/:id/try': 'user/after',
  'GET /api/v1/ai/routing': 'user/after',
  'PUT /api/v1/ai/routing': 'user/after',
  'GET /api/v1/ai/usage': 'user/after',
  'GET /api/v1/admin/users': 'admin/after',
  'POST /api/v1/admin/users': 'admin/after',
  'PATCH /api/v1/admin/users/:id': 'admin/after',
  'GET /api/v1/admin/users/:id/deletion': 'admin/after',
  'POST /api/v1/admin/users/:id/delete': 'admin/after',
  'POST /api/v1/admin/users/:id/reset-mfa': 'admin/after',
  'POST /api/v1/admin/users/:id/password-reset-link': 'admin/after',
  'GET /api/v1/admin/invites': 'admin/after',
  'POST /api/v1/admin/invites': 'admin/after',
  'DELETE /api/v1/admin/invites/:id': 'admin/after',
  // Sync
  'POST /api/v1/sync': 'user/after',
  'GET /api/v1/sync/events': 'user/after',
  // Task reads outside sync
  'GET /api/v1/tasks/completed': 'user/after',
  'GET /api/v1/search': 'user/after',
  'GET /api/v1/tasks/filter': 'user/after',
  // Sharing
  'POST /api/v1/projects/:id/invites': 'user/after',
  'GET /api/v1/projects/:id/invites': 'user/after',
  'DELETE /api/v1/projects/:id/invites/:inviteId': 'user/after',
  // Notification delivery
  'GET /api/v1/push/key': 'user/after',
  'POST /api/v1/push/subscriptions': 'user/after',
  'DELETE /api/v1/push/subscriptions': 'user/after',
  'POST /api/v1/push/test': 'user/after',
  'POST /api/v1/ramble/transcribe': 'user/after',
  'POST /api/v1/ramble/extract': 'user/after',
  'POST /api/v1/ramble/commit': 'user/after',
  'POST /api/v1/notifications/unsubscribe': 'public/after',
  'POST /api/v1/workspaces/:id/invites': 'user/after',
  'GET /api/v1/workspaces/:id/invites': 'user/after',
  'DELETE /api/v1/workspaces/:id/invites/:inviteId': 'user/after',
  'GET /api/v1/invites': 'user/after',
  'POST /api/v1/invites/:id/accept': 'user/after',
  'POST /api/v1/invites/:id/decline': 'user/after',
  'POST /api/v1/invites/link/preview': 'user/after',
  'POST /api/v1/invites/link/accept': 'user/after',
  'GET /api/v1/activity': 'user/after',
  'POST /api/v1/projects/:id/attachments': 'user/after',
  'GET /api/v1/attachments/:id': 'user/after',
  // Calendar feeds: managed by the owner, fetched with the secret in the URL
  'GET /api/v1/calendar-feeds': 'user/after',
  'POST /api/v1/calendar-feeds': 'user/after',
  'POST /api/v1/calendar-feeds/:id/rotate': 'user/after',
  'DELETE /api/v1/calendar-feeds/:id': 'user/after',
  'GET /api/v1/calendar/:file': 'public/after',
};

/** Streaming routes never finish on success; only their status line is checked. */
const STREAMING = new Set(['GET /api/v1/sync/events']);

/** `unenrolled`: the MFA policy requires two-factor and this user hasn't set it up yet. */
type Principal = 'anonymous' | 'restricted' | 'unenrolled' | 'user' | 'admin';
const PRINCIPALS: Principal[] = ['anonymous', 'restricted', 'unenrolled', 'user', 'admin'];
const PASSWORD = 'violin-pancake-orbit-meadow';

/**
 * Routes that bearer tokens (personal access tokens, OAuth) may call, with the scopes they need.
 * Everything else is session-only; adding a route here is a deliberate API decision.
 */
const TOKEN_SCOPES: Record<string, string> = {
  'POST /api/v1/sync': 'sync',
  'GET /api/v1/sync/events': 'sync',
  'POST /api/v1/ramble/transcribe': 'ai:use',
  'POST /api/v1/ramble/extract': 'ai:use',
  'POST /api/v1/ramble/commit': 'tasks:write',
};

function expectedOutcome(route: ApiRoute, who: Principal, setupComplete: boolean): string {
  if (route.setup === 'after' && !setupComplete) return 'setup_required';
  if (route.setup === 'before' && setupComplete) return 'not_found';
  if (route.access === 'public') return 'allowed';
  if (who === 'anonymous') return 'unauthenticated';
  if (route.access === 'restricted') return 'allowed';
  if (who === 'restricted') return 'password_change_required';
  if (who === 'unenrolled') return 'mfa_enrollment_required';
  if (route.access === 'admin' && who !== 'admin') return 'forbidden';
  return 'allowed';
}

const DENIALS = new Set([
  'setup_required',
  'not_found',
  'unauthenticated',
  'password_change_required',
  'mfa_enrollment_required',
  'forbidden',
  'csrf_failed',
  'token_not_accepted',
  'unexpected_authorization',
  'insufficient_scope',
  'invalid_access_token',
]);

async function outcome(client: Client, route: ApiRoute): Promise<string> {
  if (STREAMING.has(`${route.method} ${route.url}`)) {
    const res = await client.request({
      method: route.method as 'GET',
      url: route.url,
      payloadAsStream: true,
    });
    if (res.statusCode === 200) {
      res.stream().destroy();
      return 'allowed';
    }
    return (JSON.parse(await streamToString(res.stream())) as { error: string }).error;
  }
  // Path parameters get a well-formed ID of nothing: past authorization that's a resource 404.
  const url = route.url.replace(/:id/g, '00000000-0000-4000-8000-000000000000');
  const res = await client.request({ method: route.method as 'GET', url, payload: {} });
  let error: string | undefined;
  try {
    error = (JSON.parse(res.body) as { error?: string }).error;
  } catch {
    // Empty (204) or non-JSON body: not a denial.
  }
  if (error === 'not_found' && route.url.includes(':')) return 'allowed';
  return error && DENIALS.has(error) ? error : 'allowed';
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += String(chunk);
  return out;
}

// Every route × every kind of caller: exhaustive by design, so allow more than the 5 s default.
describe.skipIf(!TEST_DATABASE_URL)('authorization matrix', { timeout: 60_000 }, () => {
  let t: TestApp;
  let app: FastifyInstance;
  let routes: ApiRoute[];

  beforeAll(async () => {
    t = await testApp();
    app = t.app;
    await createUser(t.db, { username: 'admin', password: PASSWORD, isAdmin: true });
    await createUser(t.db, { username: 'user', password: PASSWORD });
    await createUser(t.db, {
      username: 'restricted',
      password: PASSWORD,
      mustChangePassword: true,
    });
    await createUser(t.db, { username: 'unenrolled', password: PASSWORD });
    // Everyone must use two-factor; all principals but `unenrolled` have it.
    await t.db.db
      .update(users)
      .set({ totpEnabledAt: new Date() })
      .where(ne(users.username, 'unenrolled'));
    await app.services.settings.update(
      { 'security.mfaEnforcement': 'everyone' },
      { userId: null, ip: null },
    );
    await app.ready();
    routes = app.apiRoutes.filter((r) => r.method !== 'HEAD');
  });
  afterAll(async () => t?.close());

  /**
   * A fresh signed-in client per check, so routes like logout can't affect later checks. Sessions
   * are minted directly: logging in 40+ times would (correctly) trip the per-IP login limiter.
   */
  async function clientFor(who: Principal): Promise<Client> {
    const client = new Client(app);
    if (who === 'anonymous') return client;
    const [user] = await t.db.db.select().from(users).where(eq(users.username, who));
    const { token, session } = await app.services.sessions.create(
      {
        id: user!.id,
        username: user!.username,
        isAdmin: user!.isAdmin,
        mustChangePassword: user!.mustChangePassword,
      },
      { ip: null, userAgent: null, authMethod: 'password' },
    );
    client.cookies.set('bokydo_session', token);
    client.csrfToken = session.csrfToken;
    return client;
  }

  it('lists every route with its intended access level', () => {
    const actual = Object.fromEntries(
      routes.map((r) => [`${r.method} ${r.url}`, `${r.access}/${r.setup}`]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  for (const setupComplete of [false, true]) {
    it(`enforces declarations ${setupComplete ? 'after' : 'before'} setup`, async () => {
      if (setupComplete) {
        await app.services.settings.markSetupComplete({ userId: null, ip: null });
      }
      const mismatches: string[] = [];
      for (const route of routes) {
        for (const who of PRINCIPALS) {
          const want = expectedOutcome(route, who, setupComplete);
          const got = await outcome(await clientFor(who), route);
          if (got !== want)
            mismatches.push(`${route.method} ${route.url} as ${who}: want ${want}, got ${got}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('lists every route that accepts bearer tokens, with its scopes', () => {
    const actual = Object.fromEntries(
      routes.filter((r) => r.scopes).map((r) => [`${r.method} ${r.url}`, r.scopes?.join(' ')]),
    );
    expect(actual).toEqual(TOKEN_SCOPES);
  });

  it('lets bearer tokens reach only the routes that accept them, with the right scopes', async () => {
    await app.services.settings.markSetupComplete({ userId: null, ip: null });
    const [admin] = await t.db.db.select().from(users).where(eq(users.username, 'admin'));
    const all = await app.services.apiTokens.createPat(admin!.id, {
      name: 'all',
      scopes: [
        'sync',
        'tasks:read',
        'tasks:write',
        'projects:read',
        'projects:write',
        'comments:read',
        'comments:write',
        'ai:use',
      ],
      expiresInDays: 1,
    });
    const narrow = await app.services.apiTokens.createPat(admin!.id, {
      name: 'narrow',
      scopes: ['tasks:read'],
      expiresInDays: 1,
    });
    const bearerClient = (token: string) => {
      const c = new Client(app, null); // no cookies, no Origin: like curl or an app
      const request = c.request.bind(c);
      c.request = (opts) =>
        request({
          ...opts,
          headers: { ...(opts.headers as object), authorization: `Bearer ${token}` },
        });
      return c;
    };
    const mismatches: string[] = [];
    for (const route of routes.filter((r) => r.setup !== 'before')) {
      const key = `${route.method} ${route.url}`;
      const want =
        route.access === 'public'
          ? 'unexpected_authorization'
          : TOKEN_SCOPES[key]
            ? 'allowed'
            : 'token_not_accepted';
      const got = await outcome(bearerClient(all.token), route);
      if (got !== want) mismatches.push(`${key} with full token: want ${want}, got ${got}`);
      if (TOKEN_SCOPES[key]) {
        const narrowGot = await outcome(bearerClient(narrow.token), route);
        if (narrowGot !== 'insufficient_scope')
          mismatches.push(`${key} with narrow token: got ${narrowGot}`);
        const forged = await outcome(bearerClient(`${all.token.slice(0, -2)}xx`), route);
        if (forged !== 'invalid_access_token')
          mismatches.push(`${key} with forged token: got ${forged}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('requires a same-origin Origin and the session CSRF token on every state change', async () => {
    const unsafe = routes.filter((r) => r.method !== 'GET' && r.setup !== 'before');
    for (const route of unsafe) {
      const noOrigin = await clientFor('admin');
      noOrigin.origin = null;
      expect(await outcome(noOrigin, route), `${route.url} without Origin`).toBe('csrf_failed');

      const foreign = await clientFor('admin');
      foreign.origin = 'https://evil.example';
      expect(await outcome(foreign, route), `${route.url} foreign Origin`).toBe('csrf_failed');

      if (route.access !== 'public') {
        const noToken = await clientFor('admin');
        noToken.csrfToken = null;
        expect(await outcome(noToken, route), `${route.url} without token`).toBe('csrf_failed');
      }
    }
  });
});
