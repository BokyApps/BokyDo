import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, oauthGrants, users } from '../db/schema.js';
import { Client, createUser, TEST_HOST, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
const BASE = 'https://tasks.example.com';
const CALLBACK = 'https://claude.example/api/mcp/auth_callback';
let t: TestApp;
let alice: { id: string; http: Client };

const verifier = () => randomBytes(32).toString('base64url');
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');

async function person(name: string) {
  const id = await createUser(t.db, { username: name, password: PASSWORD });
  const http = new Client(t.app, BASE);
  await http.login(name, PASSWORD);
  return { id, http };
}

const raw = (opts: InjectOptions) => t.app.inject(opts);

const form = (url: string, params: Record<string, string>) =>
  raw({
    method: 'POST',
    url,
    headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(params).toString(),
  });

async function register(redirectUris = [CALLBACK], name = 'Claude') {
  const res = await raw({
    method: 'POST',
    url: '/oauth/register',
    headers: { host: TEST_HOST },
    payload: { redirect_uris: redirectUris, client_name: name, token_endpoint_auth_method: 'none' },
  });
  return res;
}

async function authorize(params: Record<string, string>) {
  return raw({
    method: 'GET',
    url: `/oauth/authorize?${new URLSearchParams(params).toString()}`,
    headers: { host: TEST_HOST },
  });
}

/** Register, authorize, approve as `who`; returns what the token endpoint needs. */
async function codeFor(
  who: { http: Client },
  opts: { scope?: string; resource?: string; approveScopes?: string[]; redirect?: string } = {},
) {
  const clientId = (await register([opts.redirect ?? CALLBACK])).json().client_id as string;
  const v = verifier();
  const res = await authorize({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: opts.redirect ?? CALLBACK,
    code_challenge: challengeOf(v),
    code_challenge_method: 'S256',
    state: 'xyz',
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.resource ? { resource: opts.resource } : {}),
  });
  expect(res.statusCode).toBe(302);
  const handle = new URL(res.headers.location as string).hash.slice(1);
  const decision = await who.http.post('/api/v1/oauth/request/decision', {
    request: handle,
    approve: true,
    ...(opts.approveScopes ? { scopes: opts.approveScopes } : {}),
  });
  expect(decision.statusCode).toBe(200);
  const back = new URL(decision.json().redirect);
  return { clientId, verifier: v, code: back.searchParams.get('code') ?? '', back };
}

const exchange = (c: { clientId: string; verifier: string; code: string }, redirect = CALLBACK) =>
  form('/oauth/token', {
    grant_type: 'authorization_code',
    code: c.code,
    redirect_uri: redirect,
    client_id: c.clientId,
    code_verifier: c.verifier,
  });

const syncWith = (token: string) =>
  raw({
    method: 'POST',
    url: '/api/v1/sync',
    headers: { host: TEST_HOST, authorization: `Bearer ${token}` },
    payload: { cursor: null },
  });

