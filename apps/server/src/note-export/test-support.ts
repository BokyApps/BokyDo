import { inflateRawSync, inflateSync, deflateSync, crc32 } from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * Test helpers for the exporters: collect a stream, read a ZIP (the DOCX and the Markdown zip)
 * without adding a dependency, and build PNGs byte by byte so every structural rule can be
 * exercised (a class pdfkit would decode, a bad CRC, an interlaced file, …).
 */

/** The cp1252 half of WinAnsiEncoding, which is what the built-in PDF fonts write. */
const CP1252: Record<number, string> = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ',
};

function winAnsi(byte: number): string {
  if (byte >= 0x80 && byte <= 0x9f) return CP1252[byte] ?? '?';
  return String.fromCharCode(byte);
}

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

/** Split a PDF into numbered objects without letting binary stream bytes look like objects. */
function parsePdfObjects(pdf: Buffer): Map<number, PdfObject> {
  const raw = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  let next = 0;
  for (;;) {
    const header = nextObjectHeader(raw, next);
    if (!header) break;
    const { id, start } = header;
    const streamAt = raw.indexOf('stream', start);
    const endObjectAt = raw.indexOf('endobj', start);
    if (streamAt !== -1 && (endObjectAt === -1 || streamAt < endObjectAt)) {
      const dict = raw.slice(start, streamAt);
      let dataStart = streamAt + 'stream'.length;
      if (raw[dataStart] === '\r') dataStart++;
      if (raw[dataStart] === '\n') dataStart++;
      const declared = /\/Length\s+(\d+)/u.exec(dict);
      let dataEnd: number;
      let endStream: number;
      if (declared) {
        dataEnd = dataStart + Number(declared[1]);
        endStream = raw.indexOf('endstream', dataEnd);
        if (endStream === -1) endStream = dataEnd;
      } else {
        endStream = raw.indexOf('endstream', dataStart);
        dataEnd = endStream === -1 ? raw.length : endStream;
      }
      objects.set(id, { dict, stream: pdf.subarray(dataStart, dataEnd) });
      const after = raw.indexOf('endobj', endStream);
      next = after === -1 ? Math.max(dataEnd, start) : after + 'endobj'.length;
    } else {
      const end = endObjectAt === -1 ? raw.length : endObjectAt;
      objects.set(id, { dict: raw.slice(start, end), stream: null });
      next = end + 'endobj'.length;
    }
  }
  return objects;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** `123 0 obj` at the start of a line, returning the id and where its body begins. */
function nextObjectHeader(raw: string, from: number): { id: number; start: number } | null {
  let at = from;
  for (;;) {
    const marker = raw.indexOf(' 0 obj', at);
    if (marker === -1) return null;
    let idStart = marker;
    while (idStart > 0 && isDigit(raw.charCodeAt(idStart - 1))) idStart--;
    const before = idStart === 0 ? '\n' : raw[idStart - 1];
    if (idStart < marker && (before === '\n' || before === '\r'))
      return { id: Number(raw.slice(idStart, marker)), start: marker + ' 0 obj'.length };
    at = marker + 1;
  }
}

/** The number in `n 0 R` that starts at or after `from`. */
function firstObjectReference(text: string, from: number): number | null {
  const marker = text.indexOf(' 0 R', from);
  if (marker === -1) return null;
  let start = marker;
  while (start > from && isDigit(text.charCodeAt(start - 1))) start--;
  return start < marker ? Number(text.slice(start, marker)) : null;
}

/** Every `n 0 R` in a `[ … ]` contents array. */
function objectReferences(text: string): number[] {
  const refs: number[] = [];
  let at = 0;
  for (;;) {
    const marker = text.indexOf(' 0 R', at);
    if (marker === -1) return refs;
    let start = marker;
    while (start > 0 && isDigit(text.charCodeAt(start - 1))) start--;
    if (start < marker) refs.push(Number(text.slice(start, marker)));
    at = marker + ' 0 R'.length;
  }
}

function utf16be(hex: string): string {
  const clean = hex.replace(/\s+/gu, '');
  if (clean.length % 4 !== 0) return '';
  return Buffer.from(clean, 'hex').swap16().toString('utf16le');
}

/** pdfkit writes one `bfrange` array per 256 glyphs; support `bfchar` and simple ranges too. */
function parseToUnicode(stream: Buffer | null): Map<number, string> | null {
  if (!stream) return null;
  const text = stream.toString('latin1');
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/gu)) {
      map.set(Number.parseInt(pair[1] ?? '0', 16), utf16be(pair[2] ?? ''));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    const body = block[1] ?? '';
    for (const range of body.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/gu,
    )) {
      const start = Number.parseInt(range[1] ?? '0', 16);
      const end = Number.parseInt(range[2] ?? '0', 16);
      const target = range[3] ?? '';
      if (target.startsWith('[')) {
        let code = start;
        for (const item of target.matchAll(/<([0-9a-fA-F\s]+)>/gu))
          map.set(code++, utf16be(item[1] ?? ''));
      } else {
        const first = Number.parseInt(target.slice(1, -1), 16);
        for (let code = start; code <= end && code - start < 0x10000; code++)
          map.set(code, String.fromCodePoint(first + (code - start)));
      }
    }
  }
  return map;
}

