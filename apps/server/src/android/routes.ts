import {
  ANDROID_CLIENT_ID,
  ANDROID_PACKAGE,
  ANDROID_REDIRECT_URI,
  type Discovery,
} from '@bokydo/shared';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import { oauthClients } from '../db/schema.js';
import type { SettingsService } from '../settings/settings-service.js';
import { VERSION } from '../version.js';

/**
 * The official Android app is a first-party OAuth client on every instance: same client ID,
 * a fixed private-use redirect URI (RFC 8252) and, like every client, PKCE and the user's
 * consent. Kept in sync on every start, so its redirect URI can't drift.
 */
export async function ensureFirstPartyClients(db: Database): Promise<void> {
  const client = {
    name: 'BokyDo for Android',
    redirectUris: [ANDROID_REDIRECT_URI],
    registeredVia: 'admin' as const,
  };
  await db
    .insert(oauthClients)
    .values({ id: ANDROID_CLIENT_ID, ...client })
    .onConflictDoUpdate({ target: oauthClients.id, set: client });
}

/** Discovery for apps, and Digital Asset Links for the Android app. */
export function registerAndroidRoutes(
  app: FastifyInstance,
  deps: { settings: SettingsService },
): void {
  const { settings } = deps;

  app.get('/.well-known/bokydo', async (_req, reply) => {
    const base = settings.get('instance.publicUrl');
    // Apps need a stable address to sign in against; until it's set, there's nothing to offer.
    if (!base || !settings.get('api.enabled'))
      return reply.status(404).send({ error: 'not_found' });
    const discovery: Discovery = {
      app: 'bokydo',
      version: VERSION,
      publicUrl: base,
      oauth: {
        issuer: base,
        authorizationEndpoint: `${base}/oauth/authorize`,
        tokenEndpoint: `${base}/oauth/token`,
        revocationEndpoint: `${base}/oauth/revoke`,
      },
      android: {
        clientId: ANDROID_CLIENT_ID,
        redirectUri: ANDROID_REDIRECT_URI,
        scope: 'sync ai:use tasks:write',
      },
      api: { sync: `${base}/api/v1/sync`, events: `${base}/api/v1/sync/events` },
    };
    return reply.header('cache-control', 'no-cache').send(discovery);
  });

  app.get('/.well-known/assetlinks.json', async (_req, reply) => {
    const fingerprints = settings.get('android.certFingerprints');
    const statements = fingerprints.length
      ? [
          {
            relation: [
              'delegate_permission/common.handle_all_urls',
              'delegate_permission/common.get_login_creds',
            ],
            target: {
              namespace: 'android_app',
              package_name: ANDROID_PACKAGE,
              sha256_cert_fingerprints: fingerprints,
            },
          },
        ]
      : [];
    return reply.header('cache-control', 'max-age=300').send(statements);
  });
}
