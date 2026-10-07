import { hashRaw } from '@node-rs/argon2';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

/**
 * The encrypted backup file: `BOKYDOBK`, a length-prefixed JSON header (format, versions, KDF
 * parameters), then the payload in AES-256-GCM chunks of up to 64 KiB.
 *
 * Chunking follows the STREAM construction (Hoang, Reyhanitabar, Rogaway, Vizár): each nonce is a
 * random 7-byte prefix, a 32-bit chunk counter and a last-chunk flag, and every chunk authenticates
 * the header. Reordered, dropped, duplicated, truncated or appended chunks fail to decrypt, as
 * does any change to the header. The key comes from the passphrase through argon2id.
 */
const MAGIC = Buffer.from('BOKYDOBK');
export const CHUNK = 64 * 1024;
const TAG = 16;
const MAX_HEADER = 16 * 1024;

export interface BackupHeader {
  format: 'bokydo-backup';
  version: 1;
  createdAt: string;
  app: string;
  kdf: {
    alg: 'argon2id';
    memoryKiB: number;
    iterations: number;
    parallelism: number;
    salt: string;
  };
  noncePrefix: string;
}

export class BackupFormatError extends Error {}
/** Wrong passphrase, or the file was changed: indistinguishable on purpose. */
export class BackupAuthError extends Error {
  constructor() {
    super('The passphrase is wrong or the backup file is damaged');
  }
}

const KDF = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 };

async function deriveKey(passphrase: string, kdf: BackupHeader['kdf']): Promise<Buffer> {
  return hashRaw(passphrase.normalize('NFC'), {
    salt: Buffer.from(kdf.salt, 'base64url'),
    memoryCost: kdf.memoryKiB,
    timeCost: kdf.iterations,
    parallelism: kdf.parallelism,
    outputLen: 32,
  });
}

function nonce(prefix: Buffer, counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, 7);
  n[11] = last ? 1 : 0;
  return n;
}

/** Streams plaintext into an encrypted backup on `out`. Call `end()` exactly once. */
export class BackupEncryptor {
  private buffered: Buffer[] = [];
  private size = 0;
  private counter = 0;
  private constructor(
    private readonly out: Writable,
    private readonly key: Buffer,
    private readonly prefix: Buffer,
    private readonly aad: Buffer,
  ) {}

  static async create(out: Writable, passphrase: string, app: string): Promise<BackupEncryptor> {
    const kdf = { alg: 'argon2id' as const, ...KDF, salt: randomBytes(16).toString('base64url') };
    const prefix = randomBytes(7);
    const header: BackupHeader = {
      format: 'bokydo-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      app,
      kdf,
      noncePrefix: prefix.toString('base64url'),
    };
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length);
    const head = Buffer.concat([MAGIC, len, json]);
    const enc = new BackupEncryptor(
      out,
      await deriveKey(passphrase, kdf),
      prefix,
      createHash('sha256').update(head).digest(),
    );
    await enc.emit(head);
    return enc;
  }

  async write(data: Buffer): Promise<void> {
    let rest = data;
    while (rest.length) {
      const take = Math.min(CHUNK - this.size, rest.length);
      this.buffered.push(rest.subarray(0, take));
      this.size += take;
      rest = rest.subarray(take);
      if (this.size === CHUNK) await this.flush(false);
    }
  }

  async end(): Promise<void> {
    await this.flush(true);
    this.key.fill(0);
    await new Promise<void>((resolve, reject) =>
      this.out.end((err?: Error | null) => (err ? reject(err) : resolve())),
    );
  }

  private async flush(last: boolean): Promise<void> {
    if (this.counter === 0xffffffff) throw new BackupFormatError('backup too large');
    const plain = Buffer.concat(this.buffered);
    this.buffered = [];
    this.size = 0;
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.key,
      nonce(this.prefix, this.counter++, last),
      {
        authTagLength: TAG,
      },
    );
    cipher.setAAD(this.aad);
    const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ct.length);
    await this.emit(Buffer.concat([len, ct]));
  }

  private async emit(buf: Buffer): Promise<void> {
    if (!this.out.write(buf)) await new Promise((r) => this.out.once('drain', r));
  }
}

