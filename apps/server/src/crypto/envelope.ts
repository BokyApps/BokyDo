import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for secrets stored in the database (SMTP password, AI keys, OAuth tokens).
 * Each value gets a fresh 256-bit data key (DEK); the DEK is wrapped with the instance master key
 * (KEK). Both layers are AES-256-GCM and bound to `context` as associated data, so a ciphertext
 * copied to another row/purpose fails to decrypt.
 */
export interface EncryptedValue {
  v: 1;
  /** Wrapped DEK: iv(12) | tag(16) | ciphertext(32), base64url. */
  dek: string;
  /** Payload: iv(12) | tag(16) | ciphertext, base64url. */
  data: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptSecret(kek: Buffer, plaintext: string, context: string): EncryptedValue {
  const dek = randomBytes(32);
  try {
    return {
      v: 1,
      dek: seal(kek, dek, `bokydo:dek:${context}`),
      data: seal(dek, Buffer.from(plaintext, 'utf8'), `bokydo:data:${context}`),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptSecret(kek: Buffer, value: EncryptedValue, context: string): string {
  if (value.v !== 1) throw new Error('Unsupported secret format');
  const dek = open(kek, value.dek, `bokydo:dek:${context}`);
  try {
    return open(dek, value.data, `bokydo:data:${context}`).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

export function isEncryptedValue(value: unknown): value is EncryptedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as EncryptedValue).v === 1 &&
    typeof (value as EncryptedValue).dek === 'string' &&
    typeof (value as EncryptedValue).data === 'string'
  );
}

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const buf = Buffer.from(sealed, 'base64url');
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('Ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}
