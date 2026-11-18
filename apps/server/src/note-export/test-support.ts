import { inflateRawSync, deflateSync, crc32 } from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * Test helpers for the exporters: collect a stream, read a ZIP (the DOCX and the Markdown zip)
 * without adding a dependency, and build PNGs byte by byte so every structural rule can be
 * exercised (a class pdfkit would decode, a bad CRC, an interlaced file, …).
 */

export function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Entry name → contents, for a small (non-ZIP64) archive. */
export function readZipEntries(zip: Buffer): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(start, start + compressedSize);
    entries.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('not a zip file (no end of central directory)');
}

export function zipText(zip: Buffer, name: string): string {
  const entry = readZipEntries(zip).get(name);
  if (!entry) throw new Error(`no ${name} in zip: ${[...readZipEntries(zip).keys()].join(', ')}`);
  return entry.toString('utf8');
}

/** A real 1×1 PNG with an alpha channel (colour type 6): safe for DOCX, decoded by pdfkit. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** One PNG chunk: length, type, data, CRC-32 over type and data. */
export function pngChunk(type: string, data: Buffer, corruptCrc = false): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(body) + (corruptCrc ? 1 : 0)) >>> 0);
  return Buffer.concat([length, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngOptions {
  width?: number;
  height?: number;
  /** PNG colour type: 0 grey, 2 RGB, 3 indexed, 4 grey+alpha, 6 RGBA. */
  colorType?: number;
  bitDepth?: number;
  /** 1 for Adam7. */
  interlace?: number;
  /** Add a `tRNS` chunk (after IHDR, before IDAT). */
  transparency?: boolean;
  /** Add a `PLTE` chunk. */
  palette?: boolean;
  /** Use `data` as the IDAT payload instead of the correct deflate stream. */
  idat?: Buffer;
  /** Store a wrong CRC on the IDAT chunk. */
  corruptIdatCrc?: boolean;
  /** Append this many bytes after IEND. */
  trailingBytes?: number;
  /** Leave the IDAT chunk out. */
  omitIdat?: boolean;
  /** Extra chunks (tEXt, iCCP, …) inserted after the colour chunks and before IDAT. */
  extra?: { type: string; data: Buffer }[];
  /** Payload of the IEND chunk; a valid PNG has none. */
  iendData?: Buffer;
}

/** Build a syntactically valid PNG for the given colour type/bit depth, with real CRCs. */
export function makePng(opts: PngOptions = {}): Buffer {
  const width = opts.width ?? 1;
  const height = opts.height ?? 1;
  const bitDepth = opts.bitDepth ?? 8;
  const colorType = opts.colorType ?? 2;
  const interlace = opts.interlace ?? 0;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = interlace;
  const parts: Buffer[] = [PNG_SIGNATURE, pngChunk('IHDR', header)];
  if (opts.palette) parts.push(pngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])));
  if (opts.transparency) parts.push(pngChunk('tRNS', Buffer.from([0, 0, 0, 0, 0, 0])));
  for (const chunk of opts.extra ?? []) parts.push(pngChunk(chunk.type, chunk.data));
  if (!opts.omitIdat) {
    // One scanline: the filter byte, then the pixel bytes for a single row.
    const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
    const pixels =
      opts.idat ?? deflateSync(Buffer.concat([Buffer.from([0]), Buffer.alloc(rowBytes)]));
    parts.push(pngChunk('IDAT', pixels, opts.corruptIdatCrc === true));
  }
  parts.push(pngChunk('IEND', opts.iendData ?? Buffer.alloc(0)));
  if (opts.trailingBytes) parts.push(Buffer.alloc(opts.trailingBytes, 0x41));
  return Buffer.concat(parts);
}

/** A real 1×1 8-bit RGB PNG: the class pdfkit passes through instead of inflating. */
export const PNG_RGB = makePng({ colorType: 2, bitDepth: 8 });

/** SOI, a JFIF APP0, an SOF, a minimal scan and EOI, with the given dimensions. */
export function makeJpeg(
  opts: {
    width?: number;
    height?: number;
    sofMarker?: number;
    omitEoi?: boolean;
    segmentLength?: number;
    /** Bytes after the EOI, like the video an Android Motion Photo appends. */
    append?: Buffer;
  } = {},
): Buffer {
  const width = opts.width ?? 2;
  const height = opts.height ?? 2;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  const app = Buffer.alloc(18);
  app.writeUInt16BE(0xffe0, 0);
  app.writeUInt16BE(16, 2);
  app.write('JFIF\0', 4, 'latin1');
  parts.push(app);
  // SOF0 is a 2-byte marker, its length, then 8 bytes plus 3 per component.
  const frame = Buffer.alloc(19);
  frame.writeUInt16BE(0xff00 | (opts.sofMarker ?? 0xc0), 0);
  frame.writeUInt16BE(opts.segmentLength ?? 17, 2);
  frame[4] = 8; // precision
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3; // components
  parts.push(frame);
  // The start of scan, its header, a few entropy-coded bytes and the end of image.
  const scan = Buffer.alloc(8);
  scan.writeUInt16BE(0xffda, 0);
  scan.writeUInt16BE(8, 2);
  scan[4] = 1;
  parts.push(scan, Buffer.from([0x00, 0x11, 0x22, 0x33]));
  if (!opts.omitEoi) parts.push(Buffer.from([0xff, 0xd9]));
  if (opts.append) parts.push(opts.append);
  return Buffer.concat(parts);
}
