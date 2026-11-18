import { and, eq } from 'drizzle-orm';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { redactCensored } from '@bokydo/shared';
import { cleanFilename, type AttachmentStore } from '../attachments/store.js';
import type { Database } from '../db/client.js';
import { noteFiles, notes } from '../db/schema.js';
import { safeEntryName, ZipWriter } from '../zip/zip-writer.js';
import { documentFileIds, parseNoteBody } from './ast.js';
import { buildDocx } from './docx.js';
import { loadNoteImages, type NoteFileRow } from './images.js';
import {
  DEFAULT_EXPORT_LIMITS,
  ExportDeadline,
  TooLargeError,
  exportSemaphore,
  checkDocumentLimits,
  measureDocument,
  type ExportLimits,
  type ExportSemaphore,
} from './limits.js';
import { renderNoteMarkdown } from './markdown.js';
import { buildPdf } from './pdf.js';

/**
 * The per-note export pipeline, behind `GET /api/v1/notes/:id/export` (ADR 0025). It reads the
 * note and its files in one repeatable-read snapshot, applies the censor redaction to the title
 * and every filename before anything derives a heading, a metadata field or a path from them,
 * and renders Markdown (zipped when the note has files), DOCX or PDF.
 *
 * Everything a hostile note can inflate is capped here or in `limits.ts`, and the format
 * renderers never see a file that was not probed first.
 */

export type NoteExportFormat = 'md' | 'docx' | 'pdf';

export interface NoteExportDeps {
  db: Database;
  /** `<dataDir>/note-files`: note files live apart from comment attachments. */
  store: AttachmentStore;
  /** Overrides for the hard limits; tests use small ones instead of giant documents. */
  limits?: Partial<ExportLimits>;
  /** The concurrency gate; the process-wide one unless a test injects its own. */
  semaphore?: ExportSemaphore;
}

export interface NoteExportRequest {
  noteId: string;
  userId: string;
  format: NoteExportFormat;
}

export type NoteExportOutput = {
  contentType: string;
  extension: string;
  /** The title after redaction: what the heading, metadata and filename are derived from. */
  title: string;
  body: string | Readable;
  /** Release the export slot; idempotent, call it when the response is finished. */
  done(): void;
};

export const CONTENT_TYPES = {
  md: 'text/markdown; charset=utf-8',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
} as const;

/** The note does not exist, or is not the caller's: never disclose which. */
export class ExportNotFoundError extends Error {
  constructor() {
    super('note not found');
    this.name = 'ExportNotFoundError';
  }
}

/** Another export of this user (or three in the process) is already running. */
export class ExportBusyError extends Error {
  constructor() {
    super('export already running');
    this.name = 'ExportBusyError';
  }
}

/**
 * Run one export. Throws `ExportNotFoundError`, `ExportBusyError`, `TooLargeError` or
 * `ExportTimeoutError`; anything else is a real failure. The returned output holds the slot
 * until `done()` is called, including while a stream is still being read.
 */
export async function runNoteExport(
  deps: NoteExportDeps,
  request: NoteExportRequest,
): Promise<NoteExportOutput> {
  const limits: ExportLimits = { ...DEFAULT_EXPORT_LIMITS, ...deps.limits };
  const semaphore = deps.semaphore ?? exportSemaphore;
  const release = semaphore.tryAcquire(request.userId);
  if (!release) throw new ExportBusyError();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    release();
  };
  try {
    const loaded = await readNote(deps.db, request.noteId, request.userId);
    if (!loaded) throw new ExportNotFoundError();
    return await render(deps, limits, request, loaded, finish);
  } catch (err) {
    finish();
    throw err;
  }
}

/**
 * The note and its ready files, read in one `repeatable read` transaction: a file uploaded or
 * purged halfway through an export would otherwise appear in the Markdown but not in the zip.
 */
