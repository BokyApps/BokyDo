import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../attachments/store.js';
import { loadNoteImages } from './images.js';
import { PNG_1X1, makeJpeg } from './test-support.js';

const PNG_ID = '44444444-4444-4444-8444-444444444444';
const JPEG_ID = '55555555-5555-4555-8555-555555555555';
const GIF_ID = '66666666-6666-4666-8666-666666666666';
const BIG_ID = '77777777-7777-4777-8777-777777777777';

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

describe('note export image loading', () => {
  it('reads the bytes of a PNG note file; validation is the worker’s job', async () => {
    await writeFile(path.join(store.dir, PNG_ID), PNG_1X1);
    const { images, tooLarge } = await loadNoteImages(
      store,
      [row(PNG_ID, PNG_1X1.length)],
      new Set([PNG_ID]),
    );
    expect(tooLarge).toBe(false);
    expect(images.get(PNG_ID)?.bytes.equals(PNG_1X1)).toBe(true);
  });

  it('reads a JPEG too: the loader no longer walks its markers', async () => {
    const jpeg = makeJpeg({ width: 2, height: 2 });
    await writeFile(path.join(store.dir, JPEG_ID), jpeg);
    const { images } = await loadNoteImages(
      store,
      [{ ...row(JPEG_ID, jpeg.length), contentType: 'image/jpeg' }],
      new Set([JPEG_ID]),
    );
    expect(images.get(JPEG_ID)?.bytes.equals(jpeg)).toBe(true);
  });

  it('only loads the files the document actually shows', async () => {
    await writeFile(path.join(store.dir, PNG_ID), PNG_1X1);
    const { images } = await loadNoteImages(store, [row(PNG_ID, PNG_1X1.length)], new Set());
    expect(images.size).toBe(0);
  });

  it('skips files that are not PNG or JPEG, or that declare more than 10 MB', async () => {
    await writeFile(path.join(store.dir, GIF_ID), Buffer.from('GIF89a....'));
    const { images, tooLarge } = await loadNoteImages(
      store,
      [row(GIF_ID, 10, 'image/gif'), row(BIG_ID, 11 * 1024 * 1024)],
      new Set([GIF_ID, BIG_ID]),
    );
    expect(tooLarge).toBe(false);
    expect(images.size).toBe(0);
  });

  it('skips a file whose real size is over the per-image cap, whatever its row says', async () => {
    await writeFile(path.join(store.dir, BIG_ID), Buffer.alloc(11 * 1024 * 1024));
    const { images } = await loadNoteImages(store, [row(BIG_ID, 10)], new Set([BIG_ID]));
    expect(images.size).toBe(0);
  });

  it('skips a file whose bytes are gone, and a directory where a file should be', async () => {
    await mkdir(path.join(store.dir, BIG_ID), { recursive: true });
    const { images } = await loadNoteImages(
      store,
      [row(PNG_ID, 100), row(BIG_ID, 100)],
      new Set([PNG_ID, BIG_ID]),
    );
    expect(images.size).toBe(0);
  });

  it('refuses an export whose declared images pass the 25 MB budget, before reading them', async () => {
    // No bytes on disk: the budget is decided from the declared sizes, so nothing is read.
    // Three files at the 10 MB per-image cap are 30 MB of images.
    const ids = Array.from({ length: 3 }, () => randomUUID());
    const { images, tooLarge } = await loadNoteImages(
      store,
      ids.map((id) => row(id, 10 * 1024 * 1024)),
      new Set(ids),
    );
    expect(tooLarge).toBe(true);
    expect(images.size).toBe(0);
  });

  it('refuses an export whose real bytes pass the budget even when the rows understate it', async () => {
    const ids = Array.from({ length: 3 }, () => randomUUID());
    for (const id of ids) await writeFile(path.join(store.dir, id), Buffer.alloc(9 * 1024 * 1024));
    const { images, tooLarge } = await loadNoteImages(
      store,
      ids.map((id) => row(id, 1)),
      new Set(ids),
    );
    expect(tooLarge).toBe(true);
    expect(images.size).toBe(0);
  });

  it('stops reading when the signal is aborted between files', async () => {
    const ids = Array.from({ length: 4 }, () => randomUUID());
    for (const id of ids) await writeFile(path.join(store.dir, id), PNG_1X1);
    const abort = new AbortController();
    let reads = 0;
    const result = loadNoteImages(
      store,
      ids.map((id) => row(id, PNG_1X1.length)),
      new Set(ids),
      {
        signal: abort.signal,
        onRead: () => {
          reads++;
          abort.abort(new Error('client went away'));
        },
      },
    );
    await expect(result).rejects.toThrow('client went away');
    expect(reads).toBe(1);
  });
});
