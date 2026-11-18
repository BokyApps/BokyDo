import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../attachments/store.js';
import { loadNoteImages } from './images.js';
import { PNG_1X1, makeJpeg, makePng } from './test-support.js';

const PNG_ID = '44444444-4444-4444-8444-444444444444';
const GIF_ID = '55555555-5555-4555-8555-555555555555';
const BIG_ID = '66666666-6666-4666-8666-666666666666';
const HUGE_ID = '77777777-7777-4777-8777-777777777777';

let store: AttachmentStore;

beforeEach(async () => {
  store = new AttachmentStore(await mkdtemp(path.join(tmpdir(), 'bokydo-note-export-')));
  await mkdir(store.dir, { recursive: true });
});
// The store's directory sits inside the temp dir; remove the whole temp dir.
afterEach(async () => rm(path.dirname(store.dir), { recursive: true, force: true }));

const row = (id: string, size: number, contentType = 'image/png') => ({
  id,
  filename: `${id}.png`,
  size,
  contentType,
});

describe('note export images', () => {
  it('loads a PNG note file and reports its header dimensions', async () => {
    await writeFile(path.join(store.dir, PNG_ID), PNG_1X1);
    const { images, tooLarge } = await loadNoteImages(
      store,
      [row(PNG_ID, PNG_1X1.length)],
      new Set([PNG_ID]),
    );
    expect(tooLarge).toBe(false);
    expect(images.get(PNG_ID)).toMatchObject({ type: 'png', width: 1, height: 1 });
    expect(images.get(PNG_ID)?.bytes.equals(PNG_1X1)).toBe(true);
  });

  it('only loads the files the document actually shows', async () => {
    await writeFile(path.join(store.dir, PNG_ID), PNG_1X1);
    const { images } = await loadNoteImages(store, [row(PNG_ID, PNG_1X1.length)], new Set());
    expect(images.size).toBe(0);
  });

  it('skips files that are not PNG or JPEG, or that are too large', async () => {
    await writeFile(path.join(store.dir, GIF_ID), Buffer.from('GIF89a....'));
    await writeFile(path.join(store.dir, BIG_ID), PNG_1X1);
    const { images, tooLarge } = await loadNoteImages(
      store,
      [row(GIF_ID, 10, 'image/gif'), row(BIG_ID, 11 * 1024 * 1024)],
      new Set([GIF_ID, BIG_ID]),
    );
    expect(tooLarge).toBe(false);
    expect(images.size).toBe(0);
  });

  it('skips a file whose header is truncated or absurd', async () => {
    await writeFile(path.join(store.dir, PNG_ID), PNG_1X1.subarray(0, 20));
    await writeFile(
      path.join(store.dir, HUGE_ID),
      Buffer.concat([
        PNG_1X1.subarray(0, 16),
        Buffer.from([0x7f, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xff, 0xff]),
      ]),
    );
    const { images } = await loadNoteImages(
      store,
      [row(PNG_ID, 20), row(HUGE_ID, 24)],
      new Set([PNG_ID, HUGE_ID]),
    );
    expect(images.size).toBe(0);
  });

  it('loads an alpha PNG for DOCX but never for PDF', async () => {
    await writeFile(path.join(store.dir, PNG_ID), PNG_1X1);
    const rows = [row(PNG_ID, PNG_1X1.length)];
    const docx = await loadNoteImages(store, rows, new Set([PNG_ID]), { format: 'docx' });
    expect(docx.images.get(PNG_ID)?.bytes.equals(PNG_1X1)).toBe(true);
    // pdfkit decodes colour types 4 and 6 inside a zlib callback, where a throw crashes.
    const pdf = await loadNoteImages(store, rows, new Set([PNG_ID]), { format: 'pdf' });
    expect(pdf.images.size).toBe(0);
  });

  it('cuts a motion-photo JPEG at its first EOI before handing it to a renderer', async () => {
    const plain = makeJpeg({ width: 2, height: 2 });
    const motion = makeJpeg({
      width: 2,
      height: 2,
      append: Buffer.from('ftypmp42-this-is-not-an-image', 'latin1'),
    });
    await writeFile(path.join(store.dir, PNG_ID), motion);
    const { images } = await loadNoteImages(
      store,
      [{ ...row(PNG_ID, motion.length), contentType: 'image/jpeg' }],
      new Set([PNG_ID]),
    );
    expect(images.get(PNG_ID)?.bytes.equals(plain)).toBe(true);
    expect(images.get(PNG_ID)?.bytes.toString('latin1')).not.toContain('ftypmp42');
  });

  it('refuses a PNG whose chunk CRC is wrong, before any decoder sees it', async () => {
    const corrupt = makePng({ colorType: 2, corruptIdatCrc: true });
    await writeFile(path.join(store.dir, PNG_ID), corrupt);
    for (const format of ['docx', 'pdf'] as const) {
      const { images } = await loadNoteImages(
        store,
        [row(PNG_ID, corrupt.length)],
        new Set([PNG_ID]),
        { format },
      );
      expect(images.size).toBe(0);
    }
    const valid = makePng({ colorType: 2 });
    await writeFile(path.join(store.dir, PNG_ID), valid);
    const { images } = await loadNoteImages(store, [row(PNG_ID, valid.length)], new Set([PNG_ID]), {
      format: 'pdf',
    });
    expect(images.get(PNG_ID)?.width).toBe(1);
  });

  it('refuses an export whose images pass the 50 MB budget, before reading them', async () => {
    // No bytes on disk: the budget is decided from the declared sizes, so nothing is read.
    // Six files at the 10 MB per-image cap are 60 MB of images.
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const { images, tooLarge } = await loadNoteImages(
      store,
      ids.map((id) => row(id, 10 * 1024 * 1024)),
      new Set(ids),
    );
    expect(tooLarge).toBe(true);
    expect(images.size).toBe(0);
  });
});