async function readNote(
  db: Database,
  noteId: string,
  userId: string,
): Promise<{ note: { id: string; title: string; body: string }; files: NoteFileRow[] } | null> {
  return db.transaction(
    async (tx) => {
      const [note] = await tx
        .select({ id: notes.id, title: notes.title, body: notes.body })
        .from(notes)
        .where(and(eq(notes.id, noteId), eq(notes.ownerUserId, userId)));
      if (!note) return null;
      const files = await tx
        .select({
          id: noteFiles.id,
          filename: noteFiles.filename,
          size: noteFiles.size,
          contentType: noteFiles.contentType,
        })
        .from(noteFiles)
        .where(
          and(
            eq(noteFiles.noteId, note.id),
            eq(noteFiles.ownerUserId, userId),
            eq(noteFiles.status, 'ready'),
          ),
        );
      return { note, files };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function render(
  deps: NoteExportDeps,
  limits: ExportLimits,
  request: NoteExportRequest,
  loaded: { note: { id: string; title: string; body: string }; files: NoteFileRow[] },
  done: () => void,
): Promise<NoteExportOutput> {
  // The stored title and filenames are attacker-controlled text: a censor token in either must
  // be redacted before it can become a heading, a metadata field, a zip path or a header value.
  const title = redactCensored(loaded.note.title);
  const files: NoteFileRow[] = loaded.files.map((file) => ({
    ...file,
    filename: redactCensored(file.filename),
  }));
  const fileNames = new Map(files.map((file) => [file.id, file.filename]));
  const deadline = new ExportDeadline(limits.deadlineMs);
  const check = () => deadline.check();

  const doc = parseNoteBody(loaded.note.body, { maxTokens: limits.maxTokens });
  checkDocumentLimits(measureDocument(doc.blocks), limits);
  check();

  if (request.format === 'md') {
    const referenced = documentFileIds(doc.blocks);
    // The body may reference a file that was already purged; only real rows are exported.
    const candidates = files.filter((file) => referenced.has(file.id));
    if (candidates.length === 0) {
      return {
        contentType: CONTENT_TYPES.md,
        extension: 'md',
        title,
        body: renderNoteMarkdown(title, doc, { fileNames, check }),
        done,
      };
    }
    // Probe every file before the Markdown is written, so a file that is gone is named in the
    // text and left out of the archive — the two must agree.
    const available: NoteFileRow[] = [];
    const unavailable = new Set<string>();
    for (const file of candidates) {
      if (await hasBytes(deps.store, file.id)) available.push(file);
      else unavailable.add(file.id);
    }
    if (available.length === 0) {
      return {
        contentType: CONTENT_TYPES.md,
        extension: 'md',
        title,
        body: renderNoteMarkdown(title, doc, { fileNames, fileUnavailable: unavailable, check }),
        done,
      };
    }
    return markdownZip(deps, title, doc, available, fileNames, unavailable, deadline, done);
  }

  const wanted = documentFileIds(doc.blocks);
  const { images, tooLarge } = await loadNoteImages(deps.store, files, wanted, {
    format: request.format,
  });
  if (tooLarge) throw new TooLargeError('the note images exceed the export budget');
  const context = { images, fileNames };
  if (request.format === 'docx') {
    return {
      contentType: CONTENT_TYPES.docx,
      extension: 'docx',
      title,
      body: buildDocx(title, doc.blocks, context, { deadline }),
      done,
    };
  }
  return {
    contentType: CONTENT_TYPES.pdf,
    extension: 'pdf',
    title,
    body: buildPdf(title, doc.blocks, context, {
      deadline,
      maxLinkAnnotations: limits.maxLinkAnnotations,
    }),
    done,
  };
}

/** `«title».md` plus `files/<id>-<name>`, with the body's links rewritten to the relative path. */
function markdownZip(
  deps: NoteExportDeps,
  title: string,
  doc: ReturnType<typeof parseNoteBody>,
  files: readonly NoteFileRow[],
  fileNames: ReadonlyMap<string, string>,
  unavailable: ReadonlySet<string>,
  deadline: ExportDeadline,
  done: () => void,
): NoteExportOutput {
  const entryNames = new Map<string, string>();
  for (const file of files) entryNames.set(file.id, fileEntry(file));
  // A URL for the link: each path segment escaped, so `#`, `?` and spaces in a filename work.
  const url = (entry: string) => entry.split('/').map(encodeURIComponent).join('/');
  const fileUrls = new Map([...entryNames].map(([id, entry]) => [id, url(entry)] as const));
  const markdown = renderNoteMarkdown(title, doc, {
    fileUrls,
    fileNames,
    fileUnavailable: unavailable,
    check: () => deadline.check(),
  });
  const mdName = `${safeEntryName(cleanedBase(title))}.md`;

  const zip = new ZipWriter();
  void (async () => {
    await zip.add(mdName, markdown);
    for (const file of files) {
      deadline.check();
      const entry = entryNames.get(file.id);
      if (!entry) continue;
      // `addFile` opens the file before the entry header, so a vanished file leaves no
      // half-written entry. It was probed a moment ago, so a miss here breaks the download
      // rather than quietly leaving the zip inconsistent with the Markdown.
      const added = await zip.addFile(entry, path.join(deps.store.dir, file.id));
      if (!added) throw new Error(`note file vanished during export: ${file.id}`);
    }
    deadline.check();
    await zip.finish();
  })().catch((err: unknown) => zip.abort(err instanceof Error ? err : new Error('export failed')));

  return {
    contentType: CONTENT_TYPES.zip,
    extension: 'zip',
    title,
    body: zip.stream,
    done,
  };
}

/**
 * A note file entry: the id keeps two files with one name apart, and the name is sanitised for
 * the archive (drive prefixes, reserved names, trailing dots, per-component length).
 */
function fileEntry(file: NoteFileRow): string {
  return safeEntryName(`files/${file.id}-${cleanFilename(file.filename)}`);
}

/**
 * A filename that is safe in a header: ASCII fallback plus RFC 5987 `filename*`. The title is
 * redacted again here, so no caller can put a censor token in a `Content-Disposition`.
 */
export function exportFilename(title: string, extension: string): string {
  const base = cleanedBase(redactCensored(title));
  const encoded = encodeURIComponent(`${base}.${extension}`).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="note.${extension}"; filename*=UTF-8''${encoded}`;
}

/** The cleaned title, or `note` when there is nothing usable (`../`, dot-only, blank). */
export function cleanedBase(title: string): string {
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return 'note';
  const cleaned = cleanFilename(trimmed);
  return cleaned === 'file' ? 'note' : cleaned;
}

/**
 * Whether a note file still has bytes. Only `ENOENT` from the open means "gone"; the handle is
 * closed at once. A directory opens fine and fails on the first read (EISDIR), which is why this
 * is an `open` probe: the archive then breaks mid-entry instead of carrying a wrong manifest.
 */
async function hasBytes(store: AttachmentStore, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return false;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path.join(store.dir, id), 'r');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
