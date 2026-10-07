import { PassThrough, type Readable } from 'node:stream';
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
    const deflate = createDeflateRaw({ level: 6 });
    const done = new Promise<void>((resolve, reject) => {
      deflate.on('data', (chunk: Buffer) => {
        compressed += chunk.length;
        if (!this.stream.write(chunk)) {
          deflate.pause();
          this.stream.once('drain', () => deflate.resume());
        }
      });
      deflate.on('end', resolve);
      deflate.on('error', reject);
    });
    const feed = async (chunk: Buffer) => {
      crc = crc32(chunk, crc);
      size += chunk.length;
      if (!deflate.write(chunk)) await new Promise((r) => deflate.once('drain', r));
    };
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
      await feed(Buffer.from(data));
    } else {
      for await (const chunk of data)
        await feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    deflate.end();
    await done;
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
    if (!this.stream.write(buf)) await new Promise((r) => this.stream.once('drain', r));
  }
}

export class ZipLimitError extends Error {}

/** A relative, forward-slash path without `..`, control characters or a leading slash. */
export function safeEntryName(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.replace(/[\p{Cc}\p{Cf}]/gu, '').trim())
    .filter((p) => p !== '' && p !== '.' && p !== '..');
  const joined = parts.join('/').slice(0, 400);
  return joined || 'file';
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}
