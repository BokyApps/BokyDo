import { open, type FileHandle } from 'node:fs/promises';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';

/**
 * A streaming ZIP writer (deflate, data descriptors, no ZIP64): entries are written as they come,
 * so exports and backups never have to fit in memory. Names are sanitised to forward-slash
 * relative paths. Archives are refused beyond 4 GiB or 65,535 entries rather than written in
 * a form some tools can't read.
 *
 * The writer can be given the caller's disconnect `signal` and export `deadline`. A destroyed
 * output (a client that went away) and an aborted signal both stop the producer at once; the
 * deadline is checked between chunks, and the caller's own timer is what destroys a producer that
 * is stalled on a stream nobody reads.
 */

/** The part of an export deadline a zip producer needs: fail once it has passed. */
export interface ZipDeadline {
  check(): void;
}

export interface ZipWriterOptions {
  /** Aborted on a client disconnect (or by the caller's deadline timer). */
  signal?: AbortSignal;
  /** Checked between entries, chunks and writes. */
  deadline?: ZipDeadline;
}

export interface ZipEntryOptions {
  date?: Date;
  /** Test hook: called after each chunk read from a file, so a test can count real reads. */
  onRead?: () => void;
}

/** One file read buffer: small enough that a disconnect is noticed promptly. */
const FILE_CHUNK_BYTES = 64 * 1024;

export class ZipWriter {
  readonly stream = new PassThrough();
  private offset = 0;
  private readonly central: Buffer[] = [];
  private count = 0;
  private finished = false;
  /** Entry destinations currently piped into the shared output, so a close reaches all of them. */
  private readonly entries = new Set<PassThrough>();
  private readonly onAbort: () => void;

  constructor(private readonly options: ZipWriterOptions = {}) {
    // A producer may fail before the response is attached (a hostile note is parsed first). An
    // unobserved `'error'` event would otherwise be uncaught; the route's own listener still runs.
    this.stream.on('error', () => undefined);
    // One permanent close/error handler for every entry, instead of one per entry pipeline that
    // could outlive it. Nothing is added to the shared output per entry, so its listener count
    // is the same after 1 entry and after 10,000.
    this.stream.on('close', () => this.destroyEntries(new Error('zip stream closed')));
    this.stream.on('error', (err: Error) => this.destroyEntries(err));
    this.stream.once('close', () =>
      this.options.signal?.removeEventListener('abort', this.onAbort),
    );
    this.onAbort = () => this.abort(abortReason(this.options.signal));
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    // Adding a listener to an already-aborted signal never fires it: check once explicitly.
    if (options.signal?.aborted) this.abort(abortReason(options.signal));
  }

  /** Add a file from a buffer, string or stream. Resolves when it has been fully written. */
  async add(
    name: string,
    data: Buffer | string | Readable,
    opts: ZipEntryOptions = {},
  ): Promise<void> {
    if (this.finished) throw new Error('zip already finished');
    this.checkOpen();
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
    // A per-entry destination wrapper: the pipeline owns it and tears it down in `finally`, and
    // it is piped into the shared output with `end: false`. The shared output never gets a
    // listener from the entry itself (it already has one permanent close/error handler), so a
    // long archive cannot accumulate them and trip MaxListenersExceededWarning.
    const entryOut = new PassThrough();
    this.entries.add(entryOut);
    entryOut.pipe(this.stream, { end: false });
    try {
      // One pipeline, one promise per entry. `pipeline` observes every error — a reader that goes
      // away (backpressure, then `destroy`) rejects this promise once — so there is no second,
      // unobserved rejection. Both ends are destroyed explicitly in `finally`.
      await pipeline(input, digest, deflate, count, entryOut);
    } finally {
      this.entries.delete(entryOut);
      entryOut.unpipe(this.stream);
      if (!entryOut.destroyed) entryOut.destroy();
      if (!input.destroyed) input.destroy();
      if (!deflate.destroyed) deflate.destroy();
    }
    this.checkOpen();
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
   * Add a file from disk, reading 64 KiB at a time so a disconnect or deadline stops the reads
   * between chunks. The file is opened before the entry header is written, so a missing file
   * returns false and leaves no half-written entry; any other open error throws. Once the entry
   * has started, a read error rejects: the caller aborts the archive, because a ZIP that
   * silently drops or truncates a file is worse than a broken download.
   */
  async addFile(name: string, filePath: string, opts: ZipEntryOptions = {}): Promise<boolean> {
    this.checkOpen();
    let handle: FileHandle;
    try {
      handle = await open(filePath, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    try {
      await this.add(name, Readable.from(this.fileChunks(handle, opts)), opts);
    } finally {
      await handle.close().catch(() => undefined);
    }
    return true;
  }

  /** Write the central directory and end the stream. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.checkOpen();
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
    this.options.signal?.removeEventListener('abort', this.onAbort);
    if (!this.stream.destroyed) this.stream.destroy(err);
  }

  private checkOpen(): void {
    if (this.options.signal?.aborted) throw abortReason(this.options.signal);
    this.options.deadline?.check();
  }

  private destroyEntries(err: Error): void {
    for (const entry of this.entries) if (!entry.destroyed) entry.destroy(err);
  }

  /** One file's bytes, 64 KiB at a time, checking the signal and deadline before each read. */
  private async *fileChunks(handle: FileHandle, opts: ZipEntryOptions): AsyncGenerator<Buffer> {
    const buffer = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      this.checkOpen();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      opts.onRead?.();
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
  }

  private async write(buf: Buffer): Promise<void> {
    this.checkOpen();
    this.offset += buf.length;
    if (!this.stream.write(buf)) await waitFor(this.stream, 'drain');
  }
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('zip export aborted');
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
/** Windows refuses these device names, with or without an extension. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
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
 * Whether this file name is a Windows device name. Windows compares the part before the first
 * dot, after dropping trailing spaces and dots, and folds compatibility characters — so `COM¹`,
 * `ＣＯＮ` and `con. .txt` are the same name as `COM1` and `CON`. NFKC turns the superscript
 * digits and full-width forms into their ASCII equivalents.
 */
export function reservedWindowsName(name: string): boolean {
  const trimmed = trimTrailing(name.trim());
  const dot = trimmed.indexOf('.');
  const stem = trimTrailing(dot >= 0 ? trimmed.slice(0, dot) : trimmed).normalize('NFKC');
  return RESERVED_NAME.test(stem);
}

/** Prefix `_` when Windows would read the name as a device, leaving everything else alone. */
export function avoidReservedWindowsName(name: string): string {
  return reservedWindowsName(name) ? `_${name}` : name;
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
  if (reservedWindowsName(clean)) clean = `_${clean}`;
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
