import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../attachments/store.js';
import { ExportDeadline, DEFAULT_EXPORT_LIMITS } from './limits.js';
import { loadNoteImages, type NoteFileRow } from './images.js';
import { ExportWorker } from './runner.js';
import { makePng } from './test-support.js';
import type { Readable } from 'node:stream';

/**
 * The memory containment test: the heaviest export the limits allow (25 MB of valid images and a
 * large table) really runs, in a real worker, and the process' resident set is sampled every
 * 50 ms. The point is not a tight benchmark but a ceiling: one export may not add 500 MiB to the
 * server, because several of them would otherwise take a small container down.
 */

const IMAGE_COUNT = 3;
const IMAGE_WIDTH = 1600;
const IMAGE_HEIGHT = 1700;
const COLUMNS = 80;
/**
 * The docx library's per-cell object graph is the binding limit of the 192 MB worker heap: about
 * 9,600 cells plus 25 MB of images fits, 16,000 already runs out of heap (and becomes 413). PDF
 * streams its cells and fits 16,000 in the same heap.
 */
const DOCX_ROWS = 120;
const PDF_ROWS = 200;

/** A structurally valid, pdfkit pass-through RGB PNG of about 8 MB. */
function largePng(): Buffer {
  const rowBytes = IMAGE_WIDTH * 3;
  const raw = randomBytes(IMAGE_HEIGHT * (rowBytes + 1));
  // Level 0 keeps the IDAT close to the scanline size the structural walk allows, and makes the
  // file incompressible like a photograph rather than a few thousand identical pixels.
  return makePng({
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    colorType: 2,
    bitDepth: 8,
    idat: deflateSync(raw, { level: 0 }),
  });
}

function tableBody(rows: number): string {
  const header = Array.from({ length: COLUMNS }, (_, index) => `h${index}`);
  const separator = Array.from({ length: COLUMNS }, () => '---');
  const body = Array.from({ length: rows }, (_, row) =>
    Array.from(
      { length: COLUMNS },
      (_, column) => `c${row.toString(36)}x${column.toString(36)}value`,
    ).join(' | '),
  );
  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((row) => `| ${row} |`),
  ].join('\n');
}

describe('note export memory containment', () => {
  let store: AttachmentStore;
  let files: NoteFileRow[];
  let imageBlocks: string;

  beforeAll(async () => {
    store = new AttachmentStore(await mkdtemp(path.join(tmpdir(), 'bokydo-note-memory-')));
    await mkdir(store.dir, { recursive: true });
    const png = largePng();
    expect(png.length).toBeLessThan(10 * 1024 * 1024);
    files = [];
    for (let index = 0; index < IMAGE_COUNT; index++) {
      const id = randomUUID();
      await writeFile(path.join(store.dir, id), png);
      files.push({ id, filename: `shot-${index}.png`, size: png.length, contentType: 'image/png' });
    }
    imageBlocks = files
      .map((file) => `![shot ${file.id}](/api/v1/note-files/${file.id}?inline=1)`)
      .join('\n\n');
  }, 120_000);

  afterAll(async () => {
    await rm(path.dirname(store.dir), { recursive: true, force: true });
  });

  async function exportAndMeasure(format: 'docx' | 'pdf'): Promise<number> {
    const body = `${tableBody(format === 'docx' ? DOCX_ROWS : PDF_ROWS)}\n\n${imageBlocks}\n`;
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 50);
    const worker = new ExportWorker({
      limits: DEFAULT_EXPORT_LIMITS,
      deadline: new ExportDeadline(30_000),
    });
    try {
      const analysis = await worker.analyze(body);
      const { images, tooLarge } = await loadNoteImages(store, files, new Set(analysis.fileIds));
      expect(tooLarge).toBe(false);
      expect(images.size).toBe(IMAGE_COUNT);
      const stream = await worker.render({
        format,
        title: 'Heavy note',
        fileNames: files.map((file) => [file.id, file.filename]),
        images: [...images.values()].map((image) => ({
          id: image.id,
          filename: image.filename,
          bytes: image.bytes.buffer.slice(
            image.bytes.byteOffset,
            image.bytes.byteOffset + image.bytes.byteLength,
          ) as ArrayBuffer,
        })),
      });
      await drain(stream);
    } finally {
      await worker.dispose();
      clearInterval(sampler);
    }
    return peak - baseline;
  }

  it('keeps the heaviest DOCX export under a 500 MiB RSS delta', async () => {
    const delta = await exportAndMeasure('docx');
    console.info(
      `[note-export] peak RSS delta, heaviest DOCX: ${(delta / 1024 / 1024).toFixed(1)} MiB`,
    );
    expect(delta).toBeLessThan(500 * 1024 * 1024);
  }, 120_000);

  it('keeps the heaviest PDF export under a 500 MiB RSS delta', async () => {
    const delta = await exportAndMeasure('pdf');
    console.info(
      `[note-export] peak RSS delta, heaviest PDF: ${(delta / 1024 / 1024).toFixed(1)} MiB`,
    );
    expect(delta).toBeLessThan(500 * 1024 * 1024);
  }, 120_000);
});

/** Read a render stream without keeping it: the export is consumed, not buffered by the test. */
async function drain(stream: Readable): Promise<void> {
  for await (const chunk of stream) void chunk;
}
