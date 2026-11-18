import { crc32 as nodeCrc32 } from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * Image headers, read before any decoder sees the bytes (ADR 0025). Only the dimensions of a
 * PNG or JPEG are trusted, and a file over the size or pixel budget is never embedded — it is
 * rendered as its name instead, so a crafted header cannot make the exporter allocate more than
 * the budget.
 *
 * A header is not enough for `pdfkit`: its `PNGImage` hands the IDAT stream to png-js, which
 * *decodes* alpha, `tRNS` and interlaced PNGs inside an asynchronous zlib callback. A throw in
 * that callback is not a stream error — it escapes to the process. So a PNG is embedded only
 * after a full structural walk with a CRC-32 check on every chunk, and only the class `pdfkit`
 * passes through verbatim (see `pngFitsPdfkit`). Everything else is exported as its name.
 */

export type ImageType = 'png' | 'jpeg';

export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
}

/** Which renderer will see the bytes: PDF decodes; DOCX copies the original bytes. */
export type EmbedFormat = 'pdf' | 'docx';

/** Per image, before it is embedded in a DOCX or PDF. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Total embedded image bytes in one export. */
export const MAX_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024;
/** A decompression-bomb guard, checked from the header. */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Enough for a PNG IHDR or a JPEG SOF even behind a large EXIF block. */
export const HEAD_BYTES = 64 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A chunk is a length, a type, its data and a CRC; a file with fewer bytes is malformed. */
const PNG_CHUNK_OVERHEAD = 12;

function startsWith(head: Buffer, bytes: readonly number[], at = 0): boolean {
  for (let i = 0; i < bytes.length; i++) if (head[at + i] !== bytes[i]) return false;
  return true;
}

/** Start-of-frame markers that carry the dimensions (C4 = DHT, C8 = JPG, CC = DAC). */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** A JPEG segment length is two bytes and includes itself, so the smallest is 2. */
const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_EOI_BYTES = 0xffd9;

/** CRC-32 as PNG defines it; `zlib.crc32` exists from Node 22.2, with a table fallback. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function tableCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** `node:zlib`'s CRC-32 when this Node has it (≥ 22.2), the table implementation otherwise. */
export function crc32(bytes: Buffer): number {
  return typeof nodeCrc32 === 'function' ? nodeCrc32(bytes) >>> 0 : tableCrc32(bytes);
}

/** A PNG that passed the structural walk. */
export interface PngStructure {
  width: number;
  height: number;
  /**
   * The class `pdfkit`'s PNGImage passes through untouched — no inflate, no pixel decode:
   * 8-bit greyscale or truecolour (colour types 0 and 2), not interlaced, no `tRNS`, no `PLTE`.
   * Any other PNG makes png-js inflate the data inside a zlib callback, and `PLTE` would make
   * `embed()` declare an `Indexed` colour space over pass-through truecolour data.
   */
  pdfSafe: boolean;
}

/**
 * Walk every PNG chunk: signature, chunk lengths inside the file, a CRC-32 per chunk, IHDR
 * first, at least one IDAT, IEND last with nothing after it. Returns `null` for anything a PNG
 * decoder could disagree with, because the two decoders here (png-js and Word) must never see
 * a file they parse differently.
 */
