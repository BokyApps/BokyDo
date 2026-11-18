import type { AttachmentStore } from '../attachments/store.js';
import {
  HEAD_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  readAll,
  readImageInfo,
  readPrefix,
  type ImageInfo,
} from './image-info.js';

/** The note-file columns the exporters need; `note_files` rows, already owner-scoped. */
export interface NoteFileRow {
  id: string;
  filename: string;
  size: number;
  contentType: string;
}

export interface LoadedImage extends ImageInfo {
  id: string;
  filename: string;
  bytes: Buffer;
}

/**
 * Read the note files the document actually shows as pictures. Only PNG and JPEG under 10 MB
 * and 40 megapixels are loaded (the header is read first); everything else is left for the
 * renderer to show as its name. `tooLarge` means the referenced images alone pass the 100 MB
 * export budget, so no format ever has to hold more than that.
 */
export async function loadNoteImages(
  store: AttachmentStore,
  files: readonly NoteFileRow[],
  wanted: ReadonlySet<string>,
): Promise<{ images: Map<string, LoadedImage>; tooLarge: boolean }> {
  const candidates = files.filter(
    (file) =>
      wanted.has(file.id) &&
      file.size > 0 &&
      (file.contentType === 'image/png' || file.contentType === 'image/jpeg'),
  );
  let declared = 0;
  for (const file of candidates) if (file.size <= MAX_IMAGE_BYTES) declared += file.size;
  if (declared > MAX_IMAGE_TOTAL_BYTES) return { images: new Map(), tooLarge: true };

  const images = new Map<string, LoadedImage>();
  for (const file of candidates) {
    if (file.size > MAX_IMAGE_BYTES) continue;
    const head = await readPrefix(store.read(file.id), HEAD_BYTES);
    const info = readImageInfo(head);
    if (!info) continue;
    const bytes = await readAll(store.read(file.id), MAX_IMAGE_BYTES);
    if (!bytes) continue;
    images.set(file.id, { ...info, id: file.id, filename: file.filename, bytes });
  }
  return { images, tooLarge: false };
}
