import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token for links, cookies and challenges (base64url, 43 chars). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Storage ID for a secret token: HMAC(session.key, purpose:token). The database never holds a
 * usable token, and a token minted for one purpose can't be presented for another.
 */
export function tokenId(key: Buffer, purpose: string, token: string): string {
  return createHmac('sha256', key).update(`${purpose}:${token}`).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
