import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  crc32,
  readAll,
  readImageInfo,
  readJpegStructure,
  readPngStructure,
  readPrefix,
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

  it('computes the CRC the way PNG does', () => {
    // CRC-32 of "IEND" is the well-known 0xae426082.
    expect(crc32(Buffer.from('IEND', 'latin1'))).toBe(0xae426082);
  });
});

describe('JPEG structure', () => {
  it('accepts a JPEG whose markers are inside the file and which ends in EOI', () => {
    expect(readJpegStructure(makeJpeg({ width: 4, height: 3 }))).toEqual({
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
