import type { AttachmentStore } from '../attachments/store.js';
import {
  HEAD_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  readAll,
  readImageInfo,
  readPrefix,
  validateImage,
  type EmbedFormat,
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
 * and 40 megapixels are loaded; the header is read first (cheap rejection), then the whole file
 * is validated — PNG chunk by chunk with a CRC per chunk, JPEG marker by marker — before any
 * decoder sees it. `format` says which renderer will get the bytes: PDF additionally refuses
 * the PNG classes `pdfkit` decodes. Everything else is left for the renderer to show as its
 * name. `tooLarge` means the referenced images alone pass the 100 MB export budget, so no format
 * ever has to hold more than that.
 */
export async function loadNoteImages(
  store: AttachmentStore,
  files: readonly NoteFileRow[],
  wanted: ReadonlySet<string>,
  opts: { format?: EmbedFormat } = {},
): Promise<{ images: Map<string, LoadedImage>; tooLarge: boolean }> {
  const format = opts.format ?? 'docx';
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
  /** The bytes actually read, so a row whose declared size lies cannot pass the budget. */
  let read = 0;
  for (const file of candidates) {
    if (file.size > MAX_IMAGE_BYTES) continue;
    const head = await readPrefix(store.read(file.id), HEAD_BYTES);
    if (!readImageInfo(head)) continue;
    const bytes = await readAll(store.read(file.id), MAX_IMAGE_BYTES);
    if (!bytes) continue;
    read += bytes.length;
    if (read > MAX_IMAGE_TOTAL_BYTES) return { images: new Map(), tooLarge: true };
    const info = validateImage(bytes, format);
    if (!info) continue;
    images.set(file.id, { ...info, id: file.id, filename: file.filename, bytes });
  }
  return { images, tooLarge: false };
}
