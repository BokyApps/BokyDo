import { randomInt } from 'node:crypto';
import { EFF_LARGE_WORDLIST } from './eff-wordlist.js';

export const DEFAULT_PASSPHRASE_WORDS = 6;

/**
 * Diceware-style passphrase from the EFF large wordlist using a CSPRNG.
 * 6 words ≈ 77.5 bits of entropy (log2(7776) × 6).
 */
export function generatePassphrase(words = DEFAULT_PASSPHRASE_WORDS): string {
  if (!Number.isInteger(words) || words < 4) {
    throw new Error('Passphrases must have at least 4 words');
  }
  // randomInt is uniform (rejection sampling), so there is no modulo bias.
  return Array.from(
    { length: words },
    () => EFF_LARGE_WORDLIST[randomInt(EFF_LARGE_WORDLIST.length)],
  ).join('-');
}

export function passphraseEntropyBits(words = DEFAULT_PASSPHRASE_WORDS): number {
  return words * Math.log2(EFF_LARGE_WORDLIST.length);
}
