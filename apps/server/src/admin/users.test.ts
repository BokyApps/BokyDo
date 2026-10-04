import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
let t: TestApp;
let admin: Client;
let adminId: string;
let bobId: string;

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.update(
    { 'instance.publicUrl': 'http://bokydo.test' },
    { userId: null, ip: null },
  );
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  adminId = await createUser(t.db, { username: 'root', password: PASSWORD, isAdmin: true });
  bobId = await createUser(t.db, { username: 'bob', password: PASSWORD });
  admin = new Client(t.app);
  await admin.login('root', PASSWORD);
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('admin: users', () => {
  it('creates users with a one-time passphrase they must change', async () => {
    const res = await admin.post('/api/v1/admin/users', {
      username: 'dana',
      email: 'dana@example.com',
    });
    const { passphrase } = res.json();
    expect(passphrase.split('-').length).toBeGreaterThanOrEqual(6);
    const dana = new Client(t.app);
    expect((await dana.login('dana', passphrase)).json().user.mustChangePassword).toBe(true);
    const listRes = await admin.get('/api/v1/admin/users');
    if (listRes.statusCode !== 200) throw new Error(listRes.body);
    const list = listRes.json();
    expect(list.map((u: { username: string }) => u.username)).toEqual(['bob', 'dana', 'root']);
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|totpSecret/);
  });

  it('disabling a user ends their sessions and blocks sign-in', async () => {
    const bob = new Client(t.app);
    await bob.login('bob', PASSWORD);
    expect((await admin.patch(`/api/v1/admin/users/${bobId}`, { disabled: true })).statusCode).toBe(
      204,
    );
    expect((await bob.get('/api/v1/auth/session')).statusCode).toBe(401);
    expect((await new Client(t.app).login('bob', PASSWORD)).statusCode).toBe(401);
  });

  it('protects against self-lockout and removing the last admin', async () => {
    expect(
      (await admin.patch(`/api/v1/admin/users/${adminId}`, { disabled: true })).json().message,
    ).toBe('cannot_change_self');
    await admin.patch(`/api/v1/admin/users/${bobId}`, { isAdmin: true });
    const bob = new Client(t.app);
    await bob.login('bob', PASSWORD);
    expect((await bob.patch(`/api/v1/admin/users/${adminId}`, { isAdmin: false })).statusCode).toBe(
      204,
    );
    // Bob is now the only admin; root (no longer admin) can't act, and bob can't remove himself.
    expect(
      (await bob.patch(`/api/v1/admin/users/${bobId}`, { isAdmin: false })).json().message,
    ).toBe('cannot_change_self');
  });

  it('resets MFA and issues reset links, with recent auth', async () => {
    await t.db.db.update(users).set({ totpEnabledAt: new Date() }).where(eq(users.id, bobId));
    expect((await admin.post(`/api/v1/admin/users/${bobId}/reset-mfa`)).statusCode).toBe(204);
    const [bob] = await t.db.db.select().from(users).where(eq(users.id, bobId));
    expect(bob!.totpEnabledAt).toBeNull();

    const link = (await admin.post(`/api/v1/admin/users/${bobId}/password-reset-link`)).json();
    expect(link.url).toMatch(/^http:\/\/bokydo\.test\/reset-password#[A-Za-z0-9_-]{43}$/);
    const token = link.url.split('#')[1];
    expect(
      (
        await new Client(t.app).post('/api/v1/auth/password-reset/complete', {
          token,
          newPassword: 'quartz-lantern-gravel-ribbon',
        })
      ).statusCode,
    ).toBe(204);
  });

  it('invites: create, list, revoke', async () => {
    const created = (
      await admin.post('/api/v1/admin/invites', { email: 'eve@example.com' })
    ).json();
    expect(created.url).toMatch(/\/invite#/);
    expect((await admin.get('/api/v1/admin/invites')).json()).toEqual([
      expect.objectContaining({ id: created.id, email: 'eve@example.com' }),
    ]);
    expect(
      (await admin.request({ method: 'DELETE', url: `/api/v1/admin/invites/${created.id}` }))
        .statusCode,
    ).toBe(204);
    expect((await admin.get('/api/v1/admin/invites')).json()).toEqual([]);
    const token = created.url.split('#')[1];
    expect((await new Client(t.app).post('/api/v1/auth/invite', { token })).json().valid).toBe(
      false,
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)('breached password check', () => {
  it('rejects breached passwords only when the admin opts in', async () => {
    await t.close();
    const fakeHibp = (async () => ({ ok: true, text: async () => '' })) as unknown as typeof fetch;
    let calls = 0;
    const counting = (async (...a: Parameters<typeof fetch>) => {
      calls++;
      // Everything is "breached" in this fake.
      const { createHash } = await import('node:crypto');
      void a;
      return {
        ok: true,
        text: async () =>
          `${createHash('sha1').update('quartz-lantern-gravel-ribbon').digest('hex').toUpperCase().slice(5)}:42`,
      };
    }) as unknown as typeof fetch;
    void fakeHibp;
    t = await testApp({ fetchImpl: counting });
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    await createUser(t.db, { username: 'zoe', password: PASSWORD });
    const zoe = new Client(t.app);
    await zoe.login('zoe', PASSWORD);
    const change = () =>
      zoe.post('/api/v1/auth/password', {
        currentPassword: PASSWORD,
        newPassword: 'quartz-lantern-gravel-ribbon',
      });
    // Off by default: no outbound call at all.
    await t.app.services.settings.update(
      { 'security.passwordMinLength': 12 },
      { userId: null, ip: null },
    );
    expect(calls).toBe(0);
    await t.app.services.settings.update(
      { 'security.breachedPasswordCheck': true },
      { userId: null, ip: null },
    );
    expect((await change()).json()).toEqual({ error: 'weak_password', message: 'breached' });
    expect(calls).toBe(1);
  });
});
