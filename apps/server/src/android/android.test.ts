import { ANDROID_CLIENT_ID, ANDROID_REDIRECT_URI, settingsPatchSchema } from '@bokydo/shared';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_HOST, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

const BASE = 'https://tasks.example.com';
let t: TestApp;
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { host: TEST_HOST } });

describe.skipIf(!TEST_DATABASE_URL)('Android discovery and asset links', () => {
  beforeEach(async () => {
    t = await testApp();
  });
  afterEach(async () => t.close());

  it('publishes discovery only once the public URL is known', async () => {
    expect((await get('/.well-known/bokydo')).statusCode).toBe(404);
    await t.app.services.settings.update(
      { 'instance.publicUrl': BASE },
      { userId: null, ip: null },
    );
    expect((await get('/.well-known/bokydo')).json()).toMatchObject({
      app: 'bokydo',
      publicUrl: BASE,
      oauth: { issuer: BASE, tokenEndpoint: `${BASE}/oauth/token` },
      android: { clientId: ANDROID_CLIENT_ID, redirectUri: ANDROID_REDIRECT_URI, scope: 'sync' },
      api: { sync: `${BASE}/api/v1/sync` },
    });
  });

  it('knows the Android app as a first-party client', async () => {
    await t.app.services.settings.update(
      { 'instance.publicUrl': BASE },
      { userId: null, ip: null },
    );
    const challenge = createHash('sha256')
      .update(randomBytes(32).toString('base64url'))
      .digest('base64url');
    const res = await get(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: ANDROID_CLIENT_ID,
        redirect_uri: ANDROID_REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'sync',
      }).toString()}`,
    );
    expect(res.headers.location).toMatch(/\/oauth\/consent#/);
  });

  it('serves asset links for the configured signing certificates only', async () => {
    expect((await get('/.well-known/assetlinks.json')).json()).toEqual([]);
    const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':');
    await t.app.services.settings.update(
      { 'android.certFingerprints': [fp] },
      { userId: null, ip: null },
    );
    const links = (await get('/.well-known/assetlinks.json')).json();
    expect(links[0].target).toEqual({
      namespace: 'android_app',
      package_name: 'com.bokyapps.bokydo',
      sha256_cert_fingerprints: [fp.toUpperCase()],
    });
    expect(settingsPatchSchema.safeParse({ 'android.certFingerprints': ['nope'] }).success).toBe(
      false,
    );
  });
});
