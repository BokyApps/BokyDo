import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authFlows, sessions, users } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { totpCode, totpStep } from './totp.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
let t: TestApp;
let alice: Client;

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  await createUser(t.db, { username: 'alice', password: PASSWORD });
  alice = new Client(t.app);
  await alice.login('alice', PASSWORD);
});
afterEach(async () => t.close());

const code = (secret: string, offset = 0) => totpCode(secret, totpStep(Date.now()) + offset);

/** Enrol alice in TOTP; returns the secret and recovery codes. */
async function enrolTotp(client = alice): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await client.post('/api/v1/account/totp/setup');
  expect(setup.statusCode).toBe(200);
  const { secret, qrCode, otpauthUrl } = setup.json();
  expect(qrCode).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(otpauthUrl).toContain(`secret=${secret}`);
  const confirm = await client.post('/api/v1/account/totp/confirm', { code: code(secret) });
  expect(confirm.statusCode).toBe(200);
  return { secret, recoveryCodes: confirm.json().recoveryCodes };
}

describe.skipIf(!TEST_DATABASE_URL)('TOTP enrolment', () => {
  it('needs recent authentication, a correct code, and hands out 10 recovery codes', async () => {
    await t.db.db.update(sessions).set({ reauthenticatedAt: new Date(Date.now() - 60 * 60_000) });
    expect((await alice.post('/api/v1/account/totp/setup')).json()).toEqual({
      error: 'reauth_required',
    });
    expect(
      (await alice.post('/api/v1/auth/reauth', { password: 'wrong-wrong-wrong' })).statusCode,
    ).toBe(403);
    expect((await alice.post('/api/v1/auth/reauth', { password: PASSWORD })).statusCode).toBe(204);

    const setup = (await alice.post('/api/v1/account/totp/setup')).json();
    expect((await alice.post('/api/v1/account/totp/confirm', { code: '000000' })).statusCode).toBe(
      400,
    );
    const confirm = await alice.post('/api/v1/account/totp/confirm', { code: code(setup.secret) });
    expect(confirm.json().recoveryCodes).toHaveLength(10);
    const security = (await alice.get('/api/v1/account/security')).json();
    expect(security).toMatchObject({ totpEnabled: true, recoveryCodesRemaining: 10 });

    // The secret is stored encrypted.
    const [row] = await t.db.db.select().from(users).where(eq(users.username, 'alice'));
    expect(JSON.stringify(row!.totpSecret)).not.toContain(setup.secret);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('signing in with TOTP', () => {
  let secret: string;
  let recoveryCodes: string[];
  beforeEach(async () => {
    ({ secret, recoveryCodes } = await enrolTotp());
  });

  it('a password alone gives no session, only an MFA step', async () => {
    const c = new Client(t.app);
    const res = await c.login('alice', PASSWORD);
    expect(res.json()).toEqual({ mfaRequired: true, methods: ['totp', 'recovery'] });
    expect(res.cookies.find((x) => x.name === 'bokydo_session')).toBeUndefined();
    const flowCookie = res.cookies.find((x) => x.name === 'bokydo_flow')!;
    expect(flowCookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth' });
    // The flow cookie is not a session.
    expect((await c.get('/api/v1/auth/session')).statusCode).toBe(401);
    expect((await c.post('/api/v1/sync', {})).statusCode).toBe(401);
  });

  it('accepts a valid code once, never twice (including the one used to enrol)', async () => {
    const c = new Client(t.app);
    await c.login('alice', PASSWORD);
    // The enrolment code was this step's code, so it's already spent.
    expect((await c.post('/api/v1/auth/mfa/totp', { code: code(secret) })).json()).toEqual({
      error: 'invalid_code',
    });
    // The next step's code (within the clock-drift window) works...
    const next = code(secret, 1);
    const ok = await c.post('/api/v1/auth/mfa/totp', { code: next });
    expect(ok.json()).toMatchObject({ authMethod: 'password+totp', user: { username: 'alice' } });

    // ...exactly once, and older codes stay dead.
    const replay = new Client(t.app);
    await replay.login('alice', PASSWORD);
    expect((await replay.post('/api/v1/auth/mfa/totp', { code: next })).json()).toEqual({
      error: 'invalid_code',
    });
    expect((await replay.post('/api/v1/auth/mfa/totp', { code: code(secret) })).json()).toEqual({
      error: 'invalid_code',
    });
  });

  it('refuses MFA without a password step, with a reused flow, or with an expired one', async () => {
    expect(
      (await new Client(t.app).post('/api/v1/auth/mfa/totp', { code: code(secret) })).json(),
    ).toEqual({
      error: 'mfa_flow_expired',
    });

    const c = new Client(t.app);
    await c.login('alice', PASSWORD);
    const flowCookie = c.cookies.get('bokydo_flow')!;
    expect((await c.post('/api/v1/auth/mfa/recovery', { code: recoveryCodes[0] })).statusCode).toBe(
      200,
    );
    const reuse = new Client(t.app);
    reuse.cookies.set('bokydo_flow', flowCookie);
    expect(
      (await reuse.post('/api/v1/auth/mfa/recovery', { code: recoveryCodes[1] })).json(),
    ).toEqual({ error: 'mfa_flow_expired' });

    const late = new Client(t.app);
    await late.login('alice', PASSWORD);
    await t.db.db.update(authFlows).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await late.post('/api/v1/auth/mfa/totp', { code: code(secret, 1) })).json()).toEqual({
      error: 'mfa_flow_expired',
    });
  });

  it('burns the flow after five wrong codes', async () => {
    const c = new Client(t.app);
    await c.login('alice', PASSWORD);
    for (let i = 0; i < 5; i++)
      expect((await c.post('/api/v1/auth/mfa/totp', { code: '000001' })).statusCode).toBe(401);
    expect((await c.post('/api/v1/auth/mfa/totp', { code: code(secret) })).statusCode).toBe(429);
    expect((await c.post('/api/v1/auth/mfa/totp', { code: code(secret) })).json()).toEqual({
      error: 'mfa_flow_expired',
    });
  });

  it('recovery codes work exactly once, even when raced', async () => {
    const [a, b] = [new Client(t.app), new Client(t.app)];
    await a.login('alice', PASSWORD);
    await b.login('alice', PASSWORD);
    const results = await Promise.all([
      a.post('/api/v1/auth/mfa/recovery', { code: recoveryCodes[0] }),
      b.post('/api/v1/auth/mfa/recovery', { code: recoveryCodes[0]!.toLowerCase() }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const winner = results.find((r) => r.statusCode === 200)!;
    expect(winner.json().authMethod).toBe('password+recovery');
  });

  it('disabling TOTP needs recent auth and respects the MFA policy', async () => {
    await t.app.services.settings.update(
      { 'security.mfaEnforcement': 'everyone' },
      { userId: null, ip: null },
    );
    expect((await alice.post('/api/v1/account/totp/disable')).json()).toEqual({
      error: 'conflict',
      message: 'mfa_required',
    });
    await t.app.services.settings.update(
      { 'security.mfaEnforcement': 'off' },
      { userId: null, ip: null },
    );
    expect((await alice.post('/api/v1/account/totp/disable')).statusCode).toBe(204);
    expect((await new Client(t.app).login('alice', PASSWORD)).json().user.username).toBe('alice');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('MFA enforcement', () => {
  it('confines users without a second factor to enrolment until they set one up', async () => {
    await t.app.services.settings.update(
      { 'security.mfaEnforcement': 'everyone' },
      { userId: null, ip: null },
    );
    const c = new Client(t.app);
    const res = await c.login('alice', PASSWORD);
    expect(res.json().user.mustEnrollMfa).toBe(true);
    expect((await c.post('/api/v1/sync', {})).json()).toEqual({ error: 'mfa_enrollment_required' });
    await enrolTotp(c);
    expect((await c.get('/api/v1/auth/session')).json().user.mustEnrollMfa).toBe(false);
    expect((await c.post('/api/v1/sync', {})).statusCode).toBe(200);
  });

  it('applies to admins only when set to admins', async () => {
    await t.app.services.settings.update(
      { 'security.mfaEnforcement': 'admins' },
      { userId: null, ip: null },
    );
    await createUser(t.db, { username: 'root', password: PASSWORD, isAdmin: true });
    expect((await new Client(t.app).login('root', PASSWORD)).json().user.mustEnrollMfa).toBe(true);
    expect((await new Client(t.app).login('alice', PASSWORD)).json().user.mustEnrollMfa).toBe(
      false,
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)('sessions list', () => {
  it('lists, revokes one, and revokes all others', async () => {
    const phone = new Client(t.app);
    await phone.login('alice', PASSWORD);
    const tablet = new Client(t.app);
    await tablet.login('alice', PASSWORD);
    const list = (await alice.get('/api/v1/account/sessions')).json();
    expect(list).toHaveLength(3);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/csrf/i);

    const phoneId = (await phone.get('/api/v1/account/sessions'))
      .json()
      .find((s: { current: boolean }) => s.current).id;
    expect(
      (await alice.request({ method: 'DELETE', url: `/api/v1/account/sessions/${phoneId}` }))
        .statusCode,
    ).toBe(204);
    expect((await phone.get('/api/v1/auth/session')).statusCode).toBe(401);

    expect((await alice.post('/api/v1/account/sessions/revoke-others')).statusCode).toBe(204);
    expect((await tablet.get('/api/v1/auth/session')).statusCode).toBe(401);
    expect((await alice.get('/api/v1/auth/session')).statusCode).toBe(200);
  });

  it('cannot revoke another user’s session', async () => {
    await createUser(t.db, { username: 'bob', password: PASSWORD });
    const bob = new Client(t.app);
    await bob.login('bob', PASSWORD);
    const bobId = (await bob.get('/api/v1/account/sessions')).json()[0].id;
    expect(
      (await alice.request({ method: 'DELETE', url: `/api/v1/account/sessions/${bobId}` }))
        .statusCode,
    ).toBe(404);
    expect((await bob.get('/api/v1/auth/session')).statusCode).toBe(200);
  });
});
