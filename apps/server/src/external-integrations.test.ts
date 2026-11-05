import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from './test/app.js';
import { TEST_DATABASE_URL } from './test/db.js';

let t: TestApp;
let admin: Client;
beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  const id = await createUser(t.db, {
    username: 'owner',
    password: 'fixture-password',
    isAdmin: true,
  });
  const { token, session } = await t.app.services.sessions.create(
    { id, username: 'owner', isAdmin: true, mustChangePassword: false },
    { ip: null, userAgent: null, authMethod: 'password' },
  );
  admin = new Client(t.app);
  admin.cookies.set('bokydo_session', token);
  admin.csrfToken = session.csrfToken;
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('external integrations replace built-in AI', () => {
  it('never constructs a provider service or registers built-in AI routes', async () => {
    expect(t.app.services).not.toHaveProperty('ai');
    expect(
      t.app.apiRoutes.some((route) =>
        /\/api\/v1\/(?:admin\/)?(?:ai|assist|ramble)\//.test(route.url),
      ),
    ).toBe(false);
    for (const path of [
      '/api/v1/ai/catalog',
      '/api/v1/admin/ai/credentials',
      '/api/v1/ramble/live',
    ]) {
      expect((await admin.get(path)).statusCode).toBe(404);
    }
    for (const path of ['/api/v1/assist/task', '/api/v1/assist/ask', '/api/v1/ramble/extract']) {
      expect((await admin.post(path, {})).statusCode).toBe(404);
    }
  });

  it('cannot reactivate retired features through a previously saved AI setting', async () => {
    await t.app.services.settings.update(
      { 'ai.instanceAccess': 'everyone', 'ai.userKeys': true, 'ai.subscriptionSignIn': true },
      { userId: null, ip: null },
    );
    expect((await admin.get('/api/v1/ai/catalog')).statusCode).toBe(404);
    expect((await admin.post('/api/v1/admin/ai/credentials', {})).statusCode).toBe(404);
    expect((await admin.post('/api/v1/assist/report', {})).statusCode).toBe(404);
    expect(t.app.services).not.toHaveProperty('ai');
  });
});
