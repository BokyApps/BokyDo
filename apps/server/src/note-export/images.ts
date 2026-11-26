import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentStore } from '../attachments/store.js';
import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES, type ImageInfo } from './image-info.js';

/** The note-file columns the exporters need; `note_files` rows, already owner-scoped. */
export interface NoteFileRow {
  id: string;
  filename: string;
  size: number;
  contentType: string;
}

/** Image bytes read on the main thread, before the worker validates them. */
export interface NoteImageBytes {
  id: string;
  filename: string;
  bytes: Buffer;
}

/** An image as the renderers see it: validated, with its dimensions, in the worker. */
export interface LoadedImage extends ImageInfo {
  id: string;
  filename: string;
  bytes: Buffer;
}

export interface LoadImagesOptions {
  /** Aborted on client disconnect, the export deadline, or a dead worker. */
  signal?: AbortSignal;
  /** Test hook: called once before each file read, so a test can abort mid-load. */
  onRead?: () => void;
}

/** The error to throw when a read was aborted; the caller's reason when it has one. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('image read aborted');
}

function missingFile(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR';
}

/**
 * Read the note files the document shows as pictures, on the main thread. It does as little as
 * possible: one open handle, its `stat` for the real size against the per-image and per-export
 * budgets, then one read of that handle with an `AbortSignal`. The structural walk (PNG chunk/CRC, JPEG markers) happens in
 * the export worker, where it is bounded by the isolate's heap and memory deadline; the main
 * thread never parses attacker-controlled image bytes.
 *
 * `tooLarge` means the referenced images alone pass the export budget. A file that vanished, or
 * grew past the per-image cap between its row and this read, is skipped and the renderer shows
 * its name. An abort is thrown, never swallowed: the route has no bytes to send.
 */
export async function loadNoteImages(
  store: AttachmentStore,
  files: readonly NoteFileRow[],
  wanted: ReadonlySet<string>,
  opts: LoadImagesOptions = {},
): Promise<{ images: Map<string, NoteImageBytes>; tooLarge: boolean }> {
  const signal = opts.signal;
  const checkAborted = () => {
    if (signal?.aborted) throw abortError(signal);
  };
  const candidates = files.filter(
    (file) =>
      wanted.has(file.id) &&
      file.size > 0 &&
      (file.contentType === 'image/png' || file.contentType === 'image/jpeg'),
  );
  let declared = 0;
  for (const file of candidates) if (file.size <= MAX_IMAGE_BYTES) declared += file.size;
  if (declared > MAX_IMAGE_TOTAL_BYTES) return { images: new Map(), tooLarge: true };

  const images = new Map<string, NoteImageBytes>();
  /** The bytes actually read, so a row whose declared size lies cannot pass the budget. */
  let read = 0;
  for (const file of candidates) {
    checkAborted();
    if (!/^[0-9a-f-]{36}$/.test(file.id)) continue;
    const filePath = path.join(store.dir, file.id);
    // One open handle for the size check and the read, so the file that was measured is the
    // file that is read (no stat-then-open race). O_NONBLOCK keeps a FIFO from hanging the open.
    let handle: FileHandle;
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (err) {
      if (missingFile(err)) continue;
      checkAborted();
      throw err;
    }
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) continue;
      const size = info.size;
      if (size <= 0 || size > MAX_IMAGE_BYTES) continue;
      if (read + size > MAX_IMAGE_TOTAL_BYTES) return { images: new Map(), tooLarge: true };
      opts.onRead?.();
      try {
        bytes = await handle.readFile(signal ? { signal } : {});
      } catch (err) {
        checkAborted();
        if (missingFile(err)) continue;
        throw err;
      }
    } finally {
      await handle.close();
    }
    checkAborted();
    // A file that grew between the stat and the read is not worth embedding.
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) continue;
    read += bytes.length;
    if (read > MAX_IMAGE_TOTAL_BYTES) return { images: new Map(), tooLarge: true };
    images.set(file.id, { id: file.id, filename: file.filename, bytes });
  }
  return { images, tooLarge: false };
}
