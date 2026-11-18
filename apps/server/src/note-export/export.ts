import { and, eq } from 'drizzle-orm';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { redactCensored } from '@bokydo/shared';
import { sanitizeStoredName, type AttachmentStore } from '../attachments/store.js';
import type { Database } from '../db/client.js';
import { noteFiles, notes } from '../db/schema.js';
import { safeEntryName, ZipWriter } from '../zip/zip-writer.js';
import { loadNoteImages, type LoadedImage, type NoteFileRow } from './images.js';
import {
  DEFAULT_EXPORT_LIMITS,
  ExportDeadline,
  TooLargeError,
  checkBodyShape,
  checkDocumentLimits,
  exportSemaphore,
  type ExportLimits,
  type ExportSemaphore,
} from './limits.js';
import { ExportWorker, type NoteExportInternal } from './runner.js';
import type { WorkerImage } from './worker.js';

/**
 * The per-note export pipeline, behind `GET /api/v1/notes/:id/export` (ADR 0025). It reads the
 * note and its files in one repeatable-read snapshot, applies the censor redaction to the title
 * and every filename before anything derives a heading, a metadata field or a path from them,
 * and then hands the body to a resource-limited worker (see `worker.ts` / `runner.ts`): the
 * Markdown parse, the AST, the DOCX packer and pdfkit never run on the request thread.
 *
 * The main thread only does what needs privileges or shared state: the database snapshot, the
 * file probes, the image validation, streaming the zip from disk, and enforcing the output cap
 * on the worker's chunks.
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
  /** Test-only worker hooks (a failing renderer, an exit counter); never set by the route. */
  internal?: NoteExportInternal;
}

