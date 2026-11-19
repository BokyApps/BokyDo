import { parentPort, workerData } from 'node:worker_threads';
import { parseNoteBody, documentFileIds, type NoteDocument } from './ast.js';
import { buildDocx } from './docx.js';
import { prepareImage } from './image-info.js';
import type { LoadedImage } from './images.js';
import {
  ExportDeadline,
  ExportTimeoutError,
  TooLargeError,
  checkDocumentLimits,
  measureDocument,
  type DocumentSize,
  type ExportLimits,
} from './limits.js';
import { renderNoteMarkdown } from './markdown.js';
import { buildPdf } from './pdf.js';

/**
 * The export worker (ADR 0025 implementation note, `docs/note-export.md`). Everything an
 * attacker-controlled note body can inflate — the markdown-it parse, the AST, the docx packer
 * and pdfkit — runs here under `resourceLimits` from `runner.ts`, never on the request thread.
 *
 * Protocol (one worker per export):
 *
 * 1. main → `{ type: 'analyze', body, limits }`; the worker parses once and replies
 *    `{ type: 'analyzed', fileIds, size, tokens }`. A body that fails the token/block/table
 *    limits is answered with `{ type: 'error', kind: 'too_large' }`.
 * 2. main reads the files the body references and then sends `{ type: 'render', … }`.
 *    - `md` replies with one `{ type: 'markdown', markdown, fileIds }` message (the zip is built
 *      on the main thread, streaming from disk).
 *    - `docx`/`pdf` reply with `{ type: 'chunk', bytes }` messages, each waiting for an `ack`
 *      from the main thread before the next is produced, then `{ type: 'done', bytes }`.
 *
 * Every response is a plain structured-clone value; image ArrayBuffers are transferred in, and
 * chunk ArrayBuffers are transferred out. Nothing here touches a database, a request or a socket.
 */

export interface WorkerLimits {
  maxTokens: number;
  maxBlocks: number;
  maxTableCells: number;
  maxInlineRuns: number;
  maxImagePlacements: number;
  maxLinkAnnotations: number;
  maxOutputBytes: number;
  /** Epoch milliseconds the main thread's export clock expires at (it is authoritative). */
  deadlineAt: number;
}

export interface WorkerImage {
  id: string;
  filename: string;
  /** Transferred, not cloned: the buffer belongs to the worker after the post. */
  bytes: ArrayBuffer;
}

export type WorkerRenderMessage = {
  type: 'render';
  format: 'md' | 'docx' | 'pdf';
  title: string;
  fileNames: [string, string][];
  fileUrls?: [string, string][];
  fileUnavailable?: string[];
  images?: WorkerImage[];
};

export type WorkerRequest =
  { type: 'analyze'; body: string; limits: WorkerLimits } | WorkerRenderMessage | { type: 'ack' };

export type WorkerErrorKind = 'too_large' | 'timeout' | 'internal';

export type WorkerResponse =
  | { type: 'analyzed'; fileIds: string[]; size: DocumentSize; tokens: number }
  | { type: 'chunk'; bytes: ArrayBuffer }
  | { type: 'done'; bytes: number }
  | { type: 'markdown'; markdown: string; fileIds: string[] }
  | { type: 'error'; kind: WorkerErrorKind; message: string };

/** The chunk size the worker writes: one in flight, acked by the main thread's stream. */
export const WORKER_CHUNK_BYTES = 1024 * 1024;

/** Test-only render modes; never set by the route. */
type TestRenderer = 'oom' | 'throw' | 'slow' | 'slow-stream';

let document: NoteDocument | null = null;
let limits: WorkerLimits | null = null;
let deadline: ExportDeadline | null = null;
let ackResolve: (() => void) | null = null;

function post(message: WorkerResponse, transfer: ArrayBuffer[] = []): void {
  parentPort?.postMessage(message, transfer);
}

function sendError(err: unknown): void {
  const kind: WorkerErrorKind =
    err instanceof TooLargeError
      ? 'too_large'
      : err instanceof ExportTimeoutError
        ? 'timeout'
        : 'internal';
  post({ type: 'error', kind, message: err instanceof Error ? err.message : String(err) });
}

function waitForAck(): Promise<void> {
  return new Promise((resolve) => {
    ackResolve = resolve;
  });
}

/** A fresh ArrayBuffer for a stream chunk: transferring a pooled Buffer would detach the pool. */
function transferable(bytes: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function imagesFrom(message: WorkerRenderMessage): Map<string, LoadedImage> {
  const format = message.format === 'pdf' ? 'pdf' : 'docx';
  const images = new Map<string, LoadedImage>();
  for (const image of message.images ?? []) {
    // Full structural validation lives here, in the isolate: the PNG chunk/CRC walk and the
    // JPEG marker walk (once, with the EOI offset) both run under the worker's heap and deadline.
    const prepared = prepareImage(Buffer.from(image.bytes), format);
    if (!prepared) continue;
    images.set(image.id, {
      id: image.id,
      filename: image.filename,
      type: prepared.type,
      width: prepared.width,
      height: prepared.height,
      bytes: prepared.bytes,
    });
  }
  return images;
}

async function renderChunks(source: AsyncIterable<Buffer>, maxOutputBytes: number): Promise<void> {
  let sent = 0;
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    if (bytes.length === 0) continue;
    sent += bytes.length;
    if (sent > maxOutputBytes) throw new TooLargeError(`export exceeded ${maxOutputBytes} bytes`);
    // Split at the protocol's 1 MiB boundary so one huge pdfkit write cannot become a single
    // giant message. The ack keeps exactly one chunk alive at a time.
    for (let offset = 0; offset < bytes.length; offset += WORKER_CHUNK_BYTES) {
      const slice = bytes.subarray(offset, Math.min(bytes.length, offset + WORKER_CHUNK_BYTES));
      const chunk = transferable(slice);
      post({ type: 'chunk', bytes: chunk }, [chunk]);
      await waitForAck();
    }
  }
  post({ type: 'done', bytes: sent });
}

