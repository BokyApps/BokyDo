import type { ApiScope } from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { createECDH } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../db/ids.js';
import { oauthClients, oauthGrants, pushSubscriptions } from '../db/schema.js';
import { Client, createUser, TEST_HOST, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

const PASSWORD = 'violin-pancake-orbit-meadow';

/** The Android app registers for UnifiedPush with its OAuth token; the grant bounds it. */
describe.skipIf(!TEST_DATABASE_URL)('push subscriptions for apps', () => {
  let t: TestApp;
  let alice: string;
  const clientId = `bkdc_${'b'.repeat(22)}`;
  const pushed: string[] = [];

  beforeEach(async () => {
    pushed.length = 0;
    t = await testApp({
      fetchImpl: (async (url: string | URL | Request) => {
        pushed.push(String(url));
        return new Response(null, { status: 201 });
      }) as typeof fetch,
    });
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    await t.app.services.settings.update(
      { 'push.allowedHosts': ['ntfy.example.com'] },
      { userId: null, ip: null },
    );
    alice = await createUser(t.db, { username: 'alice', password: PASSWORD });
    await t.db.db.insert(oauthClients).values({
      id: clientId,
      name: 'BokyDo for Android',
      redirectUris: ['com.bokyapps.bokydo:/oauth2redirect'],
      registeredVia: 'dynamic',
    });
  });
  afterEach(() => t.close());

  async function appToken(scopes: ApiScope[] = ['sync']) {
    const grantId = newId();
    await t.db.db
      .insert(oauthGrants)
      .values({ id: grantId, clientId, userId: alice, scopes, audience: 'api' });
    const issued = await t.db.db.transaction((tx) =>
      t.app.services.apiTokens.issue(tx, { id: grantId, userId: alice, scopes, audience: 'api' }),
    );
    return { grantId, token: issued.access_token };
  }

  const keys = () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    return {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16, 3).toString('base64url'),
    };
  };

  const call = (token: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: {
        host: TEST_HOST,
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { payload: payload as object } : {}),
    });

  const subs = () => t.db.db.select().from(pushSubscriptions);

  it('binds an app registration to its grant, and refuses personal access tokens', async () => {
    const { grantId, token } = await appToken();
    expect((await call(token, 'GET', '/api/v1/push/key')).json().publicKey).toHaveLength(87);
    const res = await call(token, 'POST', '/api/v1/push/subscriptions', {
      endpoint: 'https://ntfy.example.com/upA1b2C3?up=1',
      keys: keys(),
    });
    expect(res.statusCode).toBe(201);
    expect(await subs()).toEqual([
      expect.objectContaining({ userId: alice, grantId, sessionId: null }),
    ]);

    const pat = (
      await t.app.services.apiTokens.createPat(alice, {
        name: 'script',
        scopes: ['sync'],
        expiresInDays: 1,
      })
    ).token;
    const refused = await call(pat, 'POST', '/api/v1/push/subscriptions', {
      endpoint: 'https://ntfy.example.com/upOther',
      keys: keys(),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toBe('push_needs_app');

    // A token without the sync scope can't register at all.
    const narrow = await appToken(['tasks:read']);
    expect(
      (
        await call(narrow.token, 'POST', '/api/v1/push/subscriptions', {
          endpoint: 'https://ntfy.example.com/upX',
          keys: keys(),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('pushes to the app, and stops when the app is signed out or withdrawn', async () => {
    const first = await appToken();
    await call(first.token, 'POST', '/api/v1/push/subscriptions', {
      endpoint: 'https://ntfy.example.com/upFirst',
      keys: keys(),
    });
    const msg = { title: 't', body: 'b', url: '/today' };
    expect(await t.app.services.delivery.push(alice, msg)).toBe(1);
    expect(pushed).toEqual(['https://ntfy.example.com/upFirst']);

    // The user removes the app in Settings → Apps & tokens: its registration goes with it.
    await t.app.services.apiTokens.revokeApp(alice, clientId);
    expect(await subs()).toEqual([]);

    // Revoked some other way (e.g. refresh-token reuse) before cleanup: never pushed to.
    const second = await appToken();
    await call(second.token, 'POST', '/api/v1/push/subscriptions', {
      endpoint: 'https://ntfy.example.com/upSecond',
      keys: keys(),
    });
    await t.db.db
      .update(oauthGrants)
      .set({ revokedAt: new Date() })
      .where(eq(oauthGrants.id, second.grantId));
    pushed.length = 0;
    expect(await t.app.services.delivery.push(alice, msg)).toBe(0);
    expect(pushed).toEqual([]);
    expect(await subs()).toEqual([]);

    // An account reset ends every app's push, and leaves browsers' alone.
    const third = await appToken();
    await call(third.token, 'POST', '/api/v1/push/subscriptions', {
      endpoint: 'https://ntfy.example.com/upThird',
      keys: keys(),
    });
    const browser = new Client(t.app);
    await browser.login('alice', PASSWORD);
    expect(
      (
        await browser.post('/api/v1/push/subscriptions', {
          endpoint: 'https://fcm.googleapis.com/fcm/send/browser1',
          keys: keys(),
        })
      ).statusCode,
    ).toBe(201);
    await t.app.services.apiTokens.revokeAllForUser(alice);
    expect((await subs()).map((s) => s.endpoint)).toEqual([
      'https://fcm.googleapis.com/fcm/send/browser1',
    ]);
  });

  it('tells clients the zone reminders use', async () => {
    const { token } = await appToken();
    const sync = await call(token, 'POST', '/api/v1/sync', { cursor: null });
    expect(sync.json().user.timeZone).toBe('UTC');
    await t.app.services.settings.update(
      { 'instance.defaultTimezone': 'Asia/Phnom_Penh' },
      { userId: null, ip: null },
    );
    expect((await call(token, 'POST', '/api/v1/sync', { cursor: null })).json().user.timeZone).toBe(
      'Asia/Phnom_Penh',
    );
  });
});
