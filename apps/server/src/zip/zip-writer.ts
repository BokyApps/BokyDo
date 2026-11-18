import { open, type FileHandle } from 'node:fs/promises';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';

/**
 * A streaming ZIP writer (deflate, data descriptors, no ZIP64): entries are written as they come,
 * so exports and backups never have to fit in memory. Names are sanitised to forward-slash
 * relative paths. Archives are refused beyond 4 GiB or 65,535 entries rather than written in
 * a form some tools can't read.
 */
export class ZipWriter {
  readonly stream = new PassThrough();
  private offset = 0;
  private readonly central: Buffer[] = [];
  private count = 0;
  private finished = false;

  constructor() {
    // A producer may fail before the response is attached (a hostile note is parsed first). An
    // unobserved `'error'` event would otherwise be uncaught; the route's own listener still runs.
    this.stream.on('error', () => undefined);
  }

  /** Add a file from a buffer, string or stream. Resolves when it has been fully written. */
  async add(
    name: string,
    data: Buffer | string | Readable,
    opts: { date?: Date } = {},
  ): Promise<void> {
    if (this.finished) throw new Error('zip already finished');
    if (this.count >= 0xffff) throw new ZipLimitError('too many entries');
    const fileName = Buffer.from(safeEntryName(name), 'utf8');
    const { time, date } = dosDateTime(opts.date ?? new Date());
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // crc and sizes (offsets 14-25) are zero: they follow in the data descriptor
    header.writeUInt16LE(fileName.length, 26);
    header.writeUInt16LE(0, 28);
    const localOffset = this.offset;
    await this.write(Buffer.concat([header, fileName]));

    let crc = 0;
    let size = 0;
    let compressed = 0;
    /** Counts uncompressed bytes and their CRC before the compressor sees them. */
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    /** Counts compressed bytes; the deflate stream's own output is not buffered here. */
    const count = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        compressed += chunk.length;
        callback(null, chunk);
      },
    });
    const input: Readable =
      typeof data === 'string' || Buffer.isBuffer(data)
        ? Readable.from([typeof data === 'string' ? Buffer.from(data) : data])
        : data;
    const deflate = createDeflateRaw({ level: 6 });
    // One pipeline, one promise per entry. `pipeline` observes every error — a reader that goes
    // away (backpressure, then `destroy`) rejects this promise once — so there is no second,
    // unobserved rejection. Both ends are destroyed explicitly in `finally`: the compressor can
    // still hold buffered input when the destination dies, and the caller's stream must not be
    // left open.
    try {
      await pipeline(input, digest, deflate, count, this.stream, { end: false });
    } finally {
      if (!input.destroyed) input.destroy();
      if (!deflate.destroyed) deflate.destroy();
    }
    this.offset += compressed;
    if (size > 0xfffffffe || this.offset > 0xfffffffe) throw new ZipLimitError('archive too large');

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4); // made by: Unix, spec 3.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0808, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc >>> 0, 16);
    entry.writeUInt32LE(compressed, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE((0o100600 << 16) >>> 0, 38); // regular file, 0600
    entry.writeUInt32LE(localOffset, 42);
    this.central.push(Buffer.concat([entry, fileName]));
    this.count++;
  }

  /**
   * Add a file from disk. The file is opened before the entry header is written, so a missing
   * file returns false and leaves no half-written entry; any other open error throws. Once the
   * entry has started, a read error rejects: the caller aborts the archive, because a ZIP that
   * silently drops or truncates a file is worse than a broken download.
   */
  async addFile(name: string, filePath: string, opts: { date?: Date } = {}): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(filePath, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    try {
      // autoClose: false keeps the descriptor ours, so the finally below is the single close.
      await this.add(name, handle.createReadStream({ autoClose: false }), opts);
    } finally {
      await handle.close().catch(() => undefined);
    }
    return true;
  }

  /** Write the central directory and end the stream. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const start = this.offset;
    const dir = Buffer.concat(this.central);
    await this.write(dir);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    this.stream.end();
  }

  /** Abort: end the stream with an error so the reader sees a broken archive, not a short one. */
  abort(err: Error): void {
    this.finished = true;
    this.stream.destroy(err);
  }

  private async write(buf: Buffer): Promise<void> {
    this.offset += buf.length;
    if (!this.stream.write(buf)) await waitFor(this.stream, 'drain');
  }
}

/**
 * Resolve on `event`, reject on `'error'` or `'close'`: a writer whose reader has gone away must
 * not wait for a `'drain'` that is never coming.
 */
function waitFor(
  stream: NodeJS.EventEmitter & { destroyed?: boolean },
  event: string,
): Promise<void> {
  if (stream.destroyed) return Promise.reject(new Error('zip stream closed'));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off(event, onEvent);
      stream.off('error', onError);
      stream.off('close', onClose);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('zip stream closed'));
    };
    stream.once(event, onEvent);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

export class ZipLimitError extends Error {}

/** One path component may not exceed this many UTF-8 bytes (Windows' own practical limit). */
const MAX_COMPONENT_BYTES = 200;
/** Windows refuses these device names, with or without an extension. `¹²³` count as digits. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
/** Characters Windows refuses in a name, plus the archive's own separator (handled apart). */
const FORBIDDEN_CHARS = /[:*?"<>|]/g;

/** `text` cut to at most `max` UTF-8 bytes without splitting a character. */
function trimToBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  // `toString` replaces the partial trailing sequence with U+FFFD, which is dropped again.
  let cut = bytes.subarray(0, max).toString('utf8');
  let end = cut.length;
  while (end > 0 && cut.charAt(end - 1) === '\uFFFD') end--;
  cut = cut.slice(0, end);
  return trimTrailing(cut);
}

/** Windows drops trailing dots and spaces, which would let two entries collide. */
function trimTrailing(text: string): string {
  let end = text.length;
  while (end > 0) {
    const ch = text.charAt(end - 1);
    if (ch !== '.' && ch !== ' ') break;
    end--;
  }
  return text.slice(0, end);
}

/**
 * One archive path component: control characters and Windows-forbidden characters removed, no
 * drive prefix (`C:`), no trailing dot or space, no reserved device name, and at most 200 UTF-8
 * bytes.
 */
function safeComponent(part: string): string | null {
  if (part === '' || part === '.' || part === '..') return null;
  // A drive designator is not a directory.
  if (/^[a-z]:$/i.test(part)) return null;
  let clean = trimTrailing(
    part
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .replace(FORBIDDEN_CHARS, '_')
      .trim(),
  );
  if (clean === '' || clean === '.' || clean === '..') return null;
  const dot = clean.indexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  if (RESERVED_NAME.test(stem)) clean = `_${clean}`;
  clean = trimTrailing(trimToBytes(clean, MAX_COMPONENT_BYTES).trim());
  return clean === '' ? null : clean;
}

/** A relative, forward-slash path without `..`, drive prefixes or Windows-forbidden names. */
export function safeEntryName(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .map(safeComponent)
    .filter((part): part is string => part !== null);
  const joined = trimToBytes(parts.join('/'), 400);
  return joined || 'file';
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}
