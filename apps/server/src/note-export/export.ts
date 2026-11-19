import { and, eq } from 'drizzle-orm';
import { readFile, open } from 'node:fs/promises';
import { totalmem } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { CENSOR_PLACEHOLDER, redactCensored } from '@bokydo/shared';
import { sanitizeStoredName, type AttachmentStore } from '../attachments/store.js';
import type { Database } from '../db/client.js';
import { noteFiles, notes } from '../db/schema.js';
import { ZipWriter, avoidReservedWindowsName, safeEntryName } from '../zip/zip-writer.js';
import { loadNoteImages, type NoteFileRow, type NoteImageBytes } from './images.js';
import {
  DEFAULT_EXPORT_LIMITS,
  ExportDeadline,
  ExportTimeoutError,
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
  /** Reads the memory available to this process; injectable so the admission check is testable. */
  memoryLimitBytes?: () => number | Promise<number>;
  /** Current resident set size; injectable for the same reason. */
  rssBytes?: () => number;
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

/** Another export of this user (or the appropriate global pool) is already running. */
export class ExportBusyError extends Error {
  constructor() {
    super('export already running');
    this.name = 'ExportBusyError';
  }
}

/**
 * The process is too close to the memory it is allowed to use to admit another export: the
 * planned peak (400 MiB) would take the resident set past 85 % of the cgroup limit. Answering
 * `503 export_busy` is better than an OOM kill that would take every other request with it.
 */
export class ExportOverloadedError extends Error {
  constructor() {
    super('export not admitted: not enough memory headroom');
    this.name = 'ExportOverloadedError';
  }
}

/** The planned peak of one DOCX/PDF export: worker heap, image copies and stream buffers. */
export const EXPORT_PEAK_BYTES = 400 * 1024 * 1024;
/** Admit a new export only while 15 % of the memory limit stays free. */
export const EXPORT_MEMORY_FRACTION = 0.85;

/**
 * The memory the process may use: the cgroup v2 limit when there is a numeric one, otherwise
 * the machine's total RAM. `max` means unlimited (the root cgroup), and a kernel without the
 * file falls back the same way. It is read once per export, before that export's slot is
 * acquired; tests inject their own reader.
 */
export async function readMemoryLimitBytes(): Promise<number> {
  try {
    const raw = (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim();
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
  } catch {
    // No cgroup v2, no permission, or a value we do not understand: total RAM is the ceiling.
  }
  return totalmem();
}

/** Whether one more export fits under the memory limit. Exported for its own test. */
export function exportAdmitted(limitBytes: number, rssBytes: number): boolean {
  return rssBytes + EXPORT_PEAK_BYTES <= limitBytes * EXPORT_MEMORY_FRACTION;
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
  // Admission first: a 400 MiB peak is about to run, and reading the cgroup limit is cheap
  // compared with what an OOM kill would cost every other request in the process.
  const memoryLimit = await (deps.memoryLimitBytes ?? readMemoryLimitBytes)();
  const rss = deps.rssBytes?.() ?? process.memoryUsage().rss;
  if (!exportAdmitted(memoryLimit, rss)) throw new ExportOverloadedError();
  const semaphore = deps.semaphore ?? exportSemaphore;
  const release = semaphore.tryAcquire(
    request.userId,
    request.format === 'md' ? 'markdown' : 'file',
  );
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

    const runningWorker = new ExportWorker({
      limits,
      deadline,
      // A Markdown export keeps its slot until the zip has been fully read or destroyed, which
      // can be long after the render worker exited. The other formats end with the worker.
      ...(request.format === 'md' ? {} : { release: finish }),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(deps.internal ? { internal: deps.internal } : {}),
    });
    worker = runningWorker;
    const analysis = await runningWorker.analyze(loaded.note.body);
    checkDocumentLimits(analysis.size, limits);
    deadline.check();

    if (request.format === 'md') {
      return await markdownExport(
        deps,
        title,
        files,
        analysis.fileIds,
        deadline,
        runningWorker,
        finish,
        request.signal,
      );
    }

    const { images, tooLarge } = await readImages(deps, files, analysis.fileIds, {
      deadline,
      worker: runningWorker,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (tooLarge) throw new TooLargeError('the note images exceed the export budget');
    deadline.check();
    const fileNames = new Map(files.map((file) => [file.id, file.filename]));
    const body = await runningWorker.render({
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
      done: outputDone(runningWorker, finish),
    };
  } catch (err) {
    // The slot is released by the worker's exit handler; dispose waits for that exit on every
    // failure path (including a worker that never started).
    if (worker) await worker.dispose().catch(() => undefined);
    finish();
    throw err;
  }
}

/**
 * Read the images with one abort signal covering everything that can end the export early: the
 * client disconnect, the deadline, and a worker that died while the files were being read. The
 * bytes are read with `fs.promises.readFile` and its `signal`, so an abort stops the read rather
 * than letting a 10 MB file run to completion for a response nobody is waiting for.
 */
async function readImages(
  deps: NoteExportDeps,
  files: readonly NoteFileRow[],
  referencedIds: readonly string[],
  opts: { deadline: ExportDeadline; worker: ExportWorker; signal?: AbortSignal },
): Promise<{ images: Map<string, NoteImageBytes>; tooLarge: boolean }> {
  const abort = new AbortController();
  const abortRead = (reason: unknown) => {
    if (abort.signal.aborted) return;
    abort.abort(reason instanceof Error ? reason : new Error(String(reason ?? 'export aborted')));
  };
  const onRequestAbort = () => abortRead(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onRequestAbort, { once: true });
  const onWorkerFailure = () => abortRead(opts.worker.failureSignal.reason);
  opts.worker.failureSignal.addEventListener('abort', onWorkerFailure, { once: true });
  const timer = setTimeout(() => abortRead(new ExportTimeoutError()), opts.deadline.remaining());
  try {
    return await loadNoteImages(deps.store, files, new Set(referencedIds), {
      signal: abort.signal,
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onRequestAbort);
    opts.worker.failureSignal.removeEventListener('abort', onWorkerFailure);
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
  signal?: AbortSignal,
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
  // Markdown is done with the worker; terminate it before the (I/O-bound) zip is streamed. The
  // slot deliberately stays with the zip, not the worker: a client reading it slowly can hold
  // the archive producer for as long as its socket lives.
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

  // The zip producer observes the disconnect signal itself, and a timer at the export deadline
  // aborts a stalled entry even when the producer is waiting on a reader that never reads. The
  // abort destroys the zip stream; the route answers by destroying the response.
  const abort = new AbortController();
  const abortZip = (reason: unknown) => {
    if (abort.signal.aborted) return;
    abort.abort(reason instanceof Error ? reason : new Error(String(reason ?? 'export aborted')));
  };
  const onRequestAbort = () => abortZip(signal?.reason);
  signal?.addEventListener('abort', onRequestAbort, { once: true });
  if (signal?.aborted) abortZip(signal.reason);
  const timer = setTimeout(() => abortZip(new ExportTimeoutError()), deadline.remaining());
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onRequestAbort);
  };

  const mdName = safeEntryName(`${cleanedBase(title)}.md`);
  const zip = new ZipWriter({ signal: abort.signal, deadline });
  // The slot is held until the archive has actually been consumed or torn down. `finish` is
  // idempotent, so the route's own `done()` and these handlers can race freely.
  zip.stream.once('end', () => {
    cleanup();
    finish();
  });
  zip.stream.once('close', () => {
    cleanup();
    finish();
  });
  void (async () => {
    await zip.add(redactCensored(mdName), result.markdown);
    for (const file of exported) {
      deadline.check();
      const entry = entryNames.get(file.id);
      if (!entry) continue;
      // `addFile` opens the file before the entry header, so a vanished file leaves no
      // half-written entry. It was probed a moment ago, so a miss here breaks the download
      // rather than quietly leaving the zip inconsistent with the Markdown.
      const added = await zip.addFile(entry, path.join(deps.store.dir, file.id), {
        ...(deps.internal?.onZipRead ? { onRead: deps.internal.onZipRead } : {}),
      });
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
function workerImage(image: NoteImageBytes): WorkerImage {
  const bytes = new ArrayBuffer(image.bytes.length);
  new Uint8Array(bytes).set(image.bytes);
  return {
    id: image.id,
    filename: image.filename,
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
 * redacted again here, the base is never percent-decoded, and the assembled name goes through
 * the same Windows device-name check as a zip entry: `CON` becomes `_CON.pdf`, whether it
 * reaches a browser's save dialog or an unzipped archive.
 */
export function exportFilename(title: string, extension: string): string {
  const base = redactCensored(cleanedBase(redactExportText(title)));
  const fileName = avoidReservedWindowsName(`${base}.${extension}`);
  const encoded = encodeURIComponent(fileName).replace(
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
 * Redact censor markers, including any hidden behind percent-encoding. Stored names are never
 * decoded as names — `%20` stays `%20` — but emitting the literal `%7B%7Bcensored…` would put
 * the ciphertext in a header, a zip path or the Markdown body just the same.
 *
 * The scan is per character and tolerant of mixed encoding: in `%7B{censored…`, every character
 * of `{{censored` may be raw or a `%XX` escape, in any case. A malformed escape elsewhere in the
 * string (a stray `%zz`) is ignored instead of aborting the whole check, and only the marker
 * (with everything up to its closer) is rewritten, so the rest of the name is untouched.
 */
export function redactExportText(text: string): string {
  return redactEncodedCensorMarkers(redactCensored(text));
}

const CENSOR_MARKER_CHARS = ['{', '{', 'c', 'e', 'n', 's', 'o', 'r', 'e', 'd'] as const;

/** A raw character or one `%XX` escape, without throwing on a malformed escape. */
function readEncodedChar(text: string, at: number): { char: string; next: number } | null {
  if (at >= text.length) return null;
  if (text.charCodeAt(at) === 0x25) {
    const hex = text.slice(at + 1, at + 3);
    if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
    return { char: String.fromCharCode(Number.parseInt(hex, 16)), next: at + 3 };
  }
  return { char: text.charAt(at), next: at + 1 };
}

/** The index after `{{censored` at `start` (raw or encoded, any case), or -1. */
function censorMarkerEnd(text: string, start: number): number {
  let at = start;
  for (const expected of CENSOR_MARKER_CHARS) {
    const read = readEncodedChar(text, at);
    if (!read || read.char.toLowerCase() !== expected) return -1;
    at = read.next;
  }
  return at;
}

/** The index after the next `}}` (raw or encoded) at or after `from`, or -1. */
function censorCloserEnd(text: string, from: number): number {
  for (let at = from; at < text.length; at++) {
    const first = readEncodedChar(text, at);
    if (!first || first.char !== '}') continue;
    const second = readEncodedChar(text, first.next);
    if (second?.char === '}') return second.next;
  }
  return -1;
}

/** Percent-decode only well-formed escapes; malformed ones stay literal. */
function decodeEncodedChars(text: string): string {
  let out = '';
  for (let at = 0; at < text.length;) {
    const read = readEncodedChar(text, at);
    if (!read) {
      out += text.charAt(at);
      at++;
    } else {
      out += read.char;
      at = read.next;
    }
  }
  return out;
}

function redactEncodedCensorMarkers(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  let search = 0;
  for (;;) {
    let start = -1;
    let end = -1;
    for (let at = search; at < text.length; at++) {
      end = censorMarkerEnd(text, at);
      if (end !== -1) {
        start = at;
        break;
      }
    }
    if (start === -1) break;
    const close = censorCloserEnd(text, end);
    // With no closer the rest of the string may still be the span: redacting it whole is the
    // safe direction, exactly as `redactCensored` treats an unclosed raw token.
    const spanEnd = close === -1 ? text.length : close;
    const decoded = decodeEncodedChars(text.slice(start, spanEnd));
    const redacted = redactCensored(decoded);
    parts.push(
      text.slice(copied, start),
      // A full token becomes the placeholder; a bare marker is still suppressed.
      redacted !== decoded ? redacted : CENSOR_PLACEHOLDER,
    );
    copied = spanEnd;
    search = spanEnd;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(copied));
  return parts.join('');
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
