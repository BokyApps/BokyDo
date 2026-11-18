import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  readAll,
  readImageInfo,
  readPrefix,
} from './image-info.js';

/** A PNG signature and IHDR chunk with the given size (the CRC is not checked). */
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

/** FFD8, an APP0 block, then an SOF marker with the given size. */
function jpeg(width: number, height: number, sof = 0xc0, app0 = true): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (app0) {
    const app = Buffer.alloc(18);
    app.writeUInt16BE(0xffe0, 0);
    app.writeUInt16BE(16, 2);
    app.write('JFIF\0', 4, 'latin1');
    parts.push(app);
  }
  const frame = Buffer.alloc(11);
  frame.writeUInt16BE(0xff00 | sof, 0);
  frame.writeUInt16BE(17, 2);
  frame[4] = 8; // precision
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3; // components
  parts.push(frame);
  return Buffer.concat(parts);
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
    expect(readImageInfo(jpeg(0, 10))).toBeNull();
    expect(readImageInfo(png(MAX_IMAGE_PIXELS, 1))).toEqual({
      type: 'png',
      width: MAX_IMAGE_PIXELS,
      height: 1,
    });
    expect(readImageInfo(png(MAX_IMAGE_PIXELS, 2))).toBeNull();
  });

  it('finds the JPEG frame marker behind an APP0 block', () => {
    expect(readImageInfo(jpeg(1024, 768))).toEqual({ type: 'jpeg', width: 1024, height: 768 });
    // SOF2 is a progressive JPEG; it carries the same dimensions.
    expect(readImageInfo(jpeg(200, 100, 0xc2))).toEqual({ type: 'jpeg', width: 200, height: 100 });
  });

  it('rejects a JPEG truncated before its frame header', () => {
    expect(readImageInfo(jpeg(1024, 768).subarray(0, 12))).toBeNull();
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
