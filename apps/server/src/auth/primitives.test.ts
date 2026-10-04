import { describe, expect, it } from 'vitest';
import { isBreachedPassword } from './breached.js';
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from './recovery.js';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpCode,
  totpStep,
  verifyTotp,
} from './totp.js';

describe('TOTP (RFC 6238 SHA-1 vectors)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('t=%i → %s', (t, code) => {
    expect(totpCode(secret, totpStep(t * 1000))).toBe(code);
  });

  it('accepts ±1 step of drift and returns the matched step', () => {
    const s = generateTotpSecret();
    const now = Date.now();
    const step = totpStep(now);
    expect(verifyTotp(s, totpCode(s, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(s, totpCode(s, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(s, totpCode(s, step - 2), now)).toBeNull();
    expect(verifyTotp(s, '000000', now) === null || totpCode(s, step) === '000000').toBe(true);
  });

  it('round-trips base32 and makes 160-bit secrets', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
  });
});

describe('recovery codes', () => {
  it('are unique, readable and normalised before hashing', () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJKMNP-TV-Z2-9]{5}-[A-HJKMNP-TV-Z2-9]{5}$/);
    const key = Buffer.alloc(32, 7);
    expect(hashRecoveryCode(key, codes[0]!.toLowerCase().replace('-', ' '))).toBe(
      hashRecoveryCode(key, codes[0]!),
    );
    expect(normalizeRecoveryCode('ab-c d')).toBe('ABCD');
  });
});

describe('breached password check', () => {
  const fake = (body: string, ok = true) =>
    (async () => ({ ok, text: async () => body })) as unknown as typeof fetch;
  // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  it('matches the suffix from the range response and sends only the prefix', async () => {
    let url = '';
    const spy = (async (u: string) => {
      url = u;
      return { ok: true, text: async () => '1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\nABC:0' };
    }) as unknown as typeof fetch;
    expect(await isBreachedPassword('password', spy)).toBe(true);
    expect(url).toBe('https://api.pwnedpasswords.com/range/5BAA6');
  });
  it('ignores padding entries with count 0 and fails open on errors', async () => {
    expect(
      await isBreachedPassword('password', fake('1E4C9B93F3F0682250B6CF8331B7EE68FD8:0')),
    ).toBe(false);
    expect(await isBreachedPassword('password', fake('', false))).toBe(false);
    expect(
      await isBreachedPassword('password', (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch),
    ).toBe(false);
  });
});