/** Reads exact byte counts from a stream. */
class ByteReader {
  private buf = Buffer.alloc(0);
  private readonly it: AsyncIterator<Buffer>;
  constructor(src: Readable) {
    this.it = (src as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  }
  /** Exactly n bytes, or null at a clean end of stream (nothing buffered). */
  async read(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      const next = await this.it.next();
      if (next.done) {
        if (this.buf.length === 0) return null;
        throw new BackupFormatError('truncated backup');
      }
      this.buf = Buffer.concat([this.buf, next.value]);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

/** Read just the (unauthenticated until decryption) header, e.g. to list a backup's date. */
export async function readHeader(src: Readable): Promise<BackupHeader> {
  return (await openHeader(new ByteReader(src))).header;
}

async function openHeader(reader: ByteReader): Promise<{ header: BackupHeader; head: Buffer }> {
  const magic = await reader.read(MAGIC.length);
  if (!magic || !magic.equals(MAGIC)) throw new BackupFormatError('not a BokyDo backup');
  const len = await reader.read(4);
  const n = len?.readUInt32BE() ?? 0;
  if (n === 0 || n > MAX_HEADER) throw new BackupFormatError('bad header');
  const json = await reader.read(n);
  if (!json || !len) throw new BackupFormatError('bad header');
  let header: BackupHeader;
  try {
    header = JSON.parse(json.toString('utf8')) as BackupHeader;
  } catch {
    throw new BackupFormatError('bad header');
  }
  const k = header.kdf;
  // The file is untrusted until decrypted: refuse KDF settings that could exhaust the server.
  if (
    header.format !== 'bokydo-backup' ||
    header.version !== 1 ||
    k?.alg !== 'argon2id' ||
    !Number.isInteger(k.memoryKiB) ||
    k.memoryKiB < 8 * 1024 ||
    k.memoryKiB > 256 * 1024 ||
    !Number.isInteger(k.iterations) ||
    k.iterations < 1 ||
    k.iterations > 10 ||
    k.parallelism !== 1 ||
    Buffer.from(k.salt ?? '', 'base64url').length !== 16 ||
    Buffer.from(header.noncePrefix ?? '', 'base64url').length !== 7
  )
    throw new BackupFormatError('unsupported backup format');
  return { header, head: Buffer.concat([MAGIC, len, json]) };
}

/**
 * Decrypt a backup, yielding authenticated plaintext chunks in order. Throws BackupAuthError on a
 * wrong passphrase or any tampering, BackupFormatError on a malformed or truncated file. Callers
 * must not act on yielded data until the generator has finished, or must be able to roll back:
 * truncation is only detected at the end.
 */
export async function* decryptBackup(
  src: Readable,
  passphrase: string,
): AsyncGenerator<Buffer, BackupHeader> {
  const reader = new ByteReader(src);
  const { header, head } = await openHeader(reader);
  const key = await deriveKey(passphrase, header.kdf);
  const prefix = Buffer.from(header.noncePrefix, 'base64url');
  const aad = createHash('sha256').update(head).digest();
  let counter = 0;
  let sawLast = false;
  try {
    for (;;) {
      const len = await reader.read(4);
      if (!len) break;
      if (sawLast) throw new BackupAuthError(); // data after the final chunk
      const n = len.readUInt32BE();
      if (n < TAG || n > CHUNK + TAG) throw new BackupFormatError('bad chunk');
      const ct = await reader.read(n);
      if (!ct) throw new BackupFormatError('truncated backup');
      const body = ct.subarray(0, n - TAG);
      const tag = ct.subarray(n - TAG);
      // A chunk is the last one iff it decrypts with the last-chunk flag set.
      let plain: Buffer | null = null;
      for (const last of [n - TAG < CHUNK, n - TAG === CHUNK]) {
        try {
          const d = createDecipheriv('aes-256-gcm', key, nonce(prefix, counter, last), {
            authTagLength: TAG,
          });
          d.setAAD(aad);
          d.setAuthTag(tag);
          plain = Buffer.concat([d.update(body), d.final()]);
          sawLast = last;
          break;
        } catch {
          // try the other flag
        }
      }
      if (!plain) throw new BackupAuthError();
      counter++;
      yield plain;
    }
    if (!sawLast)
      throw counter === 0 ? new BackupAuthError() : new BackupFormatError('truncated backup');
    return header;
  } finally {
    key.fill(0);
  }
}
