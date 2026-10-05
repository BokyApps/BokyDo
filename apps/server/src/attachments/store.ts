import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Attachment files on the data volume. Files are named by attachment ID (a UUID), so a user's
 * filename never touches the filesystem, and written to a temp name first so a partial upload
 * is never served.
 */
export class AttachmentStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'attachments');
  }

  private file(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad attachment id');
    return path.join(this.dir, id);
  }

  /**
   * Stream an upload to disk, stopping (and deleting it) past `maxBytes`. Returns the size,
   * SHA-256 and the first bytes (for type detection), or null if it was too large.
   */
  async write(
    id: string,
    body: Readable,
    maxBytes: number,
  ): Promise<{ size: number; sha256: string; head: Buffer } | null> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file(id)}.part`;
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    let tooBig = false;
    const counter = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > maxBytes) {
          tooBig = true;
          throw new Error('too large');
        }
        if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
        hash.update(chunk);
        yield chunk;
      }
    };
    try {
      await pipeline(body, counter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      if (tooBig) return null;
      throw err;
    }
    await rename(tmp, this.file(id));
    return { size, sha256: hash.digest('hex'), head };
  }

  read(id: string): Readable {
    return createReadStream(this.file(id));
  }

  async remove(id: string): Promise<void> {
    await unlink(this.file(id)).catch(() => undefined);
  }

  /** Delete a file found by `list` (a finished upload or a leftover `.part`). */
  async removeName(name: string): Promise<void> {
    if (!/^[0-9a-f-]{36}(\.part)?$/.test(name)) return;
    await unlink(path.join(this.dir, name)).catch(() => undefined);
  }

  /** Files on disk older than `minAgeMs` (skips in-progress uploads). */
  async list(minAgeMs: number): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      const st = await stat(path.join(this.dir, name)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > minAgeMs) out.push(name);
    }
    return out;
  }
}

/** File types we recognise by their first bytes; everything else is opaque binary. */
export function sniff(head: Buffer): { type: string; inline: boolean } {
  const starts = (bytes: number[], at = 0) => bytes.every((b, i) => head[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { type: 'image/png', inline: true };
  if (starts([0xff, 0xd8, 0xff])) return { type: 'image/jpeg', inline: true };
  if (starts([0x47, 0x49, 0x46, 0x38])) return { type: 'image/gif', inline: true };
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8))
    return { type: 'image/webp', inline: true };
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return { type: 'application/pdf', inline: false };
  return { type: 'application/octet-stream', inline: false };
}

export const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A display name safe for headers and UI: no paths, no control characters, bounded. */
export function cleanFilename(raw: string | undefined): string {
  let decoded: string;
  try {
    decoded = raw ? decodeURIComponent(raw) : '';
  } catch {
    decoded = '';
  }
  const name = decoded
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (name || 'file').slice(0, 200);
}
