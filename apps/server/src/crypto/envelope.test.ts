import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './envelope.js';

const kek = randomBytes(32);

describe('envelope encryption', () => {
  it('round-trips and never stores plaintext', () => {
    const enc = encryptSecret(kek, 'smtp-password-123', 'setting:email.smtpPassword');
    expect(JSON.stringify(enc)).not.toContain('smtp-password-123');
    expect(decryptSecret(kek, enc, 'setting:email.smtpPassword')).toBe('smtp-password-123');
  });

  it('uses a fresh data key and IV each time', () => {
    const a = encryptSecret(kek, 'same', 'ctx');
    const b = encryptSecret(kek, 'same', 'ctx');
    expect(a.dek).not.toBe(b.dek);
    expect(a.data).not.toBe(b.data);
  });

  it('is bound to its context (no swapping ciphertexts between settings)', () => {
    const enc = encryptSecret(kek, 'secret', 'setting:email.smtpPassword');
    expect(() => decryptSecret(kek, enc, 'setting:ai.openaiKey')).toThrow();
  });

  it('detects tampering', () => {
    const enc = encryptSecret(kek, 'secret', 'ctx');
    const bytes = Buffer.from(enc.data, 'base64url');
    bytes[bytes.length - 1]! ^= 1;
    expect(() =>
      decryptSecret(kek, { ...enc, data: bytes.toString('base64url') }, 'ctx'),
    ).toThrow();
    const dek = Buffer.from(enc.dek, 'base64url');
    dek[20]! ^= 1;
    expect(() => decryptSecret(kek, { ...enc, dek: dek.toString('base64url') }, 'ctx')).toThrow();
  });

  it('fails with the wrong master key', () => {
    const enc = encryptSecret(kek, 'secret', 'ctx');
    expect(() => decryptSecret(randomBytes(32), enc, 'ctx')).toThrow();
  });
});
