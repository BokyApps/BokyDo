import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, TEST_ORIGIN, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
let t: TestApp;
let admin: Client;

beforeEach(async () => {
  t = await testApp();
  await createUser(t.db, { username: 'admin', password: PASSWORD, isAdmin: true });
  await createUser(t.db, { username: 'bob', password: PASSWORD });
  // A normal feature route, which must stay closed until setup is complete.
  t.app.get('/api/v1/feature', { config: { access: 'user' } }, async () => ({ ok: true }));
  admin = new Client(t.app);
  await admin.login('admin', PASSWORD);
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('first-run setup', () => {
  it('keeps feature routes closed until setup is complete', async () => {
    expect((await admin.get('/api/v1/feature')).json()).toEqual({ error: 'setup_required' });
  });

  it('is admin-only', async () => {
    const bob = new Client(t.app);
    await bob.login('bob', PASSWORD);
    expect((await bob.get('/api/v1/setup')).json()).toEqual({ error: 'forbidden' });
    expect((await bob.put('/api/v1/setup/public-url', { publicUrl: TEST_ORIGIN })).statusCode).toBe(
      403,
    );
    expect((await new Client(t.app).get('/api/v1/setup')).statusCode).toBe(401);
  });

  it('requires a public URL before completing', async () => {
    expect((await admin.post('/api/v1/setup/complete')).statusCode).toBe(409);
    for (const publicUrl of [
      'javascript:alert(1)',
      'https://x.example/sub',
      'https://u:p@x.example',
    ]) {
      expect((await admin.put('/api/v1/setup/public-url', { publicUrl })).statusCode).toBe(400);
    }
  });

  it('flags plain HTTP beyond loopback', async () => {
    const res = await admin.put('/api/v1/setup/public-url', {
      publicUrl: 'http://192.168.1.10:8080',
    });
    expect(res.json().publicUrlWarning).toBe('insecure_http');
    admin.origin = 'http://192.168.1.10:8080'; // CSRF origin now pinned to the public URL
    const local = await admin.put('/api/v1/setup/public-url', {
      publicUrl: 'http://localhost:8080',
    });
    expect(local.json().publicUrlWarning).toBeNull();
  });

  it('completes, then the wizard disappears and features open up', async () => {
    const set = await admin.put('/api/v1/setup/public-url', { publicUrl: `${TEST_ORIGIN}/` });
    expect(set.json()).toMatchObject({ publicUrl: TEST_ORIGIN, canComplete: true });
    expect((await admin.post('/api/v1/setup/complete')).statusCode).toBe(204);

    expect((await admin.get('/api/v1/instance')).json().setupComplete).toBe(true);
    expect((await admin.get('/api/v1/setup')).statusCode).toBe(404);
    expect((await admin.post('/api/v1/setup/complete')).statusCode).toBe(404);
    expect((await admin.get('/api/v1/feature')).json()).toEqual({ ok: true });
  });

  it('pins the Origin check to the public URL once set (defeats DNS rebinding)', async () => {
    await admin.put('/api/v1/setup/public-url', { publicUrl: 'https://tasks.example.com' });
    // Same Host-derived origin is no longer enough.
    expect((await admin.post('/api/v1/setup/complete')).json()).toEqual({ error: 'csrf_failed' });
    admin.origin = 'https://tasks.example.com';
    expect((await admin.post('/api/v1/setup/complete')).statusCode).toBe(204);
  });
});
