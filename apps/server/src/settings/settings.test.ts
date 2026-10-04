import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, instanceSettings } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
let t: TestApp;
let admin: Client;

beforeEach(async () => {
  t = await testApp();
  await createUser(t.db, { username: 'admin', password: PASSWORD, isAdmin: true });
  await createUser(t.db, { username: 'bob', password: PASSWORD });
  admin = new Client(t.app);
  await admin.login('admin', PASSWORD);
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('admin settings', () => {
  it('returns defaults with secrets reduced to isSet', async () => {
    const res = await admin.get('/api/v1/admin/settings');
    expect(res.json()).toMatchObject({
      'instance.name': 'BokyDo',
      'access.registrationMode': 'invite',
      'security.passwordMinLength': 12,
      'email.smtpPassword': { isSet: false },
    });
  });

  it('stores secrets encrypted, write-only, and audits without the value', async () => {
    const secret = 'smtp-Secret-Value-123';
    const res = await admin.patch('/api/v1/admin/settings', { 'email.smtpPassword': secret });
    expect(res.json().changed).toEqual(['email.smtpPassword']);
    expect(res.body).not.toContain(secret);
    expect((await admin.get('/api/v1/admin/settings')).json()['email.smtpPassword']).toEqual({
      isSet: true,
    });

    const [row] = await t.db.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, 'email.smtpPassword'));
    expect(JSON.stringify(row!.value)).not.toContain(secret);
    expect(t.app.services.settings.getSecret('email.smtpPassword')).toBe(secret);

    const audits = await t.db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'settings.updated'));
    expect(JSON.stringify(audits)).not.toContain(secret);

    await admin.patch('/api/v1/admin/settings', { 'email.smtpPassword': null });
    expect(t.app.services.settings.getSecret('email.smtpPassword')).toBeNull();
  });

  it('versions rows and records who changed them', async () => {
    await admin.patch('/api/v1/admin/settings', { 'instance.name': 'Team Tasks' });
    await admin.patch('/api/v1/admin/settings', { 'instance.name': 'Team Tasks 2' });
    const [row] = await t.db.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, 'instance.name'));
    expect(row!.version).toBe(2);
    expect(row!.updatedBy).not.toBeNull();
  });

  it('validates patches strictly', async () => {
    for (const body of [
      {},
      { 'instance.isAdmin': true },
      { 'security.sessionIdleDays': 0 },
      { 'email.fromName': 'a\nb' },
    ]) {
      expect(
        (await admin.patch('/api/v1/admin/settings', body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    }
  });

  it('is admin-only', async () => {
    const bob = new Client(t.app);
    await bob.login('bob', PASSWORD);
    expect((await bob.get('/api/v1/admin/settings')).statusCode).toBe(403);
    expect(
      (await bob.patch('/api/v1/admin/settings', { 'instance.name': 'pwned' })).statusCode,
    ).toBe(403);
  });

  it('only sends HSTS once the public URL is HTTPS', async () => {
    await admin.patch('/api/v1/admin/settings', { 'instance.publicUrl': 'https://bokydo.test' });
    const res = await t.app.inject('/healthz');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('trusts X-Forwarded-For only for the configured number of proxy hops', async () => {
    const loginIp = async (xff: string) => {
      await new Client(t.app).request({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'bob', password: 'wrong-wrong-wrong' },
        headers: { 'x-forwarded-for': xff },
      });
      const rows = await t.db.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'auth.login_failed'));
      return rows.at(-1)!.ip;
    };
    expect(await loginIp('6.6.6.6')).not.toBe('6.6.6.6');
    await admin.patch('/api/v1/admin/settings', { 'instance.trustedProxyHops': 1 });
    expect(await loginIp('6.6.6.6')).toBe('6.6.6.6');
    // With one trusted hop, a client-supplied chain can't push the IP further back.
    expect(await loginIp('1.1.1.1, 6.6.6.6')).toBe('6.6.6.6');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('test email', () => {
  it('reports when SMTP is not configured', async () => {
    const res = await admin.post('/api/v1/admin/email/test', { to: 'me@example.com' });
    expect(res.json()).toEqual({ error: 'conflict', message: 'smtp_not_configured' });
  });

  it('reports delivery failures without leaking the SMTP password', async () => {
    await admin.patch('/api/v1/admin/settings', {
      'email.smtpHost': '127.0.0.1',
      'email.smtpPort': 1,
      'email.smtpSecurity': 'none',
      'email.smtpUsername': 'mailer',
      'email.smtpPassword': 'do-not-leak-me',
      'email.fromAddress': 'bokydo@example.com',
    });
    const res = await admin.post('/api/v1/admin/email/test', { to: 'me@example.com' });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('do-not-leak-me');
  });

  it('rejects header injection in the recipient', async () => {
    const res = await admin.post('/api/v1/admin/email/test', {
      to: 'me@example.com\r\nBcc: x@evil.example',
    });
    expect(res.statusCode).toBe(400);
  });
});
