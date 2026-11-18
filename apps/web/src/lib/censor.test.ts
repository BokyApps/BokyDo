import { describe, expect, it } from 'vitest';
import {
  CENSOR_PLACEHOLDER,
  CENSOR_TOKEN_RE,
  CensorError,
  CensorKeyCache,
  censor,
  censorKeys,
  parseToken,
  uncensor,
} from './censor.js';

// Test-only unpadded base64url encoder. `btoa` is given a binary string built byte by byte, so it
// never sees a multi-byte JS string (all char codes are 0-255).
function b64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replaceAll('=', '');
}

function makeToken(salt: Uint8Array, iv: Uint8Array, ct: Uint8Array): string {
  return `{{censored:v1:${b64(salt)}:${b64(iv)}:${b64(ct)}}}`;
}

function flip(bytes: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ 1;
  return copy;
}

const SALT = new Uint8Array(16).fill(0x11);
const IV = new Uint8Array(12).fill(0x22);
const CT = new Uint8Array(20).fill(0x33);

describe('constants', () => {
  it('exports the fixed-width block placeholder', () => {
    expect(CENSOR_PLACEHOLDER).toBe('█████');
  });

  it('exposes a pure module singleton key cache', () => {
    expect(censorKeys).toBeInstanceOf(CensorKeyCache);
    censorKeys.clear();
  });
});

describe('CENSOR_TOKEN_RE', () => {
  it('finds tokens inside surrounding text', () => {
    CENSOR_TOKEN_RE.lastIndex = 0;
    const token = makeToken(SALT, IV, CT);
    const other = makeToken(SALT, IV, flip(CT, 0));
    const text = `before ${token} middle ${other} after`;
    expect(text.match(CENSOR_TOKEN_RE)).toEqual([token, other]);
  });

  it('does not hang on 1 MB adversarial strings (assert < 200 ms)', () => {
    const runs = [
      '{{censored:v1:' + 'a'.repeat(1024 * 1024), // one huge run, no closing delimiter
      ('{{censored:v1:' + 'a'.repeat(2000) + ':').repeat(530), // many near-miss starts
    ];
    for (const adversarial of runs) {
      expect(adversarial.length).toBeGreaterThan(1024 * 1024);
      CENSOR_TOKEN_RE.lastIndex = 0;
      const start = performance.now();
      const matches = adversarial.match(CENSOR_TOKEN_RE);
      const elapsed = performance.now() - start;
      expect(matches).toBeNull();
      expect(elapsed).toBeLessThan(200);
    }
  });
});

describe('parseToken', () => {
  it('accepts a well-formed token and returns decoded byte arrays', () => {
    const parsed = parseToken(makeToken(SALT, IV, CT));
    expect(parsed).not.toBeNull();
    expect(parsed!.salt.length).toBe(16);
    expect(parsed!.iv.length).toBe(12);
    expect(parsed!.ct.length).toBe(20);
  });

  it('rejects padding, non-alphabet chars, extra colons, v2 and unanchored text', () => {
    const s = b64(SALT);
    const v = b64(IV);
    const c = b64(CT);
    expect(parseToken(`{{censored:v1:${s}==:${v}:${c}}}`)).toBeNull(); // '=' padding
    expect(parseToken(`{{censored:v1:${s}:${v}+:${c}}}`)).toBeNull(); // std-base64 '+'
    expect(parseToken(`{{censored:v1:${s}:${v}:${c}:extra}}`)).toBeNull(); // extra colon
    expect(parseToken(`{{censored:v1:${s}::${v}:${c}}}`)).toBeNull(); // extra colon / empty part
    expect(parseToken(`{{censored:v2:${s}:${v}:${c}}}`)).toBeNull(); // version must be v1
    expect(parseToken(`{{censored:v1:${s}:${v}:${c}`)).toBeNull(); // missing }}
    expect(parseToken(`text {{censored:v1:${s}:${v}:${c}}} text`)).toBeNull(); // not whole token
  });

  it('rejects wrong salt/iv/ct byte lengths, including the size bounds', () => {
    expect(parseToken(makeToken(new Uint8Array(15), IV, CT))).toBeNull();
    expect(parseToken(makeToken(new Uint8Array(17), IV, CT))).toBeNull();
    expect(parseToken(makeToken(SALT, new Uint8Array(11), CT))).toBeNull();
    expect(parseToken(makeToken(SALT, new Uint8Array(13), CT))).toBeNull();
    expect(parseToken(makeToken(SALT, IV, new Uint8Array(16)))).toBeNull(); // tag only, < 17
    expect(parseToken(makeToken(SALT, IV, new Uint8Array(65_537)))).toBeNull(); // > 64 KiB
    expect(parseToken(makeToken(SALT, IV, new Uint8Array(17)))?.ct.length).toBe(17);
    expect(parseToken(makeToken(SALT, IV, new Uint8Array(65_536)))?.ct.length).toBe(65_536);
  });
});