function decodeStream(object: PdfObject): Buffer {
  if (!object.stream) return Buffer.alloc(0);
  if (
    /\/Filter\s*\/FlateDecode/u.test(object.dict) ||
    /\/Filter\s*\[\s*\/FlateDecode/u.test(object.dict)
  )
    return inflateSync(object.stream);
  return object.stream;
}

interface PdfFontDecoder {
  twoByte: boolean;
  toUnicode: Map<number, string> | null;
}

function fontDecoders(objects: Map<number, PdfObject>): Map<string, PdfFontDecoder> {
  const resources = new Map<string, number>();
  for (const object of objects.values()) {
    for (const group of object.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/gu)) {
      for (const reference of (group[1] ?? '').matchAll(/\/([A-Za-z0-9]+)\s+(\d+) 0 R/gu)) {
        resources.set(reference[1] ?? '', Number(reference[2]));
      }
    }
  }
  const decoders = new Map<string, PdfFontDecoder>();
  for (const [name, id] of resources) {
    const font = objects.get(id);
    if (!font) continue;
    const toUnicodeId = /\/ToUnicode\s+(\d+) 0 R/u.exec(font.dict);
    decoders.set(name, {
      twoByte: /\/Subtype\s*\/Type0\b/u.test(font.dict),
      toUnicode: toUnicodeId
        ? parseToUnicode(objects.get(Number(toUnicodeId[1]))?.stream ?? null)
        : null,
    });
  }
  return decoders;
}

function pageContents(objects: Map<number, PdfObject>): Buffer[] {
  const contents: Buffer[] = [];
  for (const object of objects.values()) {
    if (!/\/Type\s*\/Page\b/u.test(object.dict)) continue;
    const at = object.dict.indexOf('/Contents');
    if (at === -1) continue;
    let cursor = at + '/Contents'.length;
    const isSpace = (code: number): boolean =>
      code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
    while (cursor < object.dict.length && isSpace(object.dict.charCodeAt(cursor))) cursor++;
    if (object.dict[cursor] === '[') {
      const close = object.dict.indexOf(']', cursor);
      if (close === -1) continue;
      for (const id of objectReferences(object.dict.slice(cursor + 1, close))) {
        const content = objects.get(id);
        if (content) contents.push(decodeStream(content));
      }
      continue;
    }
    const id = firstObjectReference(object.dict, cursor);
    if (id === null) continue;
    const content = objects.get(id);
    if (content) contents.push(decodeStream(content));
  }
  return contents;
}

function decodeHex(hex: string, decoder: PdfFontDecoder | undefined): string {
  let out = '';
  if (!decoder || !decoder.twoByte) {
    for (let index = 0; index + 1 < hex.length; index += 2)
      out += winAnsi(Number.parseInt(hex.slice(index, index + 2), 16));
    return out;
  }
  for (let index = 0; index + 3 < hex.length; index += 4) {
    const code = Number.parseInt(hex.slice(index, index + 4), 16);
    out += decoder.toUnicode?.get(code) ?? '';
  }
  return out;
}

/**
 * Text extraction for the PDF tests. Built-in fonts are decoded as WinAnsi; embedded fonts are
 * decoded through the document's own `/ToUnicode` CMaps, which also proves a subset maps its
 * shaped glyphs (a Khmer coeng subscript) back to the original code points.
 */
export function extractPdfText(pdf: Buffer): string {
  const objects = parsePdfObjects(pdf);
  const decoders = fontDecoders(objects);
  const blocks: string[] = [];
  for (const content of pageContents(objects)) {
    const text = content.toString('latin1');
    for (const pageBlock of text.split(/\bBT\b/u).slice(1)) {
      const end = pageBlock.indexOf('ET');
      const body = end === -1 ? pageBlock : pageBlock.slice(0, end);
      let decoder: PdfFontDecoder | undefined;
      let out = '';
      // Walk the two operators this renderer emits, in order: `/Fx size Tf` and `[ … ] TJ`.
      let fontAt = body.indexOf(' Tf');
      let showAt = body.indexOf('] TJ');
      while (fontAt !== -1 || showAt !== -1) {
        if (showAt !== -1 && (fontAt === -1 || showAt < fontAt)) {
          const open = body.lastIndexOf('[', showAt);
          if (open !== -1) {
            for (const hex of body.slice(open + 1, showAt).matchAll(/<([0-9a-fA-F]+)>/gu))
              out += decodeHex(hex[1] ?? '', decoder);
          }
          showAt = body.indexOf('] TJ', showAt + 4);
          continue;
        }
        const slash = body.lastIndexOf('/', fontAt);
        const space = slash === -1 ? -1 : body.indexOf(' ', slash);
        if (slash !== -1 && space !== -1) decoder = decoders.get(body.slice(slash + 1, space));
        fontAt = body.indexOf(' Tf', fontAt + 3);
      }
      if (out !== '') blocks.push(out);
    }
  }
  return blocks.join(' ');
}

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