export function readPngStructure(bytes: Buffer): PngStructure | null {
  if (bytes.length < PNG_SIGNATURE.length + PNG_CHUNK_OVERHEAD) return null;
  if (!startsWith(bytes, PNG_SIGNATURE)) return null;
  let offset = PNG_SIGNATURE.length;
  let structure: PngStructure | null = null;
  /** The PDF rule: 8-bit greyscale/truecolour, not interlaced, no `tRNS` and no palette. */
  let pdfSafe = true;
  let sawIdat = false;
  let sawIend = false;
  while (offset + PNG_CHUNK_OVERHEAD <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    // Every chunk length must fit in the bytes that are left (data and its CRC).
    if (length > bytes.length - dataStart - 4) return null;
    const stored = bytes.readUInt32BE(dataEnd);
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== stored) return null;
    if (structure === null) {
      if (type !== 'IHDR' || length !== 13) return null;
      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8] ?? 0;
      const colorType = bytes[dataStart + 9] ?? 0;
      const compression = bytes[dataStart + 10] ?? 0xff;
      const filter = bytes[dataStart + 11] ?? 0xff;
      const interlace = bytes[dataStart + 12] ?? 0xff;
      // A PNG with dimensions outside the budget is not worth walking further.
      if (!checked({ type: 'png', width, height })) return null;
      pdfSafe =
        bitDepth === 8 &&
        (colorType === 0 || colorType === 2) &&
        compression === 0 &&
        filter === 0 &&
        interlace === 0;
      structure = { width, height, pdfSafe };
    } else if (type === 'IHDR') {
      return null;
    } else if (type === 'tRNS' || type === 'PLTE') {
      pdfSafe = false;
    } else if (type === 'IDAT') {
      sawIdat = true;
    } else if (type === 'IEND') {
      sawIend = true;
      offset = dataEnd + 4;
      break;
    }
    offset = dataEnd + 4;
  }
  if (structure === null || !sawIdat || !sawIend) return null;
  // IEND must be the last chunk: trailing bytes are a second file glued on.
  if (offset !== bytes.length) return null;
  return { ...structure, pdfSafe };
}

/**
 * Walk the JPEG segments up to the first scan: SOI, every segment length inside the file, a
 * SOF before the scan (that is where the dimensions come from) and EOI as the last two bytes.
 * `pdfkit` only reads the markers and passes the bytes through as DCTDecode, so this is about
 * refusing files whose header lies, not about decoding entropy-coded data.
 */
export function readJpegStructure(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== JPEG_SOI) return null;
  let offset = 2;
  let info: ImageInfo | null = null;
  let sawScan = false;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    offset += 2;
    // 0xFF is a fill byte before a marker; keep it and re-read the next two bytes.
    if (marker === 0xff) {
      offset -= 1;
      continue;
    }
    // Stand-alone markers: TEM and the restart markers outside a scan carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // A second SOI, a stuffed zero or an EOI before any scan is malformed.
    if (marker === JPEG_SOI || marker === 0x00 || marker === JPEG_EOI) return null;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (isSof(marker)) {
      if (length < 8) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      info = checked({ type: 'jpeg', width, height });
      if (!info) return null;
    }
    if (marker === JPEG_SOS) {
      sawScan = true;
      offset += length;
      break;
    }
    offset += length;
  }
  if (!sawScan || info === null) return null;
  // EOI last, and the scan must not run past the end of the file.
  if (offset > bytes.length) return null;
  return bytes.readUInt16BE(bytes.length - 2) === JPEG_EOI_BYTES ? info : null;
}

/**
 * Whether these bytes may be embedded in this format, and their dimensions. PNG is walked in
 * full and, for PDF, restricted to the class `pdfkit` passes through; JPEG is walked as far as
 * its scan and must end in EOI.
 */
export function validateImage(bytes: Buffer, format: EmbedFormat): ImageInfo | null {
  if (bytes.length >= PNG_SIGNATURE.length && startsWith(bytes, PNG_SIGNATURE)) {
    const png = readPngStructure(bytes);
    if (!png) return null;
    if (format === 'pdf' && !png.pdfSafe) return null;
    return checked({ type: 'png', width: png.width, height: png.height });
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === JPEG_SOI) {
    return readJpegStructure(bytes);
  }
  return null;
}

/**
 * The type and dimensions from a PNG IHDR or a JPEG SOF header, or `null` when the prefix is
 * not one of those, is truncated, or claims absurd dimensions. This is the cheap first look
 * before the whole file is read; `validateImage` is what decides whether it may be embedded.
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
