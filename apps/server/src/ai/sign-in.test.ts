import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiCredentials, auditLog } from '../db/schema.js';
import type { OutboundFetch, OutboundRequest } from '../net/outbound.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import {
  accountFromIdToken,
  providerPage,
  SignInExpiredError,
  SignInFlows,
  SignInProviderError,
  xaiProtocol,
  type SignInProtocol,
} from './sign-in.js';

// Look like real tokens so a leak would be obvious; not credentials for anything.
const canary = (kind: string, n: number) => `xai-${kind}-SIGNINCANARY-${n}`;

const idToken = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

/**
 * A scripted xAI: device codes, token grants with refresh-token rotation and reuse detection,
 * revocation, and a chat endpoint that only accepts the current access token.
 */
function fakeXai() {
  const state = {
    approved: false,
    denied: false,
    issued: 0,
    refreshes: 0,
    current: { access: '', refresh: '' },
    used: new Set<string>(),
    revoked: [] as string[],
    chats: [] as string[],
    seen: [] as { url: string; body: string }[],
    verificationUrl: 'https://accounts.x.ai/device?user_code=WDJB-MJHT',
    slowDown: false,
    down: false,
    expiresIn: 3600,
  };
  const reply = (status: number, json: unknown) => ({
    status,
    headers: {},
    body: (async function* () {
      yield Buffer.from(JSON.stringify(json));
    })(),
    text: async () => JSON.stringify(json),
    json: async () => json,
    cancel: () => undefined,
  });
  const issue = () => {
    state.issued++;
    state.current = {
      access: canary('access', state.issued),
      refresh: canary('refresh', state.issued),
    };
    return {
      access_token: state.current.access,
      refresh_token: state.current.refresh,
      expires_in: state.expiresIn,
      id_token: idToken({ email: 'alice@example.com' }),
    };
  };
  const fetch: OutboundFetch = async (url: string, init: OutboundRequest = {}) => {
    const body = String(init.body ?? '');
    state.seen.push({ url, body });
    if (state.down) return reply(503, {});
    const form = new URLSearchParams(body);
    if (url === 'https://auth.x.ai/oauth2/device/code')
      return reply(200, {
        device_code: 'DEVICE-CODE-1',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://accounts.x.ai/device',
        verification_uri_complete: state.verificationUrl,
        interval: 5,
        expires_in: 600,
      });
    if (url === 'https://auth.x.ai/oauth2/token') {
      const grant = form.get('grant_type');
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (state.slowDown) return reply(400, { error: 'slow_down' });
        if (state.denied) return reply(400, { error: 'access_denied' });
        if (!state.approved) return reply(400, { error: 'authorization_pending' });
        return reply(200, issue());
      }
      if (grant === 'refresh_token') {
        const token = form.get('refresh_token') ?? '';
        if (token !== state.current.refresh || state.used.has(token))
          return reply(400, { error: 'invalid_grant' });
        state.used.add(token);
        state.refreshes++;
        return reply(200, issue());
      }
    }
    if (url === 'https://auth.x.ai/oauth2/revoke') {
      state.revoked.push(form.get('token') ?? '');
      return reply(200, {});
    }
    if (url === 'https://api.x.ai/v1/chat/completions') {
      const auth = init.headers?.authorization ?? init.headers?.Authorization ?? '';
      if (auth !== `Bearer ${state.current.access}`) return reply(401, {});
      state.chats.push(auth);
      return reply(200, {
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    }
    throw new Error(`unexpected request to ${url}`);
  };
  return { fetch, state };
}

describe('xAI device flow protocol', () => {
  it('asks for a code with the public client and least-privilege scopes', async () => {
    const x = fakeXai();
    const code = await xaiProtocol.start(x.fetch);
    expect(code).toEqual({
      deviceCode: 'DEVICE-CODE-1',
      userCode: 'WDJB-MJHT',
      verificationUrl: 'https://accounts.x.ai/device?user_code=WDJB-MJHT',
      intervalSeconds: 5,
      expiresInSeconds: 600,
    });
    const form = new URLSearchParams(x.state.seen[0]!.body);
    expect(form.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828');
    expect(form.get('scope')?.split(' ').sort()).toEqual(
      ['api:access', 'email', 'grok-cli:access', 'offline_access', 'openid', 'profile'].sort(),
    );
  });

  it('only shows verification links on x.ai over https', async () => {
    for (const bad of [
      'https://evil.example/device',
      'http://accounts.x.ai/device',
      'https://x.ai.evil.example/device',
      'https://user:pw@accounts.x.ai/device',
      'javascript:alert(1)',
    ]) {
      const x = fakeXai();
      x.state.verificationUrl = bad;
      // The plain verification_uri is fine, so it's used instead of the bad complete one.
      expect((await xaiProtocol.start(x.fetch)).verificationUrl).toBe(
        'https://accounts.x.ai/device',
      );
    }
    expect(providerPage('https://evil.example/', 'x.ai')).toBeNull();
    expect(providerPage('https://x.ai/device', 'x.ai')).toBe('https://x.ai/device');
    expect(providerPage('https://notx.ai/device', 'x.ai')).toBeNull();
  });

  it('maps every polling answer, and parses tokens strictly', async () => {
    const x = fakeXai();
    expect(await xaiProtocol.poll(x.fetch, 'D')).toEqual({ status: 'pending' });
    x.state.slowDown = true;
    expect(await xaiProtocol.poll(x.fetch, 'D')).toEqual({ status: 'slow_down' });
    x.state.slowDown = false;
    x.state.denied = true;
    expect(await xaiProtocol.poll(x.fetch, 'D')).toEqual({ status: 'denied' });
    x.state.denied = false;
    x.state.approved = true;
    const done = await xaiProtocol.poll(x.fetch, 'D');
    expect(done).toMatchObject({
      status: 'done',
      tokens: {
        accessToken: canary('access', 1),
        refreshToken: canary('refresh', 1),
        account: 'alice@example.com',
      },
    });
    // A token with a line break would end up in a header: refused.
    const bad: OutboundFetch = async () => ({
      status: 200,
      headers: {},
      body: (async function* () {})(),
      text: async () => '',
      json: async () => ({ access_token: 'a\r\nInjected: 1', expires_in: 3600 }),
      cancel: () => undefined,
    });
    await expect(xaiProtocol.poll(bad, 'D')).rejects.toBeInstanceOf(SignInProviderError);
  });

  it('treats invalid_grant as "sign in again" and outages as temporary', async () => {
    const x = fakeXai();
    x.state.approved = true;
    await xaiProtocol.poll(x.fetch, 'D');
    await expect(xaiProtocol.refresh(x.fetch, 'not-the-token')).rejects.toBeInstanceOf(
      SignInExpiredError,
    );
    x.state.down = true;
    await expect(xaiProtocol.refresh(x.fetch, canary('refresh', 1))).rejects.toBeInstanceOf(
      SignInProviderError,
    );
  });

  it('reads the account from the ID token for display only, sanitised', () => {
    expect(accountFromIdToken(idToken({ email: 'bob@example.com' }))).toBe('bob@example.com');
    // A right-to-left override (built here so the source has no bidi character) is dropped.
    const rlo = String.fromCodePoint(0x202e);
    expect(accountFromIdToken(idToken({ name: `Bob${rlo}\n<b>` }))).toBe('Bob<b>');
    expect(accountFromIdToken('garbage')).toBeNull();
    expect(accountFromIdToken(undefined)).toBeNull();
  });
});

describe('SignInFlows', () => {
  const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 0, account: null };
  const scripted = (polls: Array<Awaited<ReturnType<SignInProtocol['poll']>>>) => {
    let calls = 0;
    const protocol: SignInProtocol = {
      start: async () => ({
        deviceCode: 'D',
        userCode: 'U',
        verificationUrl: 'https://accounts.x.ai/device',
        intervalSeconds: 5,
        expiresInSeconds: 600,
      }),
      poll: async () => {
        calls++;
        return polls.shift() ?? { status: 'pending' };
      },
      refresh: async () => tokens,
      revoke: async () => undefined,
    };
    return { protocol, calls: () => calls };
  };

  it('keeps flows to their owner, paces the provider and honours slow_down', async () => {
    let now = 1_000_000;
    const s = scripted([{ status: 'slow_down' }, { status: 'done', tokens }]);
    const flows = new SignInFlows(
      () =>
        (async () => {
          throw new Error('no network');
        }) as OutboundFetch,
      { 'xai-subscription': s.protocol },
      () => now,
    );
    const { flowId } = await flows.start('alice', 'xai-subscription', null);
    expect(await flows.poll('bob', flowId)).toBeNull();
    expect(flows.cancel('bob', flowId)).toBe(false);
    expect(await flows.poll('alice', flowId)).toEqual({ status: 'pending' }); // slow_down
    expect(s.calls()).toBe(1);
    // Too early (now 10 s apart): answered without asking the provider.
    now += 5000;
    expect(await flows.poll('alice', flowId)).toEqual({ status: 'pending' });
    expect(s.calls()).toBe(1);
    now += 5000;
    expect(await flows.poll('alice', flowId)).toMatchObject({
      status: 'done',
      provider: 'xai-subscription',
    });
    expect(await flows.poll('alice', flowId)).toBeNull();
  });

  it("expires flows, and a new start replaces the user's old one", async () => {
    let now = 0;
    const s = scripted([]);
    const flows = new SignInFlows(
      () =>
        (async () => {
          throw new Error('no network');
        }) as OutboundFetch,
      { 'xai-subscription': s.protocol },
      () => now,
    );
    const first = await flows.start('alice', 'xai-subscription', null);
    const second = await flows.start('alice', 'xai-subscription', null);
    expect(await flows.poll('alice', first.flowId)).toBeNull();
    now += 600_000;
    expect(await flows.poll('alice', second.flowId)).toEqual({ status: 'expired' });
  });
});

const PASSWORD = 'violin-pancake-orbit-meadow';

describe.skipIf(!TEST_DATABASE_URL)('subscription sign-in (app)', () => {
  let t: TestApp;
  let x: ReturnType<typeof fakeXai>;
  const responses: string[] = [];

  async function person(name: string, isAdmin = false) {
    const id = await createUser(t.db, { username: name, password: PASSWORD, isAdmin });
    const client = new Client(t.app);
    await client.login(name, PASSWORD);
    const request = client.request.bind(client);
    client.request = async (opts) => {
      const res = await request(opts);
      responses.push(res.body);
      return res;
    };
    return { id, http: client };
  }
  const settings = (patch: Parameters<TestApp['app']['services']['settings']['update']>[0]) =>
    t.app.services.settings.update(patch, { userId: null, ip: null });

  /** Sign alice in all the way; returns the credential. */
  async function signIn(client: Client, credentialId?: string) {
    const start = await client.post(
      '/api/v1/ai/sign-in/xai-subscription/start',
      credentialId ? { credentialId } : {},
    );
    expect(start.statusCode).toBe(200);
    const { flowId, userCode, verificationUrl } = start.json();
    expect(userCode).toBe('WDJB-MJHT');
    expect(verificationUrl).toMatch(/^https:\/\/accounts\.x\.ai\//);
    x.state.approved = true;
    const res = await client.post(`/api/v1/ai/sign-in/flows/${flowId}/poll`);
    expect(res.json().status).toBe('done');
    x.state.approved = false;
    return res.json().credential as { id: string; label: string; hasKey: boolean; scope: string };
  }

  beforeEach(async () => {
    responses.length = 0;
    x = fakeXai();
    t = await testApp({ aiUserFetch: x.fetch });
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  });
  afterEach(async () => {
    for (const body of responses) expect(body).not.toContain('SIGNINCANARY');
    await t.close();
  });

  it('is off until the admin enables it, personal only, and keeps tokens encrypted and write-only', async () => {
    const alice = await person('alice');
    const root = await person('root', true);
    expect(
      (await alice.http.post('/api/v1/ai/sign-in/xai-subscription/start', {})).statusCode,
    ).toBe(403);
    await settings({ 'ai.subscriptionSignIn': true });
    expect((await alice.http.get('/api/v1/ai/catalog')).json().policy.signIn).toBe(true);
    // Never through the key form, and never as an instance credential.
    expect(
      (
        await alice.http.post('/api/v1/ai/credentials', {
          provider: 'xai-subscription',
          label: 'x',
          apiKey: 'k',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await root.http.post('/api/v1/admin/ai/credentials', {
          provider: 'xai-subscription',
          label: 'x',
        })
      ).statusCode,
    ).toBe(400);
    expect((await alice.http.post('/api/v1/ai/sign-in/unknown/start', {})).statusCode).toBe(404);

    const cred = await signIn(alice.http);
    expect(cred).toMatchObject({ scope: 'user', hasKey: true, label: 'Grok (alice@example.com)' });
    const [row] = await t.db.db.select().from(aiCredentials).where(eq(aiCredentials.id, cred.id));
    expect(JSON.stringify(row)).not.toContain('SIGNINCANARY');
    expect(JSON.stringify(await t.db.db.select().from(auditLog))).not.toContain('SIGNINCANARY');
    expect((await root.http.get('/api/v1/admin/ai/credentials')).json().credentials).toHaveLength(
      0,
    );

    // Only a rename is possible; keys and addresses aren't.
    expect(
      (await alice.http.patch(`/api/v1/ai/credentials/${cred.id}`, { apiKey: 'k' })).statusCode,
    ).toBe(400);
    expect(
      (await alice.http.patch(`/api/v1/ai/credentials/${cred.id}`, { label: 'Mine' })).json().label,
    ).toBe('Mine');
  }, 30_000);

  it('keeps flows and credentials to their owner', async () => {
    await settings({ 'ai.subscriptionSignIn': true });
    const alice = await person('alice');
    const bob = await person('bob');
    const start = (await alice.http.post('/api/v1/ai/sign-in/xai-subscription/start', {})).json();
    expect((await bob.http.post(`/api/v1/ai/sign-in/flows/${start.flowId}/poll`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await bob.http.request({
          method: 'DELETE',
          url: `/api/v1/ai/sign-in/flows/${start.flowId}`,
        })
      ).statusCode,
    ).toBe(404);
    await alice.http.request({ method: 'DELETE', url: `/api/v1/ai/sign-in/flows/${start.flowId}` });
    const cred = await signIn(alice.http);
    // Bob can't sign in "again" into alice's credential.
    expect(
      (await bob.http.post('/api/v1/ai/sign-in/xai-subscription/start', { credentialId: cred.id }))
        .statusCode,
    ).toBe(404);
  }, 30_000);

  it('renews tokens once before a call, ends on invalid_grant, and signs in again in place', async () => {
    await settings({ 'ai.subscriptionSignIn': true });
    const alice = await person('alice');
    const cred = await signIn(alice.http);
    expect(
      (
        await alice.http.put('/api/v1/ai/routing', {
          'assist.task': { credentialId: cred.id, model: 'grok-4' },
        })
      ).statusCode,
    ).toBe(200);
    const user = { id: alice.id, isAdmin: false };
    const ask = () =>
      t.app.services.ai.chat(user, 'assist.task', {
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 10,
      });

    expect((await ask()).text).toBe('OK');
    expect(x.state.refreshes).toBe(0);

    // A sign-in whose token is about to expire: two calls at once renew it once (the provider
    // rotates refresh tokens, so a second renewal with the old one would end the sign-in).
    x.state.expiresIn = 60;
    await signIn(alice.http, cred.id);
    x.state.expiresIn = 3600;
    const [a, b] = await Promise.all([ask(), ask()]);
    expect([a.text, b.text]).toEqual(['OK', 'OK']);
    expect(x.state.refreshes).toBe(1);
    expect(x.state.chats.at(-1)).toBe(`Bearer ${x.state.current.access}`);

    // The keep-alive job renews sign-ins idle for days.
    const later = new Date(Date.now() + 4 * 86_400_000);
    expect(await t.app.services.ai.renewIdleSignIns(later, 3 * 86_400_000)).toBe(1);
    expect(x.state.refreshes).toBe(2);
    expect(await t.app.services.ai.renewIdleSignIns(new Date(), 3 * 86_400_000)).toBe(0);

    // The provider forgets the grant (revoked elsewhere): the next renewal ends the sign-in.
    x.state.current.refresh = 'rotated-away';
    expect(await t.app.services.ai.renewIdleSignIns(later, 3 * 86_400_000)).toBe(0);
    const listed = (await alice.http.get('/api/v1/ai/credentials')).json().credentials;
    expect(listed[0]).toMatchObject({ id: cred.id, hasKey: false });
    await expect(ask()).rejects.toThrow();

    // Signing in again keeps the id (and so the route).
    const again = await signIn(alice.http, cred.id);
    expect(again).toMatchObject({ id: cred.id, hasKey: true });
    expect((await ask()).text).toBe('OK');

    // Switched off by the admin: the credential stops being used.
    await settings({ 'ai.subscriptionSignIn': false });
    expect((await alice.http.get('/api/v1/ai/catalog')).json().available).not.toContain(
      'assist.task',
    );
  }, 60_000);

  it('revokes the sign-in at the provider when the credential is removed', async () => {
    await settings({ 'ai.subscriptionSignIn': true });
    const alice = await person('alice');
    const cred = await signIn(alice.http);
    const del = await alice.http.request({
      method: 'DELETE',
      url: `/api/v1/ai/credentials/${cred.id}`,
    });
    expect(del.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(x.state.revoked).toEqual([x.state.current.refresh]);
  }, 30_000);
});
