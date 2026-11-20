import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
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

/**
 * An independent v1 implementation (Node's crypto, not WebCrypto): pins PBKDF2-SHA-256 at
 * 600,000 iterations, AES-256-GCM with a 128-bit tag and the `bokydo-censor-v1` AAD.
 */
const V1 = { iterations: 600_000, aad: Buffer.from('bokydo-censor-v1') };
const nodeKey = (pw: string, salt: Uint8Array) => pbkdf2Sync(pw, salt, V1.iterations, 32, 'sha256');
function nodeEncrypt(text: string, pw: string, opts: { aad?: Buffer; key?: Buffer } = {}) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', opts.key ?? nodeKey(pw, salt), iv);
  cipher.setAAD(opts.aad ?? V1.aad);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { salt, iv, ct, token: makeToken(salt, iv, ct) };
}
function nodeDecrypt(token: string, pw: string): string {
  const { salt, iv, ct } = parseToken(token)!;
  // nosemgrep: javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length -- test-only reference decryptor; the tag passed below is always exactly 16 bytes
  const decipher = createDecipheriv('aes-256-gcm', nodeKey(pw, salt), iv);
  decipher.setAAD(V1.aad);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([
    decipher.update(ct.subarray(0, ct.length - 16)),
    decipher.final(),
  ]).toString('utf8');
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
    await expect(censor('x', '')).rejects.toBeInstanceOf(CensorError);
    await expect(censor('x', '')).rejects.toMatchObject({ code: 'empty_password' });
    await expect(censor('', 'pw')).rejects.toMatchObject({ code: 'empty_text' });
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

  it('matches an independent v1 implementation in both directions', async () => {
    const text = '\uFEFFstarts with a BOM — and ünïcödé';
    const token = await censor(text, 'pw');
    expect(nodeDecrypt(token, 'pw')).toBe(text);
    expect(await uncensor(nodeEncrypt(text, 'pw').token, 'pw')).toBe(text);
  }, 30_000);

  it('draws a fresh salt and IV for every token', async () => {
    const a = parseToken(await censor('same', 'pw'))!;
    const b = parseToken(await censor('same', 'pw'))!;
    expect(b64(a.salt)).not.toBe(b64(b.salt));
    expect(b64(a.iv)).not.toBe(b64(b.iv));
  }, 30_000);

  it('never reveals plaintext when salt/iv/ct/AAD are tampered', async () => {
    const text = 'top secret';
    const pw = 'pw';
    const { salt, iv, ct } = nodeEncrypt(text, pw);
    const key = nodeKey(pw, salt);
    const candidates = [
      makeToken(flip(salt, 0), iv, ct),
      makeToken(salt, flip(iv, 0), ct),
      makeToken(salt, iv, flip(ct, 0)),
      makeToken(salt, iv, flip(ct, ct.length - 1)), // the tag
      nodeEncrypt(text, pw, { key, aad: Buffer.from('bokydo-censor-v0') }).token, // other AAD
    ];
    for (const candidate of candidates)
      await expect(uncensor(candidate, pw)).rejects.toMatchObject({ code: 'bad_password' });
  }, 60_000);

  it('rejects non-canonical base64url tail bits and oversized fields before decoding', () => {
    const s = b64(SALT); // 22 chars: the last one carries 4 unused bits
    const last = s.at(-1)!;
    const sibling =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(last) ^ 1;
    const nonCanonical =
      s.slice(0, -1) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[sibling];
    expect(parseToken(`{{censored:v1:${nonCanonical}:${b64(IV)}:${b64(CT)}}}`)).toBeNull();
    const huge = 'A'.repeat(4_000_000);
    const start = performance.now();
    expect(parseToken(`{{censored:v1:${huge}:${b64(IV)}:${b64(CT)}}}`)).toBeNull();
    expect(parseToken(`{{censored:v1:${b64(SALT)}:${b64(IV)}:${huge}}}`)).toBeNull();
    expect(performance.now() - start).toBeLessThan(200);
  });
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

  it('never lets a warm cache accept a wrong password', async () => {
    const cache = new CensorKeyCache();
    const token = await censor('span', 'right');
    expect(await uncensor(token, 'right', cache)).toBe('span');
    await expect(uncensor(token, 'wrong', cache)).rejects.toMatchObject({ code: 'bad_password' });
  }, 30_000);

  it('keeps a planted token that reuses a real salt from taking over that span', async () => {
    const cache = new CensorKeyCache();
    const real = nodeEncrypt('real secret', 'real pw');
    // Same salt, encrypted under the attacker's password.
    const planted = (() => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', nodeKey('attacker pw', real.salt), iv);
      cipher.setAAD(V1.aad);
      const ct = Buffer.concat([cipher.update('decoy'), cipher.final(), cipher.getAuthTag()]);
      return makeToken(real.salt, iv, ct);
    })();
    expect(await uncensor(planted, 'attacker pw', cache)).toBe('decoy');
    // The real span still opens with its own password, and its cache entry is its own.
    expect(await uncensor(real.token, 'real pw', cache)).toBe('real secret');
    expect(await cache.tryUnlock(real.token)).toBe('real secret');
    expect(await cache.tryUnlock(planted)).toBe('decoy');
  }, 60_000);

  it('voids an explicit unlock that was in flight when the cache was cleared', async () => {
    const cache = new CensorKeyCache();
    const token = await censor('span', 'pw');
    const pending = uncensor(token, 'pw', cache);
    cache.clear();
    await expect(pending).rejects.toMatchObject({ code: 'locked' });
    expect(await cache.tryUnlock(token)).toBeNull(); // nothing was repopulated
  }, 30_000);

  it('ignores a remember() that finishes after the cache was cleared', async () => {
    const cache = new CensorKeyCache();
    const { salt, token } = nodeEncrypt('span', 'pw');
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      nodeKey('pw', salt),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const generation = cache.generation;
    cache.clear();
    await cache.remember(token, key, 'pw', generation);
    expect(await cache.tryUnlock(token)).toBeNull();
  }, 30_000);

  it('voids a remembered-password unlock that was in flight when the cache was cleared', async () => {
    const cache = new CensorKeyCache();
    const first = await censor('first', 'pw');
    const second = await censor('second', 'pw');
    expect(await uncensor(first, 'pw', cache)).toBe('first');
    const pending = cache.tryUnlock(second);
    expect(cache.tryUnlock(second)).toBe(pending); // concurrent requests are shared
    cache.clear();
    expect(await pending).toBeNull();
    expect(await cache.tryUnlock(first)).toBeNull();
  }, 30_000);
});
