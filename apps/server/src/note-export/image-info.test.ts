import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  crc32,
  jpegEnd,
  readAll,
  readImageInfo,
  readJpegStructure,
  readPngStructure,
  readPrefix,
  rebuildPngForPdf,
  validateImage,
} from './image-info.js';
import { makeJpeg, makePng } from './test-support.js';

/** A PNG signature and IHDR chunk with the given size (the CRC is not checked here). */
function png(width: number, height: number, chunk = 'IHDR'): Buffer {
  const header = Buffer.alloc(8 + 25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write(chunk, 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8; // bit depth
  return header;
}

describe('image header reader', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(readImageInfo(png(640, 480))).toEqual({ type: 'png', width: 640, height: 480 });
  });

  it('rejects a PNG whose first chunk is not IHDR', () => {
    expect(readImageInfo(png(640, 480, 'IDAT'))).toBeNull();
  });

  it('rejects a truncated PNG', () => {
    expect(readImageInfo(png(640, 480).subarray(0, 20))).toBeNull();
  });

  it('rejects ridiculous and empty dimensions', () => {
    expect(readImageInfo(png(100_000, 100_000))).toBeNull();
    expect(readImageInfo(png(0, 10))).toBeNull();
    expect(readImageInfo(makeJpeg({ width: 0, height: 10 }))).toBeNull();
    expect(readImageInfo(png(MAX_IMAGE_PIXELS, 1))).toEqual({
      type: 'png',
      width: MAX_IMAGE_PIXELS,
      height: 1,
    });
    expect(readImageInfo(png(MAX_IMAGE_PIXELS, 2))).toBeNull();
  });

  it('finds the JPEG frame marker behind an APP0 block', () => {
    expect(readImageInfo(makeJpeg({ width: 1024, height: 768 }))).toEqual({
      type: 'jpeg',
      width: 1024,
      height: 768,
    });
    // SOF2 is a progressive JPEG; it carries the same dimensions.
    expect(readImageInfo(makeJpeg({ width: 200, height: 100, sofMarker: 0xc2 }))).toEqual({
      type: 'jpeg',
      width: 200,
      height: 100,
    });
  });

  it('rejects a JPEG truncated before its frame header', () => {
    expect(readImageInfo(makeJpeg({ width: 1024, height: 768 }).subarray(0, 12))).toBeNull();
    const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
    expect(readImageInfo(noFrame)).toBeNull();
  });

  it('rejects anything that is not PNG or JPEG', () => {
    expect(readImageInfo(Buffer.from('GIF89a....'))).toBeNull();
    expect(readImageInfo(Buffer.from('%PDF-1.7\n'))).toBeNull();
    expect(readImageInfo(Buffer.alloc(0))).toBeNull();
  });

  it('reads a prefix and a whole stream with a hard size cap', async () => {
    const body = Buffer.from('0123456789');
    expect(
      (await readPrefix(Readable.from([body.subarray(0, 4), body.subarray(4)]), 6)).toString(),
    ).toBe('012345');
    expect((await readAll(Readable.from([body]), 10))?.toString()).toBe('0123456789');
    expect(await readAll(Readable.from([body]), 9)).toBeNull();
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('PNG structure', () => {
  it('accepts 8-bit grey and RGB PNGs, and reports them as pdfkit-safe', () => {
    for (const colorType of [0, 2]) {
      const file = makePng({ colorType, width: 3, height: 2 });
      expect(readPngStructure(file)).toEqual({ width: 3, height: 2, pdfSafe: true });
      expect(validateImage(file, 'pdf')).toEqual({ type: 'png', width: 3, height: 2 });
      expect(validateImage(file, 'docx')).toEqual({ type: 'png', width: 3, height: 2 });
    }
  });

  it('accepts a PNG with alpha for DOCX but never for PDF', () => {
    const file = makePng({ colorType: 6 });
    expect(readPngStructure(file)).toEqual({ width: 1, height: 1, pdfSafe: false });
    expect(validateImage(file, 'docx')).toEqual({ type: 'png', width: 1, height: 1 });
    // pdfkit decodes this class through png-js, inside a zlib callback.
    expect(validateImage(file, 'pdf')).toBeNull();
  });

  it('refuses 16-bit, interlaced, tRNS and palette PNGs', () => {
    for (const file of [
      makePng({ colorType: 2, bitDepth: 16 }),
      makePng({ colorType: 2, interlace: 1 }),
      makePng({ colorType: 2, transparency: true }),
      makePng({ colorType: 2, palette: true }),
      makePng({ colorType: 4 }),
      makePng({ colorType: 3, palette: true }),
    ]) {
      const structure = readPngStructure(file);
      expect(structure).not.toBeNull();
      expect(structure?.pdfSafe).toBe(false);
      expect(validateImage(file, 'pdf')).toBeNull();
    }
  });

  it('rejects a bad CRC, which is how a corrupt IDAT is caught before any decoder', () => {
    const corrupt = makePng({ colorType: 2, corruptIdatCrc: true });
    expect(readPngStructure(corrupt)).toBeNull();
    expect(validateImage(corrupt, 'docx')).toBeNull();
    expect(validateImage(corrupt, 'pdf')).toBeNull();
  });

  it('rejects a chunk length that points past the end of the file', () => {
    const file = Buffer.from(makePng({ colorType: 2 }));
    // IHDR's length is at offset 8; claim 4 GiB.
    file.writeUInt32BE(0xffffffff, 8);
    expect(readPngStructure(file)).toBeNull();
  });

  it('rejects a missing IDAT, a trailing chunk and a non-IHDR first chunk', () => {
    expect(readPngStructure(makePng({ omitIdat: true }))).toBeNull();
    expect(readPngStructure(makePng({ trailingBytes: 4 }))).toBeNull();
    const idatFirst = Buffer.concat([
      Buffer.from(makePng()).subarray(0, 8),
      Buffer.from(makePng()).subarray(8 + 25),
    ]);
    expect(readPngStructure(idatFirst)).toBeNull();
  });

  it('rejects dimensions outside the budget and an empty file', () => {
    expect(readPngStructure(makePng({ width: MAX_IMAGE_PIXELS, height: 2 }))).toBeNull();
    expect(readPngStructure(Buffer.alloc(0))).toBeNull();
  });

  it('rejects a non-empty IEND and an IDAT larger than the scanlines it claims', () => {
    expect(readPngStructure(makePng({ iendData: Buffer.from('x') }))).toBeNull();
    // A 1x1 RGB image has 4 raw bytes; a 20 KB IDAT is a decompression bomb, not zlib overhead.
    expect(readPngStructure(makePng({ colorType: 2, idat: Buffer.alloc(20_000, 7) }))).toBeNull();
    // A valid zlib stream may be a few bytes larger than the raw data (the 1x1 case).
    expect(readPngStructure(makePng({ colorType: 2 }))).not.toBeNull();
  });

  it('rejects bit depth / colour type combinations the PNG spec does not define', () => {
    expect(readPngStructure(makePng({ colorType: 2, bitDepth: 4 }))).toBeNull();
    expect(readPngStructure(makePng({ colorType: 6, bitDepth: 4 }))).toBeNull();
    expect(readPngStructure(makePng({ colorType: 3, bitDepth: 16 }))).toBeNull();
    expect(readPngStructure(makePng({ colorType: 0, bitDepth: 4 }))).not.toBeNull();
  });

  it('rejects a PNG with more than 10,000 chunks without walking them all', () => {
    const extra = Array.from({ length: 10_001 }, () => ({ type: 'tEXt', data: Buffer.alloc(0) }));
    const bomb = makePng({ colorType: 2, extra });
    const started = performance.now();
    expect(readPngStructure(bomb)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    // 9,997 ancillary chunks plus IHDR/IDAT/IEND is exactly at the 10,000 cap, and still valid.
    const atCap = makePng({
      colorType: 2,
      extra: Array.from({ length: 9_997 }, () => ({ type: 'tEXt', data: Buffer.alloc(0) })),
    });
    expect(readPngStructure(atCap)).not.toBeNull();
  });

  it('accepts ancillary chunks but rebuilds a PDF PNG from IHDR/IDAT/IEND only', () => {
    const text = Buffer.from(`Comment\0${'x'.repeat(256 * 1024)}`, 'latin1');
    const file = makePng({ colorType: 2, extra: [{ type: 'tEXt', data: text }] });
    expect(readPngStructure(file)).toEqual({ width: 1, height: 1, pdfSafe: true });
    expect(validateImage(file, 'pdf')).toEqual({ type: 'png', width: 1, height: 1 });
    const rebuilt = rebuildPngForPdf(file);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.length).toBeLessThan(file.length);
    expect(rebuilt?.toString('latin1')).not.toContain('tEXt');
    expect(rebuilt?.toString('latin1')).not.toContain('xxxx');
    // The rebuilt file is itself a valid, pdfkit-safe PNG.
    expect(validateImage(rebuilt ?? Buffer.alloc(0), 'pdf')).toEqual({
      type: 'png',
      width: 1,
      height: 1,
    });
    // An alpha PNG is never rebuilt for PDF.
    expect(rebuildPngForPdf(makePng({ colorType: 6 }))).toBeNull();
  });

  it('computes the CRC the way PNG does', () => {
    // CRC-32 of "IEND" is the well-known 0xae426082.
    expect(crc32(Buffer.from('IEND', 'latin1'))).toBe(0xae426082);
  });
});

describe('JPEG structure', () => {
  it('accepts a JPEG whose markers are inside the file and which ends in EOI', () => {
    expect(readJpegStructure(makeJpeg({ width: 4, height: 3 }))).toMatchObject({
      type: 'jpeg',
      width: 4,
      height: 3,
    });
    expect(validateImage(makeJpeg({ width: 4, height: 3 }), 'pdf')).toEqual({
      type: 'jpeg',
      width: 4,
      height: 3,
    });
  });

  it('finds the first EOI through entropy-coded data and ignores an appended video', () => {
    const plain = makeJpeg({ width: 4, height: 3 });
    // Android Motion Photos append an MP4 after the JPEG. The JPEG part is still the image.
    const motion = makeJpeg({
      width: 4,
      height: 3,
      append: Buffer.from('ftypmp42video', 'latin1'),
    });
    expect(readJpegStructure(motion)).toMatchObject({ type: 'jpeg', width: 4, height: 3 });
    expect(jpegEnd(motion)).toBe(plain.length);
    expect(validateImage(motion, 'docx')).toEqual({ type: 'jpeg', width: 4, height: 3 });
  });

  it('walks stuffed FF00 bytes and restart markers without ending the scan early', () => {
    // SOI, APP0, SOF, SOS, then entropy data with a stuffed 0xFF, an RST0, and EOI.
    const scan = Buffer.from([
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xff, 0x00, 0x12, 0xff, 0xd0,
      0x34, 0xff, 0xd9,
    ]);
    const base = makeJpeg({ omitEoi: true });
    const file = Buffer.concat([base, scan]);
    const end = jpegEnd(file);
    expect(end).not.toBeNull();
    expect(file.readUInt16BE((end ?? 0) - 2)).toBe(0xffd9);
    expect(validateImage(file, 'pdf')).toMatchObject({ type: 'jpeg', width: 2, height: 2 });
  });

  it('rejects a segment length that runs past the end of the file', () => {
    expect(readJpegStructure(makeJpeg({ segmentLength: 0xffff }))).toBeNull();
    expect(readJpegStructure(makeJpeg({ segmentLength: 1 }))).toBeNull();
  });

  it('rejects a missing EOI and a file without a frame', () => {
    expect(readJpegStructure(makeJpeg({ omitEoi: true }))).toBeNull();
    expect(readJpegStructure(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });

  it('rejects dimensions outside the budget', () => {
    expect(readJpegStructure(makeJpeg({ width: 60_000, height: 60_000 }))).toBeNull();
  });
});