/** The injected failure/slow path: it makes the main thread's guards testable end to end. */
async function testRender(mode: TestRenderer): Promise<void> {
  switch (mode) {
    case 'throw':
      throw new Error('injected worker render failure');
    case 'oom': {
      // Unbounded until the isolate's 192 MB resourceLimit kills it.
      const hog: number[][] = [];
      for (;;) hog.push(new Array(1_000_000).fill(1));
    }
    case 'slow':
      await new Promise<void>(() => undefined);
      return;
    case 'slow-stream': {
      const chunk = transferable(Buffer.from('<slow>'));
      post({ type: 'chunk', bytes: chunk }, [chunk]);
      await new Promise<void>(() => undefined);
      return;
    }
    default:
      return;
  }
}

async function analyze(message: Extract<WorkerRequest, { type: 'analyze' }>): Promise<void> {
  limits = message.limits;
  deadline = new ExportDeadline(Math.max(0, message.limits.deadlineAt - Date.now()));
  // `parseNoteBody` applies the line/pipe shape limits before markdown-it runs, then the token
  // cap right after it; the block/table/run walk is checked before any renderer sees the model.
  document = parseNoteBody(message.body, { maxTokens: message.limits.maxTokens });
  if (document.tokenCount > message.limits.maxTokens)
    throw new TooLargeError(`note body has more than ${message.limits.maxTokens} Markdown tokens`);
  const size = measureDocument(document.blocks);
  checkDocumentLimits(size, exportLimits(message.limits));
  deadline.check();
  post({
    type: 'analyzed',
    fileIds: [...documentFileIds(document.blocks)],
    size,
    tokens: document.tokenCount,
  });
}

/** The limit shape the renderers use; they only read the document-level fields. */
function exportLimits(from: WorkerLimits): ExportLimits {
  return {
    maxTokens: from.maxTokens,
    maxBlocks: from.maxBlocks,
    maxTableCells: from.maxTableCells,
    maxInlineRuns: from.maxInlineRuns,
    maxImagePlacements: from.maxImagePlacements,
    maxLinkAnnotations: from.maxLinkAnnotations,
    maxOutputBytes: from.maxOutputBytes,
    deadlineMs: Math.max(0, from.deadlineAt - Date.now()),
  };
}

async function render(message: WorkerRenderMessage): Promise<void> {
  if (!document || !limits) throw new Error('render before analyze');
  deadline?.check();
  const testRenderer = (workerData as { testRenderer?: TestRenderer } | null)?.testRenderer;
  if (testRenderer) {
    await testRender(testRenderer);
    return;
  }
  const fileNames = new Map(message.fileNames);
  if (message.format === 'md') {
    const fileUrls = new Map(message.fileUrls ?? []);
    const fileUnavailable = new Set(message.fileUnavailable ?? []);
    const markdown = renderNoteMarkdown(message.title, document, {
      fileUrls,
      fileNames,
      fileUnavailable,
      check: () => deadline?.check(),
    });
    post({
      type: 'markdown',
      markdown,
      fileIds: [...documentFileIds(document.blocks)],
    });
    return;
  }
  const images = imagesFrom(message);
  const maxOutputBytes = limits.maxOutputBytes;
  const source =
    message.format === 'docx'
      ? buildDocx(
          message.title,
          document.blocks,
          { images, fileNames },
          { ...(deadline ? { deadline } : {}), maxOutputBytes },
        )
      : buildPdf(
          message.title,
          document.blocks,
          { images, fileNames },
          {
            ...(deadline ? { deadline } : {}),
            maxLinkAnnotations: limits.maxLinkAnnotations,
            maxOutputBytes,
          },
        );
  await renderChunks(source, maxOutputBytes);
}

async function handle(message: WorkerRequest): Promise<void> {
  if (message.type === 'ack') {
    const resolve = ackResolve;
    ackResolve = null;
    resolve?.();
    return;
  }
  if (message.type === 'analyze') {
    await analyze(message);
    return;
  }
  await render(message);
}

if (parentPort) {
  parentPort.on('message', (message: WorkerRequest) => {
    void handle(message).catch((err: unknown) => {
      // A render that already streamed chunks cannot be retracted; the main thread destroys the
      // response. Before the first chunk this becomes a status code. Never an uncaught throw.
      sendError(err);
    });
  });
}
