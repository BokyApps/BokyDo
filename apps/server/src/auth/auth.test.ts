import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, sessions, users } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
let t: TestApp;
let client: Client;

beforeEach(async () => {
  t = await testApp();
  await createUser(t.db, { username: 'Alice', password: PASSWORD });
  client = new Client(t.app);
});
afterEach(async () => t.close());

const failedLogins = async () =>
  (await t.db.db.select().from(auditLog).where(eq(auditLog.action, 'auth.login_failed'))).length;

describe.skipIf(!TEST_DATABASE_URL)('login', () => {
  it('creates an HttpOnly, SameSite=Lax session cookie and never returns the token', async () => {
    const res = await client.login('alice', PASSWORD); // usernames are case-insensitive
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'bokydo_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');
    expect(res.body).not.toContain(cookie.value);
    expect(res.json().user).toMatchObject({ username: 'Alice', isAdmin: false });
    // Only an HMAC of the token is stored.
    const [row] = await t.db.db.select().from(sessions);
    expect(row!.id).not.toBe(cookie.value);
  });

  it('gives identical answers for a wrong password and an unknown user', async () => {
    const wrong = await client.login('alice', 'nope-nope-nope-nope');
    const unknown = await client.login('mallory', 'nope-nope-nope-nope');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(await failedLogins()).toBe(2);
  });

  it('backs off after repeated failures, even for the right password', async () => {
    for (let i = 0; i < 6; i++) await client.login('alice', 'wrong-wrong-wrong');
    const res = await client.login('alice', PASSWORD);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rejects disabled users', async () => {
    await t.db.db.update(users).set({ disabledAt: new Date() }).where(eq(users.username, 'Alice'));
    expect((await client.login('alice', PASSWORD)).statusCode).toBe(401);
  });

  it('rejects login CSRF: missing or foreign Origin', async () => {
    client.origin = null;
    expect((await client.login('alice', PASSWORD)).json()).toEqual({ error: 'csrf_failed' });
    client.origin = 'https://evil.example';
    expect((await client.login('alice', PASSWORD)).json()).toEqual({ error: 'csrf_failed' });
  });

  it('rejects oversized and malformed credentials before hashing', async () => {
    expect((await client.login('alice', 'x'.repeat(10_000))).statusCode).toBe(400);
    expect((await client.post('/api/v1/auth/login', { username: ['alice'] })).statusCode).toBe(400);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('sessions', () => {
  it('requires the CSRF token for state changes', async () => {
    await client.login('alice', PASSWORD);
    expect((await client.post('/api/v1/auth/logout', undefined, { csrf: false })).json()).toEqual({
      error: 'csrf_failed',
    });
    const other = new Client(t.app);
    await other.login('alice', PASSWORD);
    // Another session's token must not work either.
    const res = await client.post('/api/v1/auth/logout', undefined, {
      headers: { 'x-csrf-token': other.csrfToken! },
    });
    expect(res.json()).toEqual({ error: 'csrf_failed' });
  });

  it('logout kills the session server-side', async () => {
    await client.login('alice', PASSWORD);
    const stolen = new Map(client.cookies);
    expect((await client.post('/api/v1/auth/logout')).statusCode).toBe(204);
    client.cookies = stolen;
    expect((await client.get('/api/v1/auth/session')).statusCode).toBe(401);
  });

  it('expires sessions', async () => {
    await client.login('alice', PASSWORD);
    await t.db.db.update(sessions).set({ idleExpiresAt: new Date(Date.now() - 1000) });
    expect((await client.get('/api/v1/auth/session')).statusCode).toBe(401);
    expect(await t.db.db.select().from(sessions)).toHaveLength(0);
  });

  it('ignores forged and garbage cookies', async () => {
    for (const value of ['x', 'a'.repeat(43), 'a'.repeat(5000)]) {
      client.cookies.set('bokydo_session', value);
      expect((await client.get('/api/v1/auth/session')).statusCode).toBe(401);
    }
  });

  it('uses __Host- Secure cookies once the public URL is HTTPS', async () => {
    await t.app.services.settings.update(
      { 'instance.publicUrl': 'https://bokydo.test' },
      { userId: (await t.db.db.select().from(users))[0]!.id, ip: null },
    );
    client.origin = 'https://bokydo.test';
    const res = await client.login('alice', PASSWORD);
    const cookie = res.cookies.find((c) => c.name === '__Host-bokydo_session')!;
    expect(cookie.secure).toBe(true);
    expect(cookie.domain).toBeUndefined();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('password change', () => {
  beforeEach(async () => {
    await createUser(t.db, { username: 'newbie', password: PASSWORD, mustChangePassword: true });
  });

  it('confines a must-change user to the password screen', async () => {
    // Routes must be added before the first request.
    t.app.get(
      '/api/v1/test-user',
      { config: { access: 'user', setup: 'always' } },
      async () => ({}),
    );
    await client.login('newbie', PASSWORD);
    expect((await client.get('/api/v1/auth/session')).statusCode).toBe(200);
    // Other routes are refused with a specific code the UI can act on.
    expect((await client.get('/api/v1/test-user')).json()).toEqual({
      error: 'password_change_required',
    });
  });

  it('changes the password, clears the flag and rotates every session', async () => {
    await client.login('newbie', PASSWORD);
    const elsewhere = new Client(t.app);
    await elsewhere.login('newbie', PASSWORD);
    const oldCookies = new Map(client.cookies);

    const res = await client.post('/api/v1/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'quartz-lantern-gravel-ribbon',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.mustChangePassword).toBe(false);
    expect((await client.get('/api/v1/auth/session')).statusCode).toBe(200);
    expect((await elsewhere.get('/api/v1/auth/session')).statusCode).toBe(401);
    const replay = new Client(t.app);
    replay.cookies = oldCookies;
    expect((await replay.get('/api/v1/auth/session')).statusCode).toBe(401);

    expect((await new Client(t.app).login('newbie', PASSWORD)).statusCode).toBe(401);
    expect(
      (await new Client(t.app).login('newbie', 'quartz-lantern-gravel-ribbon')).statusCode,
    ).toBe(200);
  });

  it('requires the current password and enforces the policy', async () => {
    await client.login('newbie', PASSWORD);
    const wrong = await client.post('/api/v1/auth/password', {
      currentPassword: 'not-it-at-all',
      newPassword: 'quartz-lantern-gravel-ribbon',
    });
    expect(wrong.statusCode).toBe(403);
    for (const [newPassword, problem] of [
      ['short', 'too_short'],
      [PASSWORD, 'same_as_current'],
      ['newbie-forever-and-ever', 'contains_username'],
    ]) {
      const res = await client.post('/api/v1/auth/password', {
        currentPassword: PASSWORD,
        newPassword,
      });
      expect(res.json()).toEqual({ error: 'weak_password', message: problem });
    }
  });
});
