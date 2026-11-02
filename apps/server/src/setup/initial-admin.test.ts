import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '../db/client.js';
import { auditLog, sessions, users } from '../db/schema.js';
import { verifyPassword } from '../security/password.js';
import { freshDb, TEST_DATABASE_URL } from '../test/db.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { instanceSettings } from '../db/schema.js';
import { isSetupComplete } from './instance-settings.js';
import { resetMfaFromCli, resetPasswordFromCli } from './reset-password.js';

describe.skipIf(!TEST_DATABASE_URL)('initial admin (Postgres)', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await freshDb();
  });
  afterAll(async () => h?.close());

  it('creates an explicit fixture for CLI recovery without startup credentials', async () => {
    await createUser(h, {
      username: 'admin',
      password: 'fixture-password-123',
      isAdmin: true,
    });
    expect(await h.db.select().from(users)).toHaveLength(1);
  });

  it('CLI reset issues a new passphrase, forces a change and audits it', async () => {
    const [before] = await h.db.select().from(users);
    const passphrase = await resetPasswordFromCli(h.db, 'ADMIN');
    expect(passphrase).toBeTruthy();
    const [after] = await h.db.select().from(users);
    expect(after!.passwordHash).not.toBe(before!.passwordHash);
    expect(await verifyPassword(after!.passwordHash, passphrase!)).toBe(true);
    expect(after!.mustChangePassword).toBe(true);
    const audits = await h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'user.password_reset_cli'));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(passphrase!);
  });

  it('CLI reset revokes existing sessions', async () => {
    const [admin] = await h.db.select().from(users);
    await h.db.insert(sessions).values({
      id: 'stolen',
      userId: admin!.id,
      csrfToken: 'x',
      idleExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await resetPasswordFromCli(h.db, 'admin');
    expect(await h.db.select().from(sessions)).toHaveLength(0);
  });

  it('CLI MFA reset removes every second factor and signs the user out', async () => {
    const [admin] = await h.db.select().from(users);
    await h.db
      .update(users)
      .set({ totpEnabledAt: new Date(), totpLastStep: 1 })
      .where(eq(users.id, admin!.id));
    await h.db.insert(sessions).values({
      id: 'live',
      userId: admin!.id,
      csrfToken: 'x',
      idleExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await resetMfaFromCli(h.db, 'Admin')).toBe(true);
    const [after] = await h.db.select().from(users);
    expect(after!.totpEnabledAt).toBeNull();
    expect(await h.db.select().from(sessions)).toHaveLength(0);
    expect(await resetMfaFromCli(h.db, 'nobody')).toBe(false);
  });

  it('CLI reset reports unknown users', async () => {
    expect(await resetPasswordFromCli(h.db, 'nobody')).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('browser initial admin signup', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await testApp();
  });
  afterEach(async () => t?.close());

  it('allows only one concurrent first signup and returns an authenticated admin session', async () => {
    expect(await t.db.db.select().from(users)).toHaveLength(0);
    expect((await new Client(t.app).get('/api/v1/instance')).json().initialAdminRequired).toBe(
      true,
    );
    const body = { username: 'owner', password: 'violin-pancake-orbit-meadow' };
    const clients = Array.from({ length: 5 }, () => new Client(t.app));
    const responses = await Promise.all(
      clients.map((client) => client.post('/api/v1/setup/admin', body)),
    );
    expect(responses.filter((res) => res.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((res) => res.statusCode === 409)).toHaveLength(4);
    const [admin] = await t.db.db.select().from(users);
    expect(admin!.isAdmin).toBe(true);
    expect(admin!.mustChangePassword).toBe(false);
    expect(admin!.passwordHash).not.toContain(body.password);
    expect(await verifyPassword(admin!.passwordHash, body.password)).toBe(true);
    expect(responses.find((res) => res.statusCode === 201)!.json()).toMatchObject({
      user: { username: 'owner', isAdmin: true },
    });
    const winner = clients[responses.findIndex((res) => res.statusCode === 201)]!;
    expect((await winner.get('/api/v1/auth/session')).statusCode).toBe(200);
    expect((await winner.get('/api/v1/instance')).json().initialAdminRequired).toBe(false);
    expect(await isSetupComplete(t.db.db)).toBe(false);
  });

  it('preserves an already-configured instance when its owner signs up', async () => {
    await t.db.db.insert(instanceSettings).values({ key: 'setup.complete', value: true });
    await t.app.services.settings.reload();
    const owner = new Client(t.app);
    expect((await owner.get('/api/v1/instance')).json()).toMatchObject({
      setupComplete: true,
      initialAdminRequired: true,
    });
    expect(
      (
        await owner.post('/api/v1/setup/admin', {
          username: 'chosen-owner',
          password: 'violin-pancake-orbit-meadow',
        })
      ).statusCode,
    ).toBe(201);
    expect((await owner.get('/api/v1/instance')).json()).toMatchObject({
      setupComplete: true,
      initialAdminRequired: false,
    });
    expect((await owner.post('/api/v1/sync', { cursor: null, commands: [] })).statusCode).toBe(200);
  });

  it('rejects missing origins and weak passwords without creating an account', async () => {
    const body = { username: 'owner', password: 'short' };
    expect((await new Client(t.app, null).post('/api/v1/setup/admin', body)).statusCode).toBe(403);
    expect((await new Client(t.app).post('/api/v1/setup/admin', body)).statusCode).toBe(400);
    expect(await t.db.db.select().from(users)).toHaveLength(0);
  });

  it('reserves the first account for admin signup even when registration is open', async () => {
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    await t.app.services.settings.update(
      { 'access.registrationMode': 'open' },
      { userId: null, ip: null },
    );
    const body = { username: 'visitor', password: 'violin-pancake-orbit-meadow' };
    expect((await new Client(t.app).post('/api/v1/auth/register', body)).json()).toEqual({
      error: 'initial_admin_required',
    });
    expect(await t.db.db.select().from(users)).toHaveLength(0);
    expect(
      (await new Client(t.app).post('/api/v1/setup/admin', { ...body, username: 'owner' }))
        .statusCode,
    ).toBe(201);
    expect((await new Client(t.app).post('/api/v1/auth/register', body)).statusCode).toBe(200);
  });

  it('does not consume a surviving invite before the owner creates an admin', async () => {
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    const { token } = await t.app.services.tokens.create({ kind: 'invite', ttlMs: 60_000 });
    const body = {
      username: 'visitor',
      password: 'violin-pancake-orbit-meadow',
      inviteToken: token,
    };
    expect((await new Client(t.app).post('/api/v1/auth/register', body)).json()).toEqual({
      error: 'initial_admin_required',
    });
    expect(await t.app.services.tokens.peek('invite', token)).not.toBeNull();
    expect(await t.db.db.select().from(users)).toHaveLength(0);
  });

  it('cannot race ordinary registration into taking the first-user slot', async () => {
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    await t.app.services.settings.update(
      { 'access.registrationMode': 'open' },
      { userId: null, ip: null },
    );
    const password = 'violin-pancake-orbit-meadow';
    const [owner, ...visitors] = await Promise.all([
      new Client(t.app).post('/api/v1/setup/admin', { username: 'owner', password }),
      ...Array.from({ length: 5 }, (_, i) =>
        new Client(t.app).post('/api/v1/auth/register', { username: `visitor${i}`, password }),
      ),
    ]);
    expect(owner!.statusCode).toBe(201);
    expect(visitors.every((response) => [200, 403].includes(response.statusCode))).toBe(true);
    const admins = (await t.db.db.select().from(users)).filter((user) => user.isAdmin);
    expect(admins).toHaveLength(1);
    expect(admins[0]!.username).toBe('owner');
  });

  it('rate-limits repeated password-policy failures on an unclaimed instance', async () => {
    const client = new Client(t.app);
    for (let i = 0; i < 10; i++)
      expect(
        (await client.post('/api/v1/setup/admin', { username: 'owner', password: 'short' }))
          .statusCode,
      ).toBe(400);
    const limited = await client.post('/api/v1/setup/admin', {
      username: 'owner',
      password: 'violin-pancake-orbit-meadow',
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(await t.db.db.select().from(users)).toHaveLength(0);
  });

  it('rejects a claimed instance before the breached-password service is called', async () => {
    await createUser(t.db, {
      username: 'owner',
      password: 'violin-pancake-orbit-meadow',
      isAdmin: true,
    });
    await t.app.services.settings.update(
      { 'security.breachedPasswordCheck': true },
      { userId: null, ip: null },
    );
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not be called'));
    try {
      expect(
        (
          await new Client(t.app).post('/api/v1/setup/admin', {
            username: 'another',
            password: 'violin-pancake-orbit-meadow',
          })
        ).statusCode,
      ).toBe(409);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('rejects non-browser origins, unknown fields, and all signup after any user exists', async () => {
    const badOrigin = new Client(t.app, 'http://attacker.example');
    expect(
      (
        await badOrigin.post('/api/v1/setup/admin', {
          username: 'owner',
          password: 'violin-pancake-orbit-meadow',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await new Client(t.app).post('/api/v1/setup/admin', {
          username: 'owner',
          password: 'violin-pancake-orbit-meadow',
          extra: true,
        })
      ).statusCode,
    ).toBe(400);
    const id = await createUser(t.db, {
      username: 'disabled',
      password: 'violin-pancake-orbit-meadow',
    });
    await t.db.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, id));
    await t.db.db
      .insert(instanceSettings)
      .values({ key: 'setup.complete', value: true })
      .onConflictDoUpdate({ target: instanceSettings.key, set: { value: true } });
    expect(
      (
        await new Client(t.app).post('/api/v1/setup/admin', {
          username: 'another',
          password: 'violin-pancake-orbit-meadow',
        })
      ).statusCode,
    ).toBe(409);
  });
});
