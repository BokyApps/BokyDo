import { isLoopbackHost } from '@bokydo/shared';
import { isIP } from 'node:net';
import type { SettingsService } from '../settings/settings-service.js';

export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

/**
 * Passkeys are bound to the instance's public URL: RP ID = its host name, expected origin = the
 * URL itself. Never derived from request headers. Browsers only allow WebAuthn in a secure
 * context, so plain-HTTP public URLs (other than localhost) disable passkeys, as do IP addresses.
 */
export function relyingParty(settings: SettingsService): RelyingParty | null {
  const publicUrl = settings.get('instance.publicUrl');
  if (!publicUrl) return null;
  const url = new URL(publicUrl);
  // WebAuthn RP IDs must be domain names: IP addresses (even 127.0.0.1) are rejected by browsers.
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return null;
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) return null;
  return { id: url.hostname, name: settings.get('instance.name'), origin: url.origin };
}

/** UUID → 16 raw bytes for the WebAuthn user handle (no personal data in the handle). */
export function userHandle(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(userId.replace(/-/g, ''), 'hex'));
}

export const SUPPORTED_ALGORITHMS = [-7, -257]; // ES256, RS256
export const MAX_PASSKEYS_PER_USER = 20;