describe.skipIf(!TEST_DATABASE_URL)('OAuth authorization server', () => {
  beforeEach(async () => {
    t = await testApp();
    await t.app.services.settings.update(
      { 'instance.publicUrl': BASE },
      { userId: null, ip: null },
    );
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    alice = await person('alice');
  });
  afterEach(async () => t.close());

  it('publishes metadata for the server and both resources', async () => {
    const as = (
      await raw({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
    ).json();
    expect(as).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    const mcp = (
      await raw({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' })
    ).json();
    expect(mcp).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    expect(mcp.scopes_supported).not.toContain('sync');
    await t.app.services.settings.update({ 'api.enabled': false }, { userId: null, ip: null });
    expect(
      (await raw({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).statusCode,
    ).toBe(404);
  });

  it('registers clients with safe redirect URIs only', async () => {
    const ok = await register([
      CALLBACK,
      'http://127.0.0.1:33418/callback',
      'com.bokyapps.bokydo:/oauth',
    ]);
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ client_name: 'Claude', token_endpoint_auth_method: 'none' });
    expect(ok.json().client_id).toMatch(/^bkdc_/);
    for (const bad of [
      'http://evil.example/cb', // plain http off loopback
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'https://ok.example/cb#frag',
      'https://user:pw@ok.example/cb',
      'myapp:/cb', // private-use scheme must be reverse-domain
    ]) {
      const res = await register([bad]);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error).toBe('invalid_redirect_uri');
    }
    expect(
      (await register([CALLBACK], `Evil${String.fromCharCode(0x202e)}gnp.exe`)).statusCode,
    ).toBe(400);
    await t.app.services.settings.update(
      { 'api.dynamicClientRegistration': false },
      { userId: null, ip: null },
    );
    expect((await register()).statusCode).toBe(403);
  });

  it('never redirects to an unverified address and requires PKCE S256', async () => {
    const clientId = (await register()).json().client_id;
    const base = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: challengeOf(verifier()),
      code_challenge_method: 'S256',
      state: 's1',
    };
    for (const params of [
      { ...base, client_id: 'bkdc_nope' },
      { ...base, redirect_uri: 'https://evil.example/cb' },
      { ...base, redirect_uri: `${CALLBACK}/x` },
    ]) {
      const res = await authorize(params);
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
    // Repeated parameters are refused outright.
    const dup = await raw({
      method: 'GET',
      url: `/oauth/authorize?${new URLSearchParams(base).toString()}&redirect_uri=https://evil.example/cb`,
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.headers.location).toBeUndefined();

    const errorOf = async (params: Record<string, string>) => {
      const res = await authorize(params);
      expect(res.statusCode).toBe(302);
      const url = new URL(res.headers.location as string);
      expect(url.origin + url.pathname).toBe(CALLBACK);
      expect(url.searchParams.get('state')).toBe('s1');
      expect(url.searchParams.get('iss')).toBe(BASE);
      return url.searchParams.get('error');
    };
    expect(await errorOf({ ...base, code_challenge_method: 'plain' })).toBe('invalid_request');
    const { code_challenge: _c, ...noChallenge } = base;
    expect(await errorOf(noChallenge)).toBe('invalid_request');
    expect(await errorOf({ ...base, response_type: 'token' })).toBe('unsupported_response_type');
    expect(await errorOf({ ...base, scope: 'tasks:read admin' })).toBe('invalid_scope');
    expect(await errorOf({ ...base, resource: 'https://evil.example/mcp' })).toBe('invalid_target');

    const ok = await authorize(base);
    expect(ok.headers.location).toMatch(new RegExp(`^${BASE}/oauth/consent#[A-Za-z0-9_-]{43}$`));
  });

  it('shows the consent request and sends denials back', async () => {
    const clientId = (await register()).json().client_id;
    const res = await authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: challengeOf(verifier()),
      code_challenge_method: 'S256',
      scope: 'tasks:read tasks:write',
      resource: `${BASE}/mcp`,
    });
    const request = new URL(res.headers.location as string).hash.slice(1);
    const anon = new Client(t.app, BASE);
    expect((await anon.post('/api/v1/oauth/request', { request })).statusCode).toBe(401);
    const info = (await alice.http.post('/api/v1/oauth/request', { request })).json();
    expect(info).toMatchObject({
      clientName: 'Claude',
      redirectHost: 'claude.example',
      redirectKind: 'web',
      scopes: ['tasks:read', 'tasks:write'],
      audience: 'mcp',
    });
    const denied = await alice.http.post('/api/v1/oauth/request/decision', {
      request,
      approve: false,
    });
    expect(new URL(denied.json().redirect).searchParams.get('error')).toBe('access_denied');
    // Single use.
    expect(
      (await alice.http.post('/api/v1/oauth/request/decision', { request, approve: true }))
        .statusCode,
    ).toBe(404);
  });

  it('exchanges a code once, with the right verifier, for working tokens', async () => {
    const c = await codeFor(alice, { scope: 'sync tasks:read' });
    expect(c.back.searchParams.get('state')).toBe('xyz');
    expect(c.back.searchParams.get('iss')).toBe(BASE);
    const res = await exchange(c);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const tokens = res.json();
    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'sync tasks:read',
    });
    expect(tokens.access_token).toMatch(/^bkd_at_/);
    expect(tokens.refresh_token).toMatch(/^bkd_rt_/);
    expect((await syncWith(tokens.access_token)).statusCode).toBe(200);
    // A refresh token is not a bearer credential.
    expect((await syncWith(tokens.refresh_token)).statusCode).toBe(401);

    // Replaying the code revokes everything issued from it.
    expect((await exchange(c)).json().error).toBe('invalid_grant');
    expect((await syncWith(tokens.access_token)).statusCode).toBe(401);
  });

  it('rejects wrong verifiers, clients and redirect URIs (and burns the code)', async () => {
    const c1 = await codeFor(alice, { scope: 'sync' });
    expect((await exchange({ ...c1, verifier: verifier() })).json().error).toBe('invalid_grant');
    expect((await exchange(c1)).json().error).toBe('invalid_grant');

    const c2 = await codeFor(alice, { scope: 'sync' });
    const other = (await register()).json().client_id;
    expect((await exchange({ ...c2, clientId: other })).json().error).toBe('invalid_grant');

    const c3 = await codeFor(alice, { scope: 'sync', redirect: 'http://127.0.0.1:5000/cb' });
    expect((await exchange(c3, 'http://127.0.0.1:6000/cb')).json().error).toBe('invalid_grant');

    // Loopback redirects match on any port (RFC 8252), but the exchange must repeat it exactly.
    const clientId = (await register(['http://127.0.0.1/cb'])).json().client_id;
    const res = await authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:49152/cb',
      code_challenge: challengeOf(verifier()),
      code_challenge_method: 'S256',
    });
    expect(res.headers.location).toMatch(/\/oauth\/consent#/);
  });

  it('keeps audiences and scopes apart', async () => {
    const mcp = await codeFor(alice, { scope: 'sync tasks:read', resource: `${BASE}/mcp` });
    const mcpTokens = (await exchange(mcp)).json();
    expect(mcpTokens.scope).toBe('tasks:read'); // `sync` is never granted for MCP
    expect((await syncWith(mcpTokens.access_token)).statusCode).toBe(401); // wrong audience

    const narrow = await codeFor(alice, {
      scope: 'sync tasks:read',
      approveScopes: ['tasks:read'],
    });
    const narrowTokens = (await exchange(narrow)).json();
    expect(narrowTokens.scope).toBe('tasks:read');
    const res = await syncWith(narrowTokens.access_token);
    expect(res.statusCode).toBe(403);
    expect(res.headers['www-authenticate']).toContain('insufficient_scope');

    // The consent screen can't grant more than was asked.
    const clientId = (await register()).json().client_id;
    const auth = await authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: challengeOf(verifier()),
      code_challenge_method: 'S256',
      scope: 'tasks:read',
    });
    const request = new URL(auth.headers.location as string).hash.slice(1);
    expect(
      (
        await alice.http.post('/api/v1/oauth/request/decision', {
          request,
          approve: true,
          scopes: ['sync'],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('rotates refresh tokens and revokes the grant when one is reused', async () => {
    const c = await codeFor(alice, { scope: 'sync tasks:read' });
    const first = (await exchange(c)).json();
    const refresh = (token: string, extra: Record<string, string> = {}) =>
      form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: c.clientId,
        ...extra,
      });

    const second = (await refresh(first.refresh_token)).json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await syncWith(first.access_token)).statusCode).toBe(401); // rotated out
    expect((await syncWith(second.access_token)).statusCode).toBe(200);
    expect((await refresh(second.refresh_token, { scope: 'sync admin' })).json().error).toBe(
      'invalid_scope',
    );

    // An attacker replays the first refresh token: the whole grant ends.
    expect((await refresh(first.refresh_token)).json().error).toBe('invalid_grant');
    expect((await syncWith(second.access_token)).statusCode).toBe(401);
    expect((await refresh(second.refresh_token)).json().error).toBe('invalid_grant');
    const [grant] = await t.db.db.select().from(oauthGrants);
    expect(grant?.revokedReason).toBe('refresh_token_reuse');
  });

  it('narrows scope on refresh, and only the owning client can refresh or revoke', async () => {
    const c = await codeFor(alice, { scope: 'sync tasks:read' });
    const first = (await exchange(c)).json();
    const other = (await register()).json().client_id;
    expect(
      (
        await form('/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: first.refresh_token,
          client_id: other,
        })
      ).json().error,
    ).toBe('invalid_grant');
    await form('/oauth/revoke', { token: first.refresh_token, client_id: other });
    const narrowed = (
      await form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: c.clientId,
        scope: 'tasks:read',
      })
    ).json();
    expect(narrowed.scope).toBe('tasks:read');

    const revoked = await form('/oauth/revoke', {
      token: narrowed.refresh_token,
      client_id: c.clientId,
    });
    expect(revoked.statusCode).toBe(200);
    expect((await syncWith(narrowed.access_token)).statusCode).toBe(401);
  });

  it('lists and revokes authorized apps', async () => {
    const c = await codeFor(alice, { scope: 'sync' });
    const tokens = (await exchange(c)).json();
    const apps = (await alice.http.get('/api/v1/account/apps')).json().apps;
    expect(apps).toMatchObject([
      { clientId: c.clientId, name: 'Claude', redirectHosts: ['claude.example'], scopes: ['sync'] },
    ]);
    const bob = await person('bob');
    expect(
      (await bob.http.request({ method: 'DELETE', url: `/api/v1/account/apps/${c.clientId}` }))
        .statusCode,
    ).toBe(404);
    expect((await syncWith(tokens.access_token)).statusCode).toBe(200);
    expect(
      (await alice.http.request({ method: 'DELETE', url: `/api/v1/account/apps/${c.clientId}` }))
        .statusCode,
    ).toBe(204);
    expect((await syncWith(tokens.access_token)).statusCode).toBe(401);
    expect((await alice.http.get('/api/v1/account/apps')).json().apps).toEqual([]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('personal access tokens', () => {
  beforeEach(async () => {
    t = await testApp();
    await t.app.services.settings.update(
      { 'instance.publicUrl': BASE },
      { userId: null, ip: null },
    );
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    alice = await person('alice');
  });
  afterEach(async () => t.close());

  const create = (client: Client, body: Record<string, unknown> = {}) =>
    client.post('/api/v1/account/tokens', {
      name: 'n8n',
      scopes: ['sync'],
      expiresInDays: 30,
      ...body,
    });

  it('are shown once, stored hashed, scoped and revocable', async () => {
    const res = await create(alice.http);
    expect(res.statusCode).toBe(201);
    const { token, pat } = res.json();
    expect(token).toMatch(/^bkd_pat_[A-Za-z0-9_-]{43}$/);
    const listed = (await alice.http.get('/api/v1/account/tokens')).json().tokens;
    expect(listed).toMatchObject([{ id: pat.id, name: 'n8n', scopes: ['sync'] }]);
    expect(JSON.stringify(listed)).not.toContain(token.slice(8));
    const stored = await t.db.db.execute('select hash from api_tokens');
    expect(JSON.stringify(stored)).not.toContain(token.slice(8));
    expect(JSON.stringify(await t.db.db.select().from(auditLog))).not.toContain(token.slice(8));

    expect((await syncWith(token)).statusCode).toBe(200);
    // Tokens can't manage tokens.
    const viaToken = await raw({
      method: 'POST',
      url: '/api/v1/account/tokens',
      headers: { host: TEST_HOST, authorization: `Bearer ${token}` },
      payload: { name: 'x', scopes: ['sync'], expiresInDays: 1 },
    });
    expect(viaToken.json().error).toBe('token_not_accepted');

    const bob = await person('bob');
    expect(
      (await bob.http.request({ method: 'DELETE', url: `/api/v1/account/tokens/${pat.id}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await alice.http.request({ method: 'DELETE', url: `/api/v1/account/tokens/${pat.id}` }))
        .statusCode,
    ).toBe(204);
    expect((await syncWith(token)).statusCode).toBe(401);
  });

  it('need a recent sign-in and alert the user', async () => {
    await t.db.db.execute(`update sessions set reauthenticated_at = now() - interval '1 hour'`);
    expect((await create(alice.http)).json().error).toBe('reauth_required');
    await alice.http.post('/api/v1/auth/reauth', { password: PASSWORD });
    expect((await create(alice.http)).statusCode).toBe(201);
    // The in-app alert is recorded in the background.
    let alerts = '';
    for (let i = 0; i < 20 && !alerts.includes('api_token_created'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      alerts = JSON.stringify(await t.db.db.execute(`select type, data from notifications`));
    }
    expect(alerts).toContain('api_token_created');
  });

  it('expire, and stop working when the account is reset or disabled', async () => {
    const short = (await create(alice.http, { expiresInDays: 1 })).json().token;
    await t.db.db.execute(`update api_tokens set expires_at = now() - interval '1 second'`);
    expect((await syncWith(short)).statusCode).toBe(401);

    const token = (await create(alice.http)).json().token;
    expect((await syncWith(token)).statusCode).toBe(200);
    await alice.http.post('/api/v1/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'lantern-quokka-harbor-tundra',
    });
    expect((await syncWith(token)).statusCode).toBe(401);

    alice.http = new Client(t.app, BASE);
    await alice.http.login('alice', 'lantern-quokka-harbor-tundra');
    const again = (await create(alice.http)).json().token;
    await t.db.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, alice.id));
    expect((await syncWith(again)).statusCode).toBe(401);
  });

  it('are refused entirely when the API is switched off', async () => {
    const token = (await create(alice.http)).json().token;
    await t.app.services.settings.update({ 'api.enabled': false }, { userId: null, ip: null });
    expect((await syncWith(token)).json().error).toBe('api_disabled');
  });
});
