import path from 'node:path';
import { newVapidKey } from '../delivery/webpush.js';
import { ensureSecretDir, ensureSecretFile, randomSecret } from './secret-files.js';

export interface AppSecrets {
  /** Key-encryption key for envelope-encrypting stored credentials (SMTP, AI keys, OAuth tokens). */
  masterKey: Buffer;
  /** HMAC key for signing session cookies and other server-issued tokens. */
  sessionKey: Buffer;
  /** P-256 private key identifying this server to browser push services (VAPID). */
  vapidKey: Buffer;
}

/**
 * Load the server's own secrets from the data volume, generating them on first boot.
 * Losing master.key makes stored credentials unrecoverable, so backups must include it.
 */
export async function ensureAppSecrets(secretsDir: string): Promise<AppSecrets> {
  await ensureSecretDir(secretsDir);
  const masterKey = await ensureSecretFile(path.join(secretsDir, 'master.key'), () =>
    randomSecret(32),
  );
  const sessionKey = await ensureSecretFile(path.join(secretsDir, 'session.key'), () =>
    randomSecret(32),
  );
  const vapidKey = await ensureSecretFile(path.join(secretsDir, 'vapid.key'), newVapidKey);
  return {
    masterKey: decodeKey(masterKey, 'master.key'),
    sessionKey: decodeKey(sessionKey, 'session.key'),
    vapidKey: decodeKey(vapidKey, 'vapid.key'),
  };
}

function decodeKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32) throw new Error(`${name} is corrupt (expected 32 bytes)`);
  return key;
}
