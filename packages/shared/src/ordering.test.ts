import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generateKeyBetween, generateNKeysBetween, isValidOrderKey } from './ordering.js';

describe('order keys', () => {
  it('starts in the middle and appends/prepends compactly', () => {
    expect(generateKeyBetween(null, null)).toBe('a0');
    let last = 'a0';
    for (let i = 0; i < 5000; i++) last = generateKeyBetween(last, null);
    expect(last.length).toBeLessThanOrEqual(4);
    let first = 'a0';
    for (let i = 0; i < 5000; i++) first = generateKeyBetween(null, first);
    expect(first.length).toBeLessThanOrEqual(4);
  });

  it('always finds a key strictly between two keys (random insertion orders)', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 300 }), (positions) => {
        const keys: string[] = [];
        for (const p of positions) {
          const at = p % (keys.length + 1);
          const key = generateKeyBetween(keys[at - 1] ?? null, keys[at] ?? null);
          expect(isValidOrderKey(key)).toBe(true);
          keys.splice(at, 0, key);
        }
        for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('survives repeated insertion at the same spot (worst case) within the length cap', () => {
    let a = 'a0';
    const b = 'a1';
    for (let i = 0; i < 300; i++) {
      a = generateKeyBetween(a, b);
      expect(a < b).toBe(true);
    }
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it('generates N ordered keys', () => {
    const keys = generateNKeysBetween('a0', 'a1', 20);
    expect([...keys].sort()).toEqual(keys);
    expect(keys.every((k) => k > 'a0' && k < 'a1')).toBe(true);
  });

  it.each(['', 'a', 'a00', 'a0 ', 'a0;drop', 'é', 'A' + '0'.repeat(26), 'a'.repeat(65)])(
    'rejects invalid key %j',
    (key) => {
      expect(isValidOrderKey(key)).toBe(false);
    },
  );
});
