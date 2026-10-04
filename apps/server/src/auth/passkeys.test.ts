import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webauthnCredentials } from '../db/schema.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
const ORIGIN = 'https://bokydo.test';
const RP_ID = 'bokydo.test';
let t: TestApp;
let alice: Client;
let aliceId: string;
let key: SoftAuthenticator;

const handleOf = (userId: string) => Buffer.from(userId.replace(/-/g, ''), 'hex');

async function registerPasskey(client: Client, authenticator: SoftAuthenticator, name = 'Laptop') {
  const options = (await client.post('/api/v1/account/passkeys/options')).json();
  return client.post('/api/v1/account/passkeys', {
    response: authenticator.register(options),
    name,
  });
}

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.update(
    { 'instance.publicUrl': ORIGIN },
    { userId: null, ip: null },
  );
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  aliceId = await createUser(t.db, { username: 'alice', password: PASSWORD });
  alice = new Client(t.app, ORIGIN);
  await alice.login('alice', PASSWORD);
  key = new SoftAuthenticator(RP_ID, ORIGIN, handleOf(aliceId));
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('passkey registration', () => {
  it('registers a passkey, stores only the public key, and issues recovery codes', async () => {
    const res = await registerPasskey(alice, key);
    expect(res.statusCode).toBe(200);
    expect(res.json().recoveryCodes).toHaveLength(10);
    const security = (await alice.get('/api/v1/account/security')).json();
    expect(security.passkeys).toEqual([expect.objectContaining({ id: key.id, name: 'Laptop' })]);
    expect(JSON.stringify(security)).not.toMatch(/publicKey/);
  });

  it('rejects a registration for another origin or RP, and duplicate credentials', async () => {
    for (const bad of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }]) {
      const options = (await alice.post('/api/v1/account/passkeys/options')).json();
      const res = await alice.post('/api/v1/account/passkeys', {
        response: key.register(options, bad),
        name: 'x',
      });
      expect(res.json(), JSON.stringify(bad)).toEqual({ error: 'invalid_passkey' });
    }
    expect((await registerPasskey(alice, key)).statusCode).toBe(200);
    expect((await registerPasskey(alice, key)).statusCode).toBe(409);
  });

  it('cannot replay a registration challenge', async () => {
    const options = (await alice.post('/api/v1/account/passkeys/options')).json();
    const response = key.register(options);
    expect((await alice.post('/api/v1/account/passkeys', { response, name: 'a' })).statusCode).toBe(
      200,
    );
    const other = new SoftAuthenticator(RP_ID, ORIGIN);
    expect(
      (
        await alice.post('/api/v1/account/passkeys', {
          response: other.register(options),
          name: 'b',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('is unavailable without an HTTPS public URL', async () => {
    await t.app.services.settings.update(
      { 'instance.publicUrl': 'http://192.168.1.10:8080' },
      { userId: null, ip: null },
    );
    alice.origin = 'http://192.168.1.10:8080';
    expect((await alice.post('/api/v1/account/passkeys/options')).json()).toEqual({
      error: 'passkeys_unavailable',
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('signing in with a passkey', () => {
  beforeEach(async () => {
    expect((await registerPasskey(alice, key)).statusCode).toBe(200);
  });

  async function passwordless(
    assertOpts: Parameters<SoftAuthenticator['assert']>[1] = {},
    authenticator = key,
  ) {
    const c = new Client(t.app, ORIGIN);
    const options = (await c.post('/api/v1/auth/passkey/options')).json();
    expect(options.userVerification).toBe('required');
    return {
      c,
      res: await c.post('/api/v1/auth/passkey', {
        response: authenticator.assert(options, assertOpts),
      }),
    };
  }

  it('passwordless sign-in works with user verification', async () => {
    const { res } = await passwordless();
    expect(res.json()).toMatchObject({ authMethod: 'passkey', user: { username: 'alice' } });
  });

  it('rejects missing user verification, wrong origin, wrong RP, wrong user handle', async () => {
    for (const bad of [
      { userVerified: false },
      { origin: 'https://evil.example' },
      { rpId: 'evil.example' },
      { userHandle: handleOf('00000000-0000-4000-8000-000000000000') },
    ]) {
      expect((await passwordless(bad)).res.json(), JSON.stringify(bad)).toEqual({
        error: 'invalid_credentials',
      });
    }
  });

  it('detects a cloned authenticator (signature counter going backwards)', async () => {
    expect((await passwordless({ counter: 10 })).res.statusCode).toBe(200);
    expect((await passwordless({ counter: 5 })).res.json()).toEqual({
      error: 'invalid_credentials',
    });
  });

  it('cannot replay an assertion', async () => {
    const c = new Client(t.app, ORIGIN);
    const options = (await c.post('/api/v1/auth/passkey/options')).json();
    const response = key.assert(options);
    expect((await c.post('/api/v1/auth/passkey', { response })).statusCode).toBe(200);
    const attacker = new Client(t.app, ORIGIN);
    attacker.cookies.set('bokydo_flow', c.cookies.get('bokydo_flow') ?? 'x'.repeat(43));
    expect((await attacker.post('/api/v1/auth/passkey', { response })).statusCode).toBe(401);
  });

  it('works as a second factor after the password, but not with another user’s passkey', async () => {
    const c = new Client(t.app, ORIGIN);
    expect((await c.login('alice', PASSWORD)).json().methods).toEqual(['passkey', 'recovery']);
    const options = (await c.post('/api/v1/auth/mfa/passkey/options')).json();
    expect(options.allowCredentials).toEqual([expect.objectContaining({ id: key.id })]);

    await createUser(t.db, { username: 'mallory', password: PASSWORD });
    const mallory = new Client(t.app, ORIGIN);
    await mallory.login('mallory', PASSWORD);
    const malloryKey = new SoftAuthenticator(RP_ID, ORIGIN);
    expect((await registerPasskey(mallory, malloryKey)).statusCode).toBe(200);
    expect(
      (await c.post('/api/v1/auth/mfa/passkey', { response: malloryKey.assert(options) })).json(),
    ).toEqual({
      error: 'invalid_code',
    });

    const ok = await c.post('/api/v1/auth/mfa/passkey', {
      response: key.assert(options, { userVerified: false }),
    });
    expect(ok.json()).toMatchObject({ authMethod: 'password+passkey' });
  });

  it('re-authenticates with a passkey for sensitive changes', async () => {
    const options = (await alice.post('/api/v1/auth/reauth/passkey/options')).json();
    expect(
      (await alice.post('/api/v1/auth/reauth/passkey', { response: key.assert(options) }))
        .statusCode,
    ).toBe(204);
  });

  it('counts a passkey as satisfying the MFA policy', async () => {
    await t.app.services.settings.update(
      { 'security.mfaEnforcement': 'everyone' },
      { userId: null, ip: null },
    );
    expect((await alice.get('/api/v1/auth/session')).json().user.mustEnrollMfa).toBe(false);
    expect((await alice.post('/api/v1/sync', {})).statusCode).toBe(200);
  });

  it('keeps the last factor when the policy requires MFA', async () => {
    await t.app.services.settings.update(
      { 'security.mfaEnforcement': 'everyone' },
      { userId: null, ip: null },
    );
    const res = await alice.request({
      method: 'DELETE',
      url: `/api/v1/account/passkeys/${key.id}`,
    });
    expect(res.json()).toEqual({ error: 'conflict', message: 'mfa_required' });
    await t.app.services.settings.update(
      { 'security.mfaEnforcement': 'off' },
      { userId: null, ip: null },
    );
    expect(
      (await alice.request({ method: 'DELETE', url: `/api/v1/account/passkeys/${key.id}` }))
        .statusCode,
    ).toBe(204);
    expect(
      await t.db.db
        .select()
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, aliceId)),
    ).toHaveLength(0);
  });
});
