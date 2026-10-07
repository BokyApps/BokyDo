import { BackupFormatError } from './crypto-stream.js';

/**
 * The plaintext inside a backup: a sequence of named entries, each streamed as length-prefixed
 * frames, then an end marker.
 *
 *   entry := 'E' u16 nameLength name (u32 frameLength frame)* u32 0
 *   end   := 'Z'
 *
 * Frames let a table dump of unknown size stream straight through; the end marker makes a cut-off
 * archive detectable even inside an intact encryption layer.
 */
export interface Sink {
  write(data: Buffer): Promise<void>;
}

export class ArchiveWriter {
  constructor(private readonly sink: Sink) {}

  async entry(name: string, data: Buffer | string | AsyncIterable<Buffer | string>): Promise<void> {
    const n = Buffer.from(name, 'utf8');
    if (n.length === 0 || n.length > 1024) throw new Error('bad entry name');
    const head = Buffer.alloc(3);
    head.write('E', 0);
    head.writeUInt16BE(n.length, 1);
    await this.sink.write(Buffer.concat([head, n]));
    const frame = async (chunk: Buffer) => {
      if (chunk.length === 0) return;
      for (let i = 0; i < chunk.length; i += 1 << 20) {
        const part = chunk.subarray(i, i + (1 << 20));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        await this.sink.write(Buffer.concat([len, part]));
      }
    };
    if (typeof data === 'string' || Buffer.isBuffer(data)) await frame(Buffer.from(data));
    else for await (const chunk of data) await frame(Buffer.from(chunk));
    await this.sink.write(Buffer.alloc(4));
  }

  async end(): Promise<void> {
    await this.sink.write(Buffer.from('Z'));
  }
}

/** Reads exact byte counts from a stream of chunks. */
class Bytes {
  private buf = Buffer.alloc(0);
  constructor(private readonly it: AsyncIterator<Buffer>) {}
  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      const next = await this.it.next();
      if (next.done) throw new BackupFormatError('truncated archive');
      this.buf = Buffer.concat([this.buf, next.value]);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async drained(): Promise<boolean> {
    if (this.buf.length) return false;
    const next = await this.it.next();
    return next.done === true && this.buf.length === 0;
  }
}

export interface ArchiveEntry {
  name: string;
  /** The entry's data; must be consumed fully before asking for the next entry. */
  data: AsyncIterable<Buffer>;
}

/** Iterate the entries of a decrypted archive. Throws on anything malformed or cut off. */
export async function* readArchive(chunks: AsyncIterable<Buffer>): AsyncGenerator<ArchiveEntry> {
  const bytes = new Bytes(chunks[Symbol.asyncIterator]());
  for (;;) {
    const kind = (await bytes.read(1)).toString();
    if (kind === 'Z') {
      if (!(await bytes.drained()))
        throw new BackupFormatError('data after the end of the archive');
      return;
    }
    if (kind !== 'E') throw new BackupFormatError('bad archive');
    const len = (await bytes.read(2)).readUInt16BE();
    const name = (await bytes.read(len)).toString('utf8');
    let finished = false;
    const data = (async function* () {
      for (;;) {
        const n = (await bytes.read(4)).readUInt32BE();
        if (n === 0) break;
        if (n > 1 << 20) throw new BackupFormatError('bad frame');
        yield await bytes.read(n);
      }
      finished = true;
    })();
    yield { name, data };
    if (!finished) for await (const _ of data) void _; // skip what the consumer didn't read
  }
}
