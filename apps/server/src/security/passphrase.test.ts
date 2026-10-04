import { describe, expect, it } from 'vitest';
import { EFF_LARGE_WORDLIST } from './eff-wordlist.js';
import { generatePassphrase, passphraseEntropyBits } from './passphrase.js';

describe('generatePassphrase', () => {
  const words = new Set(EFF_LARGE_WORDLIST);

  it('uses the full, unique EFF large wordlist', () => {
    expect(EFF_LARGE_WORDLIST).toHaveLength(7776);
    expect(words.size).toBe(7776);
  });

  it('produces 6 dictionary words by default (~77 bits)', () => {
    const phrase = generatePassphrase();
    // Four EFF words contain hyphens (e.g. "t-shirt"), so match greedily against the list.
    expect(splitWords(phrase, words)).toHaveLength(6);
    expect(passphraseEntropyBits()).toBeGreaterThan(77);
  });

  it('does not repeat across many draws', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generatePassphrase()));
    expect(seen.size).toBe(2000);
  });

  it('refuses weak lengths', () => {
    expect(() => generatePassphrase(3)).toThrow();
    expect(() => generatePassphrase(4.5)).toThrow();
  });
});

function splitWords(phrase: string, words: Set<string>): string[] {
  const parts = phrase.split('-');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const joined = `${parts[i]}-${parts[i + 1]}`;
    if (i + 1 < parts.length && words.has(joined) && !words.has(parts[i]!)) {
      out.push(joined);
      i++;
    } else {
      expect(words.has(parts[i]!)).toBe(true);
      out.push(parts[i]!);
    }
  }
  return out;
}
