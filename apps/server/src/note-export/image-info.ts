import type { Readable } from 'node:stream';

/**
 * Image headers, read before any decoder sees the bytes (ADR 0025). Only the dimensions of a
 * PNG or JPEG are trusted, and a file over the size or pixel budget is never embedded — it is
 * rendered as its name instead, so a crafted header cannot make the exporter allocate more than
 * the budget.
 */

export type ImageType = 'png' | 'jpeg';

export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
}

/** Per image, before it is embedded in a DOCX or PDF. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Total embedded image bytes in one export. */
export const MAX_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024;
/** A decompression-bomb guard, checked from the header. */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Enough for a PNG IHDR or a JPEG SOF even behind a large EXIF block. */
export const HEAD_BYTES = 64 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(head: Buffer, bytes: readonly number[], at = 0): boolean {
  for (let i = 0; i < bytes.length; i++) if (head[at + i] !== bytes[i]) return false;
  return true;
}

/** Start-of-frame markers that carry the dimensions (C4 = DHT, C8 = JPG, CC = DAC). */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * The type and dimensions from a PNG IHDR or a JPEG SOF header, or `null` when the prefix is
 * not one of those, is truncated, or claims absurd dimensions.
 */
export function readImageInfo(head: Buffer): ImageInfo | null {
  if (head.length >= 24 && startsWith(head, PNG_SIGNATURE)) {
    if (head.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    return checked({ type: 'png', width, height });
  }
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2;
    while (offset + 2 <= head.length) {
      if (head[offset] !== 0xff) return null;
      const marker = head[offset + 1] ?? 0;
      offset += 2;
      // 0xFF is a fill byte before a marker; stand-alone markers carry no length field.
      if (marker === 0xff) {
        offset -= 1;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      // EOI, start of scan (the dimensions come before it), or invalid.
      if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null;
      if (offset + 2 > head.length) return null;
      const length = head.readUInt16BE(offset);
      if (length < 2) return null;
      if (isSof(marker)) {
        if (offset + 7 > head.length) return null;
        const height = head.readUInt16BE(offset + 3);
        const width = head.readUInt16BE(offset + 5);
        return checked({ type: 'jpeg', width, height });
      }
      offset += length;
    }
  }
  return null;
}

function checked(info: ImageInfo): ImageInfo | null {
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height)) return null;
  if (info.width <= 0 || info.height <= 0) return null;
  if (info.width * info.height > MAX_IMAGE_PIXELS) return null;
  return info;
}

/** The first `max` bytes of a stream; the stream is destroyed afterwards. */
export async function readPrefix(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      const take = Math.max(0, max - size);
      if (take > 0) chunks.push(buffer.subarray(0, take));
      size += buffer.length;
      if (size >= max) break;
    }
  } catch {
    return Buffer.alloc(0);
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

/** A whole stream as bytes, or `null` if it is larger than `max` (the stream is destroyed). */
export async function readAll(stream: Readable, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.length;
      if (size > max) {
        stream.destroy();
        return null;
      }
      chunks.push(buffer);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}