export interface NoteExportRequest {
  noteId: string;
  userId: string;
  format: NoteExportFormat;
  /** The client went away while the export was still being prepared or rendered. */
  signal?: AbortSignal;
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
 * until `done()` is called or the worker exits, including while a stream is still being read.
 */
export async function runNoteExport(
  deps: NoteExportDeps,
  request: NoteExportRequest,
): Promise<NoteExportOutput> {
  const limits: ExportLimits = { ...DEFAULT_EXPORT_LIMITS, ...deps.limits };
  const semaphore = deps.semaphore ?? exportSemaphore;
  const release = semaphore.tryAcquire(request.userId);
  if (!release) throw new ExportBusyError();
  // The 30 s clock starts here, not when the worker starts: queueing/auth/DB time is part of it.
  const deadline = new ExportDeadline(limits.deadlineMs);
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  let worker: ExportWorker | null = null;
  try {
    const loaded = await readNote(deps.db, request.noteId, request.userId);
    if (!loaded) throw new ExportNotFoundError();
    const title = redactExportText(loaded.note.title);
    const files: NoteFileRow[] = loaded.files.map((file) => ({
      ...file,
      // Redact before the length bound, so a token cannot be cut in half and leak its prefix,
      // then sanitise (no percent-decoding), then redact once more as defence in depth.
      filename: redactExportText(sanitizeStoredName(redactExportText(file.filename))),
    }));
    // Refuse a sparse-table bomb or a 100,000-line body before a worker is even spawned. The
    // worker repeats the check before `md.parse`; this is the cheap, fast-413 path.
    checkBodyShape(loaded.note.body);
    deadline.check();

    worker = new ExportWorker({
      limits,
      deadline,
      release: finish,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(deps.internal ? { internal: deps.internal } : {}),
    });
    const analysis = await worker.analyze(loaded.note.body);
    checkDocumentLimits(analysis.size, limits);
    deadline.check();

    if (request.format === 'md') {
      return await markdownExport(deps, title, files, analysis.fileIds, deadline, worker, finish);
    }

    const { images, tooLarge } = await loadNoteImages(
      deps.store,
      files,
      new Set(analysis.fileIds),
      {
        format: request.format,
      },
    );
    if (tooLarge) throw new TooLargeError('the note images exceed the export budget');
    deadline.check();
    const fileNames = new Map(files.map((file) => [file.id, file.filename]));
    const body = await worker.render({
      format: request.format,
      title,
      fileNames: [...fileNames],
      images: [...images.values()].map(workerImage),
    });
    return {
      contentType: request.format === 'docx' ? CONTENT_TYPES.docx : CONTENT_TYPES.pdf,
      extension: request.format,
      title,
      body,
      done: outputDone(worker, finish),
    };
  } catch (err) {
    // The slot is released by the worker's exit handler; dispose waits for that exit on every
    // failure path (including a worker that never started).
    if (worker) await worker.dispose().catch(() => undefined);
    finish();
    throw err;
  }
}

/** `done()` for a live worker: terminate it (if still rendering) and release after its exit. */
function outputDone(worker: ExportWorker, finish: () => void): () => void {
  return () => {
    void worker
      .dispose()
      .catch(() => undefined)
      .finally(finish);
  };
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

/**
 * Markdown: the worker renders the text and names the files it actually references; the main
 * thread probes those files, and either returns one `.md` file (nothing to zip) or streams a zip
 * whose entries are read from disk one at a time.
 */
async function markdownExport(
  deps: NoteExportDeps,
  title: string,
  files: readonly NoteFileRow[],
  referencedIds: readonly string[],
  deadline: ExportDeadline,
  worker: ExportWorker,
  finish: () => void,
): Promise<NoteExportOutput> {
  const referenced = new Set(referencedIds);
  // The body may reference a file that was already purged; only real rows are exported.
  const candidates = files.filter((file) => referenced.has(file.id));
  // Probe every file before the Markdown is written, so a file that is gone is named in the
  // text and left out of the archive — the two must agree.
  const available: NoteFileRow[] = [];
  const unavailable = new Set<string>();
  for (const file of candidates) {
    deadline.check();
    if (await hasBytes(deps.store, file.id)) available.push(file);
    else unavailable.add(file.id);
  }
  const entryNames = new Map<string, string>();
  for (const file of available) entryNames.set(file.id, fileEntry(file));
  // A URL for the link: each path segment escaped, so `#`, `?` and spaces in a filename work.
  const url = (entry: string) => entry.split('/').map(encodeURIComponent).join('/');
  const fileUrls = new Map([...entryNames].map(([id, entry]) => [id, url(entry)] as const));

  const result = await worker.renderMarkdown({
    title,
    fileNames: [...files].map((file) => [file.id, file.filename]),
    fileUrls: [...fileUrls],
    fileUnavailable: [...unavailable],
  });
  // The worker names what it actually wrote, so a body that mentions a file URL as plain text
  // can never put an unreferenced file into the zip.
  const included = new Set(result.fileIds);
  const exported = available.filter((file) => included.has(file.id));
  // Markdown is done with the worker; terminate it before the (I/O-bound) zip is streamed.
  await worker.dispose();
  if (exported.length === 0) {
    return {
      contentType: CONTENT_TYPES.md,
      extension: 'md',
      title,
      body: result.markdown,
      done: finish,
    };
  }

  const mdName = safeEntryName(`${cleanedBase(title)}.md`);
  const zip = new ZipWriter();
  void (async () => {
    await zip.add(redactCensored(mdName), result.markdown);
    for (const file of exported) {
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
    done: finish,
  };
}

/** A note file id and its bytes, in the form the worker takes: a transferable ArrayBuffer. */
function workerImage(image: LoadedImage): WorkerImage {
  const bytes = new ArrayBuffer(image.bytes.length);
  new Uint8Array(bytes).set(image.bytes);
  return {
    id: image.id,
    filename: image.filename,
    type: image.type,
    width: image.width,
    height: image.height,
    bytes,
  };
}

/**
 * A note file entry: the id keeps two files with one name apart, and the name is sanitised for
 * the archive (drive prefixes, reserved names, trailing dots, per-component length). The final
 * path component is redacted again, after `safeEntryName` may have rewritten it.
 */
function fileEntry(file: NoteFileRow): string {
  return redactCensored(safeEntryName(`files/${file.id}-${sanitizeStoredName(file.filename)}`));
}

/**
 * A filename that is safe in a header: ASCII fallback plus RFC 5987 `filename*`. The title is
 * redacted again here, and the base is never percent-decoded: a stored `%7B` is a literal
 * character, not a token waiting to be decoded after redaction.
 */
export function exportFilename(title: string, extension: string): string {
  const base = redactCensored(cleanedBase(redactExportText(title)));
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
  const cleaned = sanitizeStoredName(trimmed);
  return cleaned === 'file' ? 'note' : cleaned;
}

/**
 * Redact censor markers, including one hidden behind percent-encoding. Stored names are never
 * decoded as names — `%20` stays `%20` — but if decoding would reveal a token, the decoded,
 * redacted text is what may be emitted, because emitting the literal `%7B%7Bcensored…` would put
 * the ciphertext in a header, a zip path or the Markdown body just the same.
 */
export function redactExportText(text: string): string {
  const redacted = redactCensored(text);
  if (redacted !== text || !text.includes('%')) return redacted;
  let decoded: string;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    return redacted;
  }
  const decodedRedacted = redactCensored(decoded);
  return decodedRedacted === decoded ? redacted : decodedRedacted;
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
