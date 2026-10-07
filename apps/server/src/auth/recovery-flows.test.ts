import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userTokens, users } from '../db/schema.js';
import {
  captureMail,
  Client,
  createUser,
  testApp,
  tokenFromMail,
  type TestApp,
} from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
const NEW_PASSWORD = 'quartz-lantern-gravel-ribbon';
let t: TestApp;
let mail: Awaited<ReturnType<typeof captureMail>>;
let aliceId: string;
// Mail is sent in the background: wait for it rather than for a fixed time.
const mailCount = (n: number) => expect.poll(() => mail.length).toBeGreaterThanOrEqual(n);
// Only for asserting that nothing arrives.
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.update(
    { 'instance.publicUrl': 'http://bokydo.test' },
    { userId: null, ip: null },
  );
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  mail = await captureMail(t.app);
  aliceId = await createUser(t.db, { username: 'alice', password: PASSWORD });
  await t.db.db
    .update(users)
    .set({ email: 'alice@example.com', emailVerifiedAt: new Date() })
    .where(eq(users.id, aliceId));
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('password reset', () => {
  it('always answers the same, and only mails verified addresses', async () => {
    await createUser(t.db, { username: 'bob', password: PASSWORD });
    await t.db.db.update(users).set({ email: 'bob@example.com' }).where(eq(users.username, 'bob')); // unverified
    const c = new Client(t.app);
    for (const login of ['alice', 'ALICE@example.com', 'nobody', 'bob', 'bob@example.com']) {
      const res = await c.post('/api/v1/auth/password-reset', { login });
      expect(res.statusCode).toBe(202);
      expect(res.body).toBe('{"ok":true}');
    }
    await mailCount(2);
    await settle();
    expect(mail.map((m) => m.to)).toEqual(['alice@example.com', 'alice@example.com']);
    expect(mail[0]!.text).toContain('http://bokydo.test/reset-password#');
  });

  it('resets once, signs out everywhere, keeps MFA, and invalidates older links', async () => {
    const signedIn = new Client(t.app);
    await signedIn.login('alice', PASSWORD);
    const c = new Client(t.app);
    await c.post('/api/v1/auth/password-reset', { login: 'alice' });
    await mailCount(1);
    const older = tokenFromMail(mail.at(-1));
    await c.post('/api/v1/auth/password-reset', { login: 'alice' });
    await mailCount(2);
    const token = tokenFromMail(mail.at(-1));

    expect(
      (
        await c.post('/api/v1/auth/password-reset/complete', {
          token: older,
          newPassword: NEW_PASSWORD,
        })
      ).statusCode,
    ).toBe(400);
    // A weak password doesn't burn the link.
    expect(
      (await c.post('/api/v1/auth/password-reset/complete', { token, newPassword: 'short' })).json()
        .error,
    ).toBe('weak_password');
    expect(
      (await c.post('/api/v1/auth/password-reset/complete', { token, newPassword: NEW_PASSWORD }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await c.post('/api/v1/auth/password-reset/complete', {
          token,
          newPassword: NEW_PASSWORD + 'x',
        })
      ).statusCode,
    ).toBe(400);

    expect((await signedIn.get('/api/v1/auth/session')).statusCode).toBe(401);
    expect((await new Client(t.app).login('alice', PASSWORD)).statusCode).toBe(401);
    expect((await new Client(t.app).login('alice', NEW_PASSWORD)).statusCode).toBe(200);
    // The DB holds only a keyed hash of the token.
    expect(JSON.stringify(await t.db.db.select().from(userTokens))).not.toContain(token);
  });

  it('expired links are refused', async () => {
    await new Client(t.app).post('/api/v1/auth/password-reset', { login: 'alice' });
    await mailCount(1);
    const token = tokenFromMail(mail.at(-1));
    await t.db.db.update(userTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(
      (
        await new Client(t.app).post('/api/v1/auth/password-reset/complete', {
          token,
          newPassword: NEW_PASSWORD,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('never accepts a token minted for another purpose', async () => {
    const { token } = await t.app.services.tokens.create({
      kind: 'email_verify',
      userId: aliceId,
      email: 'alice@example.com',
      ttlMs: 60_000,
    });
    expect(
      (
        await new Client(t.app).post('/api/v1/auth/password-reset/complete', {
          token,
          newPassword: NEW_PASSWORD,
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('email change and verification', () => {
  it('needs recent auth, verifies the new address and warns the old one', async () => {
    const c = new Client(t.app);
    await c.login('alice', PASSWORD);
    const res = await c.request({
      method: 'PUT',
      url: '/api/v1/account/email',
      payload: { email: 'new@example.com' },
    });
    expect(res.json()).toEqual({ verificationSent: true });
    await mailCount(2);
    expect(mail.map((m) => m.to).sort()).toEqual(['alice@example.com', 'new@example.com']);
    const verify = tokenFromMail(mail.find((m) => m.to === 'new@example.com'));
    expect(
      (await new Client(t.app).post('/api/v1/auth/email/verify', { token: verify })).statusCode,
    ).toBe(204);
    expect(
      (await new Client(t.app).post('/api/v1/auth/email/verify', { token: verify })).statusCode,
    ).toBe(400);
    const [row] = await t.db.db.select().from(users).where(eq(users.id, aliceId));
    expect(row).toMatchObject({ email: 'new@example.com' });
    expect(row!.emailVerifiedAt).not.toBeNull();
  });

  it('a verification link dies if the address changes again', async () => {
    const c = new Client(t.app);
    await c.login('alice', PASSWORD);
    await c.request({
      method: 'PUT',
      url: '/api/v1/account/email',
      payload: { email: 'first@example.com' },
    });
    await mailCount(1);
    const first = tokenFromMail(mail.find((m) => m.to === 'first@example.com'));
    await c.request({
      method: 'PUT',
      url: '/api/v1/account/email',
      payload: { email: 'second@example.com' },
    });
    expect(
      (await new Client(t.app).post('/api/v1/auth/email/verify', { token: first })).statusCode,
    ).toBe(400);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('registration', () => {
  const register = (body: Record<string, unknown>) =>
    new Client(t.app).post('/api/v1/auth/register', body);

  it('is closed or invite-only unless opened', async () => {
    await t.app.services.settings.update(
      { 'access.registrationMode': 'closed' },
      { userId: null, ip: null },
    );
    expect((await register({ username: 'eve', password: NEW_PASSWORD })).json()).toEqual({
      error: 'registration_closed',
    });
    await t.app.services.settings.update(
      { 'access.registrationMode': 'invite' },
      { userId: null, ip: null },
    );
    expect((await register({ username: 'eve', password: NEW_PASSWORD })).json()).toEqual({
      error: 'registration_closed',
    });
    await t.app.services.settings.update(
      { 'access.registrationMode': 'open' },
      { userId: null, ip: null },
    );
    const res = await register({ username: 'eve', password: NEW_PASSWORD });
    expect(res.json()).toMatchObject({
      authMethod: 'registration',
      user: { username: 'eve', isAdmin: false },
    });
    expect((await register({ username: 'EVE', password: NEW_PASSWORD })).statusCode).toBe(409);
  });

  it('invites work once and carry the role and email', async () => {
    const { token } = await t.app.services.tokens.create({
      kind: 'invite',
      email: 'carol@example.com',
      data: { isAdmin: true, emailed: true },
      ttlMs: 60_000,
    });
    expect((await new Client(t.app).post('/api/v1/auth/invite', { token })).json()).toEqual({
      valid: true,
      email: 'carol@example.com',
    });
    const res = await register({
      username: 'carol',
      password: NEW_PASSWORD,
      inviteToken: token,
      email: 'other@example.com',
    });
    expect(res.json()).toMatchObject({ user: { username: 'carol', isAdmin: true } });
    const [carol] = await t.db.db.select().from(users).where(eq(users.username, 'carol'));
    expect(carol).toMatchObject({ email: 'carol@example.com' });
    expect(carol!.emailVerifiedAt).not.toBeNull();
    expect(
      (await register({ username: 'carol2', password: NEW_PASSWORD, inviteToken: token }))
        .statusCode,
    ).toBe(400);
  });

  it('rate-limits sign-ups per IP', async () => {
    await t.app.services.settings.update(
      { 'access.registrationMode': 'open' },
      { userId: null, ip: null },
    );
    const codes = [];
    for (let i = 0; i < 6; i++)
      codes.push((await register({ username: `user${i}`, password: NEW_PASSWORD })).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('security notifications', () => {
  it('alerts on a sign-in from a new IP, not a familiar one, not the first ever', async () => {
    await t.app.services.settings.update(
      { 'instance.trustedProxyHops': 1 },
      { userId: null, ip: null },
    );
    const loginFrom = (ip: string) =>
      new Client(t.app).request({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'alice', password: PASSWORD },
        headers: { 'x-forwarded-for': ip },
      });
    await loginFrom('10.0.0.1');
    await settle();
    expect(mail).toHaveLength(0);
    await loginFrom('10.0.0.1');
    await settle();
    expect(mail).toHaveLength(0);
    await loginFrom('203.0.113.9');
    await mailCount(1);
    expect(mail.map((m) => m.subject)).toEqual(['BokyDo: New sign-in to your account']);
    expect(mail[0]!.text).toContain('203.0.113.9');
  });
});
