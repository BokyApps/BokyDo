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
  // Setup and administration
  'GET /api/v1/setup': 'admin/before',
  'PUT /api/v1/setup/public-url': 'admin/before',
  'POST /api/v1/setup/complete': 'admin/before',
  'GET /api/v1/admin/settings': 'admin/always',
  'PATCH /api/v1/admin/settings': 'admin/always',
  'POST /api/v1/admin/email/test': 'admin/always',
  'GET /api/v1/admin/users': 'admin/after',
  'POST /api/v1/admin/users': 'admin/after',
  'PATCH /api/v1/admin/users/:id': 'admin/after',
  'POST /api/v1/admin/users/:id/reset-mfa': 'admin/after',
  'POST /api/v1/admin/users/:id/password-reset-link': 'admin/after',
  'GET /api/v1/admin/invites': 'admin/after',
  'POST /api/v1/admin/invites': 'admin/after',
  'DELETE /api/v1/admin/invites/:id': 'admin/after',
  // Sync
  'POST /api/v1/sync': 'user/after',
  'GET /api/v1/sync/events': 'user/after',
};

/** Streaming routes never finish on success; only their status line is checked. */
const STREAMING = new Set(['GET /api/v1/sync/events']);

/** `unenrolled`: the MFA policy requires two-factor and this user hasn't set it up yet. */
type Principal = 'anonymous' | 'restricted' | 'unenrolled' | 'user' | 'admin';
const PRINCIPALS: Principal[] = ['anonymous', 'restricted', 'unenrolled', 'user', 'admin'];
const PASSWORD = 'violin-pancake-orbit-meadow';

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

describe.skipIf(!TEST_DATABASE_URL)('authorization matrix', () => {
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
