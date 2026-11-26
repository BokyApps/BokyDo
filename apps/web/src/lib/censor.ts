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

type CensorErrorCode =
  'bad_password' | 'malformed' | 'too_large' | 'empty_password' | 'empty_text' | 'locked';

const ERROR_MESSAGES: Record<CensorErrorCode, string> = {
  bad_password: 'Wrong password or tampered censor token.',
  malformed: 'Malformed censor token.',
  too_large: 'Censored text is too large.',
  empty_password: 'Password must not be empty.',
  empty_text: 'There is no text to censor.',
  locked: 'Censored text was locked while unlocking.',
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

const B64URL_LOOKUP = new Map<string, number>(
  Array.from(B64URL_ALPHABET, (ch, i) => [ch, i] as const),
);

/** Unpadded base64url length of `bytes` bytes. */
const encodedLength = (bytes: number) => Math.ceil((bytes * 4) / 3);

function base64urlToBytes(text: string): Bytes | null {
  const remainder = text.length % 4;
  if (remainder === 1) return null;
  const size = Math.floor(text.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  const out = new Uint8Array(size);
  const lookup = B64URL_LOOKUP;
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
  // Check encoded lengths before decoding anything, so a huge field costs nothing.
  if (saltText.length !== encodedLength(SALT_BYTES) || ivText.length !== encodedLength(IV_BYTES))
    return null;
  if (ctText.length < encodedLength(MIN_CT_BYTES) || ctText.length > encodedLength(MAX_CT_BYTES))
    return null;
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
  // ignoreBOM: a span that starts with U+FEFF must decrypt to exactly what was censored.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buffer);
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
  // Always derive from the password the user typed: a warm cache must never make a wrong
  // password "work", and must never let a token borrow another span's key.
  const generation = cache?.generation;
  const key = await deriveKey(password, parsed.salt);
  const plaintext = await decryptParsed(parsed, key);
  if (cache) {
    // Lock or sign-out happened while we were deriving: discard the result entirely.
    if (cache.generation !== generation) throw new CensorError('locked');
    await cache.remember(token, key, password, generation);
  }
  return plaintext;
}

/** How many remembered passwords `tryUnlock` will try (each try costs one full PBKDF2). */
const MAX_REMEMBERED_ATTEMPTS = 3;

async function tokenDigest(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64url(new Uint8Array(digest));
}

/**
 * Session-only memory of unlocked spans. Keys are stored per exact token (SHA-256 of the whole
 * token, not just its salt), so a planted token that reuses a real span's salt can neither use
 * nor overwrite that span's entry. `clear()` bumps a generation: work that was in flight when the
 * user locked finishes without returning plaintext or repopulating anything.
 *
 * Call `tryUnlock` only from an explicit Reveal action, never on render or in bulk: each attempt
 * is a 600k-iteration PBKDF2, and a hostile note can contain many tokens.
 */
export class CensorKeyCache {
  private readonly keys = new Map<string, CryptoKey>();
  /** Most recent last; bounded so remembered-password unlocks stay cheap. */
  private passwords: string[] = [];
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private gen = 0;

  get generation(): number {
    return this.gen;
  }

  /** Record a successful unlock. Ignored if the cache was cleared since `generation`. */
  async remember(
    token: string,
    key: CryptoKey,
    password: string,
    generation = this.gen,
  ): Promise<void> {
    const digest = await tokenDigest(token);
    if (this.gen !== generation) return;
    this.keys.set(digest, key);
    this.passwords = [...this.passwords.filter((p) => p !== password), password].slice(
      -MAX_REMEMBERED_ATTEMPTS,
    );
  }

  /** Unlock with a key or password that already worked this session; null if none does. */
  tryUnlock(token: string): Promise<string | null> {
    const pending = this.inFlight.get(token);
    if (pending) return pending;
    const generation = this.gen;
    const run = this.unlock(token, generation).finally(() => {
      if (this.inFlight.get(token) === run) this.inFlight.delete(token);
    });
    this.inFlight.set(token, run);
    return run;
  }

  private async unlock(token: string, generation: number): Promise<string | null> {
    const parsed = parseToken(token);
    if (parsed === null) return null;
    const digest = await tokenDigest(token);
    const stale = () => this.gen !== generation;
    if (stale()) return null;
    const cached = this.keys.get(digest);
    if (cached !== undefined) {
      try {
        const plaintext = await decryptParsed(parsed, cached);
        return stale() ? null : plaintext;
      } catch {
        return null;
      }
    }
    for (const password of [...this.passwords].reverse()) {
      const key = await deriveKey(password, parsed.salt);
      if (stale()) return null;
      try {
        const plaintext = await decryptParsed(parsed, key);
        if (stale()) return null;
        this.keys.set(digest, key);
        return plaintext;
      } catch (error) {
        if (error instanceof CensorError && error.code === 'bad_password') continue;
        throw error;
      }
    }
    return null;
  }

  /** Forget every key and password, and void any unlock still in flight. */
  clear(): void {
    this.gen++;
    this.keys.clear();
    this.passwords = [];
    this.inFlight.clear();
  }
}

// Pure module singleton: no global listeners here; the UI wires pagehide/lock/sign-out to clear().
export const censorKeys = new CensorKeyCache();
