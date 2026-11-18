import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../attachments/store.js';
import { loadNoteImages } from './images.js';
import { PNG_1X1 } from './test-support.js';

const PNG_ID = '44444444-4444-4444-8444-444444444444';
const GIF_ID = '55555555-5555-4555-8555-555555555555';
const BIG_ID = '66666666-6666-4666-8666-666666666666';
const HUGE_ID = '77777777-7777-4777-8777-777777777777';

let store: AttachmentStore;

beforeEach(async () => {
  store = new AttachmentStore(await mkdtemp(path.join(tmpdir(), 'bokydo-note-export-')));
  await mkdir(store.dir, { recursive: true });
});

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

  it('refuses an export whose images pass the 100 MB budget, before reading them', async () => {
    // No bytes on disk: the budget is decided from the declared sizes, so nothing is read.
    // Eleven files at the 10 MB per-image cap are 110 MB of images.
    const ids = Array.from({ length: 11 }, () => randomUUID());
    const { images, tooLarge } = await loadNoteImages(
      store,
      ids.map((id) => row(id, 10 * 1024 * 1024)),
      new Set(ids),
    );
    expect(tooLarge).toBe(true);
    expect(images.size).toBe(0);
  });
});
