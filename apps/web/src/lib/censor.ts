/**
 * Client-side encryption for censored note spans (ADR 0025, "Censoring").
 *
 * The server only ever sees the token; plaintext and passwords stay in the browser. There is no
 * runtime dependency beyond `globalThis.crypto.subtle` (WebCrypto, present in Node 22 and in
 * browsers). Derived keys are non-extractable, the KDF cost is a fixed constant that is never
 * read from a token, and nothing here logs or persists plaintext or passwords (only the explicit
 * `CensorKeyCache` instance keeps passwords, in memory, for the length of a session).
 */

export const CENSOR_PLACEHOLDER = '█████';

// The ':' delimiters are deliberately NOT part of `[A-Za-z0-9_-]`, so every `+` is bounded by a
// literal character it cannot consume. That makes matching linear-time (no super-linear
// backtracking) and keeps the three quantifiers un-nested.
export const CENSOR_TOKEN_RE =
  /\{\{censored:v1:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)\}\}/g;

// Anchored, single-token variant used by parseToken. Kept separate so a token embedded in
// surrounding text is never accepted as if it were the whole token.
const TOKEN_PARSE_RE = /^\{\{censored:v1:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)\}\}$/;

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Fixed cost: never parameterised by the token, so an attacker cannot downgrade the KDF.
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MIN_CT_BYTES = 17; // 16-byte GCM tag + at least one byte of ciphertext
const MAX_CT_BYTES = 65_536; // up to 64 KiB of ciphertext
const MAX_PLAINTEXT_BYTES = 48 * 1024;
const AAD = new TextEncoder().encode('bokydo-censor-v1');

// WebCrypto's BufferSource is ArrayBufferView<ArrayBuffer> in TS 6, so every byte array passed to
// subtle.* must be ArrayBuffer-backed, not the default Uint8Array<ArrayBufferLike>.
type Bytes = Uint8Array<ArrayBuffer>;

type CensorErrorCode = 'bad_password' | 'malformed' | 'too_large' | 'empty_password' | 'empty_text';

const ERROR_MESSAGES: Record<CensorErrorCode, string> = {
  bad_password: 'Wrong password or tampered censor token.',
  malformed: 'Malformed censor token.',
  too_large: 'Censored text is too large.',
  empty_password: 'Password must not be empty.',
  empty_text: 'There is no text to censor.',
};

export class CensorError extends Error {
  readonly code: CensorErrorCode;

  constructor(code: CensorErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CensorError';
    this.code = code;
  }
}

// Unpadded base64url over raw bytes. These helpers are byte-oriented: they never hand an
// arbitrary JS string to btoa/atob and never accept '=' padding or non-alphabet characters.
function bytesToBase64url(bytes: Bytes): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64URL_ALPHABET.charAt((acc >> bits) & 63);
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    out += B64URL_ALPHABET.charAt((acc << (6 - bits)) & 63);
  }
  return out;
}

function base64urlToBytes(text: string): Bytes | null {
  const remainder = text.length % 4;
  if (remainder === 1) return null;
  const size = Math.floor(text.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  const out = new Uint8Array(size);
  const lookup = new Map<string, number>();
  for (let i = 0; i < B64URL_ALPHABET.length; i++) {
    lookup.set(B64URL_ALPHABET.charAt(i), i);
  }
  let acc = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < text.length; i++) {
    const value = lookup.get(text.charAt(i));
    if (value === undefined) return null;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  // Leftover bits must be zero; otherwise the encoding is non-canonical and we reject it.
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

export function parseToken(token: string): { salt: Bytes; iv: Bytes; ct: Bytes } | null {
  const match = TOKEN_PARSE_RE.exec(token);
  if (match === null) return null;
  const saltText = match[1];
  const ivText = match[2];
  const ctText = match[3];
  if (saltText === undefined || ivText === undefined || ctText === undefined) return null;
  const salt = base64urlToBytes(saltText);
  const iv = base64urlToBytes(ivText);
  const ct = base64urlToBytes(ctText);
  if (salt === null || iv === null || ct === null) return null;
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) return null;
  if (ct.length < MIN_CT_BYTES || ct.length > MAX_CT_BYTES) return null;
  return { salt, iv, ct };
}

function randomBytes(length: number): Bytes {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

async function deriveKey(password: string, salt: Bytes): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
}

type Parsed = { salt: Bytes; iv: Bytes; ct: Bytes };

async function decryptParsed(parsed: Parsed, key: CryptoKey): Promise<string> {
  let buffer: ArrayBuffer;
  try {
    buffer = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: parsed.iv, additionalData: AAD, tagLength: 128 },
      key,
      parsed.ct,
    );
  } catch {
    // GCM auth failure: wrong key/password, or any tampering with salt/iv/ct/AAD. Never expose
    // partial output; AES-GCM either yields the whole plaintext or throws.
    throw new CensorError('bad_password');
  }
  return new TextDecoder().decode(buffer);
}

export async function censor(plaintext: string, password: string): Promise<string> {
  if (password.length === 0) throw new CensorError('empty_password');
  const data = new TextEncoder().encode(plaintext);
  if (data.length === 0) throw new CensorError('empty_text');
  if (data.length > MAX_PLAINTEXT_BYTES) throw new CensorError('too_large');
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 },
      key,
      data,
    ),
  );
  return `{{censored:v1:${bytesToBase64url(salt)}:${bytesToBase64url(iv)}:${bytesToBase64url(ct)}}}`;
}

export async function uncensor(
  token: string,
  password: string,
  cache?: CensorKeyCache,
): Promise<string> {
  const parsed = parseToken(token);
  if (parsed === null) throw new CensorError('malformed');
  const saltB64 = bytesToBase64url(parsed.salt);
  const cached = cache?.get(saltB64);
  const key = cached ?? (await deriveKey(password, parsed.salt));
  const plaintext = await decryptParsed(parsed, key);
  // Cache the key and remember the password ONLY after a decrypt we know succeeded, and ONLY
  // when the key was freshly derived from that password (a cached key says nothing about
  // `password`, which could be anything and must not be remembered).
  if (cached === undefined) {
    cache?.set(saltB64, key);
    cache?.rememberPassword(password);
  }
  return plaintext;
}

export class CensorKeyCache {
  private readonly keys = new Map<string, CryptoKey>();
  private readonly passwords = new Set<string>();

  get(saltB64: string): CryptoKey | undefined {
    return this.keys.get(saltB64);
  }

  set(saltB64: string, key: CryptoKey): void {
    this.keys.set(saltB64, key);
  }

  rememberPassword(password: string): void {
    this.passwords.add(password);
  }

  async tryUnlock(token: string): Promise<string | null> {
    const parsed = parseToken(token);
    if (parsed === null) return null;
    const saltB64 = bytesToBase64url(parsed.salt);
    const cached = this.keys.get(saltB64);
    if (cached !== undefined) {
      try {
        return await decryptParsed(parsed, cached);
      } catch {
        return null;
      }
    }
    for (const password of this.passwords) {
      const key = await deriveKey(password, parsed.salt);
      try {
        const plaintext = await decryptParsed(parsed, key);
        this.keys.set(saltB64, key);
        return plaintext;
      } catch (error) {
        if (error instanceof CensorError && error.code === 'bad_password') continue;
        throw error;
      }
    }
    return null;
  }

  clear(): void {
    this.keys.clear();
    this.passwords.clear();
  }
}

// Pure module singleton: no global listeners here; the UI wires pagehide/lock/sign-out to clear().
export const censorKeys = new CensorKeyCache();
