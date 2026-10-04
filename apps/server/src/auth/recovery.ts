import { randomInt } from 'node:crypto';
import { tokenId } from './tokens.js';

/** Crockford-style alphabet: no 0/O or 1/I/L confusion when typed from paper. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

/** `XXXXX-XXXXX` (~49 bits each; guessing is rate-limited and each code works once). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(key: Buffer, code: string): string {
  return tokenId(key, 'recovery-code', normalizeRecoveryCode(code));
}