describe('censor / uncensor', () => {
  it('round-trips emoji, multibyte text and markdown', async () => {
    const text = '# H 😀\n\n- café ☕ naïve\n- **bold** `code` [link](https://example.com)\n';
    const token = await censor(text, 'correct horse');
    expect(parseToken(token)).not.toBeNull();
    CENSOR_TOKEN_RE.lastIndex = 0;
    expect(token.match(CENSOR_TOKEN_RE)).toEqual([token]);
    expect(await uncensor(token, 'correct horse')).toBe(text);
  }, 30_000);

  it('rejects a wrong password with bad_password', async () => {
    const token = await censor('secret', 'right');
    await expect(uncensor(token, 'wrong')).rejects.toMatchObject({ code: 'bad_password' });
  }, 30_000);

  it('throws typed errors for empty password, oversized text and malformed tokens', async () => {
    await expect(censor('x', '')).rejects.toMatchObject({ code: 'empty_password' });
    await expect(censor('a'.repeat(48 * 1024 + 1), 'pw')).rejects.toMatchObject({
      code: 'too_large',
    });
    await expect(uncensor('not-a-token', 'pw')).rejects.toMatchObject({ code: 'malformed' });
    await expect(uncensor(makeToken(new Uint8Array(15), IV, CT), 'pw')).rejects.toMatchObject({
      code: 'malformed',
    });
  });

  it('produces a different token for the same text and password each time', async () => {
    const a = await censor('same', 'pw');
    const b = await censor('same', 'pw');
    expect(a).not.toBe(b);
    expect(b64(parseToken(a)!.salt)).not.toBe(b64(parseToken(b)!.salt));
  }, 30_000);

  it('never reveals plaintext when salt/iv/ct/AAD are tampered', async () => {
    const cache = new CensorKeyCache();
    const text = 'top secret';
    const pw = 'pw';
    const token = await censor(text, pw); // derivation 1
    // A successful reveal populates the cache with the derived key for this salt.
    expect(await uncensor(token, pw, cache)).toBe(text); // derivation 2
    const parts = parseToken(token)!;
    const key = cache.get(b64(parts.salt))!;

    // Ciphertext authenticated against a flipped AAD, using the cached key (no extra derivation).
    const badAad = new TextEncoder().encode('bokydo-censor-v0');
    const ctBadAad = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: parts.iv, additionalData: badAad, tagLength: 128 },
        key,
        new TextEncoder().encode(text),
      ),
    );
    const candidates = [
      makeToken(flip(parts.salt, 0), parts.iv, parts.ct), // flipped salt (cache miss -> 1 deriv)
      makeToken(parts.salt, flip(parts.iv, 0), parts.ct), // flipped iv
      makeToken(parts.salt, parts.iv, flip(parts.ct, 0)), // flipped ct
      makeToken(parts.salt, parts.iv, ctBadAad), // flipped AAD
    ];
    for (const candidate of candidates) {
      let resolved: string | undefined;
      let error: unknown;
      try {
        resolved = await uncensor(candidate, pw, cache);
      } catch (err) {
        error = err;
      }
      expect(resolved).toBeUndefined(); // never returns plaintext, wrong or otherwise
      expect(error).toBeInstanceOf(CensorError);
      expect(['bad_password', 'malformed']).toContain((error as CensorError).code);
    }
  }, 30_000);
});

describe('CensorKeyCache', () => {
  it('unlocks another span via a remembered password and forgets them on clear()', async () => {
    const cache = new CensorKeyCache();
    const pw = 'shared password';
    const token1 = await censor('first span', pw); // derivation 1
    const token2 = await censor('second span', pw); // derivation 2
    expect(await cache.tryUnlock(token1)).toBeNull(); // fresh cache knows nothing

    // A successful reveal remembers the password and caches the key for token1's salt.
    expect(await uncensor(token1, pw, cache)).toBe('first span'); // derivation 3
    expect(await cache.tryUnlock(token1)).toBe('first span'); // cached key, no derivation

    // token2 has a different salt: tryUnlock re-derives from the remembered password.
    expect(await cache.tryUnlock(token2)).toBe('second span'); // derivation 4

    // clear() drops all keys and passwords; nothing unlocks without a password again.
    cache.clear();
    expect(await cache.tryUnlock(token1)).toBeNull();
    expect(await cache.tryUnlock(token2)).toBeNull();
  }, 30_000);
});
