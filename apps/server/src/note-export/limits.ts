import type { Block, Run } from './ast.js';

/**
 * The hard limits one export runs under. They bound the work a hostile note body can cost (a
 * 512 KiB body can expand into a very large number of tokens and runs), the size of what a
 * single request can make the server produce, and how long it may take. Every limit is
 * overridable at registration so tests can exercise it with a small document.
 */
export interface ExportLimits {
  /** markdown-it tokens from `md.parse`, counted before the document model is built. */
  maxTokens: number;
  /** Blocks, list items and table rows, counted recursively. */
  maxBlocks: number;
  /** Table cells in the whole document. */
  maxTableCells: number;
  /** Text, break and image runs, in paragraphs and table cells. */
  maxInlineRuns: number;
  /** Image placements (not distinct files: the same file may be placed more than once). */
  maxImagePlacements: number;
  /** Link annotations in one PDF, after contiguous link runs are coalesced. */
  maxLinkAnnotations: number;
  /** Bytes of one response; the stream is destroyed when it goes past this. */
  maxOutputBytes: number;
  /** Wall-clock budget for rendering one export. */
  deadlineMs: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxTokens: 200_000,
  maxBlocks: 50_000,
  maxTableCells: 100_000,
  maxInlineRuns: 500_000,
  maxImagePlacements: 500,
  maxLinkAnnotations: 20_000,
  maxOutputBytes: 100 * 1024 * 1024,
  deadlineMs: 30_000,
};

/** More lines than this is never a note a person wrote, and a parser would walk each one. */
export const MAX_BODY_LINES = 20_000;
/** A sparse table can be one row with tens of thousands of empty cells; refuse it early. */
export const MAX_BODY_PIPES = 50_000;

/**
 * The cheap shape check that runs before `md.parse`, on both threads: line count and `|` count
 * in one linear pass. A sparse-table bomb is refused here after ~50,000 characters instead of
 * letting markdown-it allocate tokens for every empty cell, and a body with a huge number of
 * one-line blocks is refused before the parser sees it. The worker's heap limit is the backstop
 * for anything this cannot predict.
 *
 * Line breaks are normalised: `\r\n` is one break, and a lone `\r` is a break too, because
 * CommonMark treats all three forms as line endings. Counting only `\n` would let a body of
 * 100,000 `\r`-separated lines reach the parser while the cheap guard saw one line.
 */
export function checkBodyShape(body: string): void {
  let lines = body === '' ? 0 : 1;
  let pipes = 0;
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index);
    if (code === 0x0d) {
      // CRLF is one line break; swallowing the LF here also means it cannot count twice.
      if (body.charCodeAt(index + 1) === 0x0a) index++;
      lines++;
      if (lines > MAX_BODY_LINES)
        throw new TooLargeError(`note body has more than ${MAX_BODY_LINES} lines`);
    } else if (code === 0x0a) {
      lines++;
      if (lines > MAX_BODY_LINES)
        throw new TooLargeError(`note body has more than ${MAX_BODY_LINES} lines`);
    } else if (code === 0x7c) {
      pipes++;
      if (pipes > MAX_BODY_PIPES)
        throw new TooLargeError(`note body has more than ${MAX_BODY_PIPES} table separators`);
    }
  }
}

/** A document-level limit was exceeded: the route answers `413 too_large`. */
export class TooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooLargeError';
  }
}

/** Rendering took longer than the deadline: the route answers `503 export_timeout`. */
export class ExportTimeoutError extends Error {
  constructor(message = 'export deadline exceeded') {
    super(message);
    this.name = 'ExportTimeoutError';
  }
}

/** What a document costs to render, measured once from the parsed model. */
export interface DocumentSize {
  blocks: number;
  tableCells: number;
  inlineRuns: number;
  imagePlacements: number;
}

function countRuns(runs: readonly Run[], size: DocumentSize): void {
  for (const run of runs) {
    size.inlineRuns++;
    if (run.kind === 'image') size.imagePlacements++;
  }
}

/**
 * One walk over the document model: blocks (as `countBlocks` counts them), table cells, inline
 * runs and image placements. Linear in the document, like the renderers themselves.
 */
export function measureDocument(blocks: readonly Block[]): DocumentSize {
  const size: DocumentSize = { blocks: 0, tableCells: 0, inlineRuns: 0, imagePlacements: 0 };
  const walk = (list: readonly Block[]) => {
    for (const block of list) {
      size.blocks++;
      switch (block.type) {
        case 'heading':
        case 'paragraph':
          countRuns(block.runs, size);
          break;
        case 'code':
        case 'hr':
        case 'embed':
          break;
        case 'image':
          size.imagePlacements++;
          break;
        case 'quote':
          walk(block.blocks);
          break;
        case 'list':
          for (const item of block.items) {
            size.blocks++;
            walk(item.blocks);
          }
          break;
        case 'table':
          size.blocks += block.header.length + block.rows.length;
          size.tableCells += block.header.length;
          for (const cell of block.header) countRuns(cell, size);
          for (const row of block.rows) {
            size.tableCells += row.length;
            for (const cell of row) countRuns(cell, size);
          }
          break;
      }
    }
  };
  walk(blocks);
  return size;
}

/** Refuse a document that is over any document-level limit, before a renderer touches it. */
export function checkDocumentLimits(size: DocumentSize, limits: ExportLimits): void {
  if (size.blocks > limits.maxBlocks)
    throw new TooLargeError(`document has more than ${limits.maxBlocks} blocks`);
  if (size.tableCells > limits.maxTableCells)
    throw new TooLargeError(`document has more than ${limits.maxTableCells} table cells`);
  if (size.inlineRuns > limits.maxInlineRuns)
    throw new TooLargeError(`document has more than ${limits.maxInlineRuns} inline runs`);
  if (size.imagePlacements > limits.maxImagePlacements)
    throw new TooLargeError(`document has more than ${limits.maxImagePlacements} images`);
}

/**
 * A wall-clock deadline. The renderer checks it between blocks (and between zip entries), and
 * the worker supervisor checks it on a timer and terminates the worker: rendering happens off the
 * request thread, so a synchronous loop can no longer keep the clock from firing.
 */
export class ExportDeadline {
  private readonly endsAt: number;

  constructor(
    budgetMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.endsAt = this.now() + budgetMs;
  }

  check(): void {
    if (this.now() >= this.endsAt) throw new ExportTimeoutError();
  }

  /** Milliseconds left on the clock, never negative. */
  remaining(): number {
    return Math.max(0, this.endsAt - this.now());
  }
}

/**
 * The global concurrency gate. An export is CPU- and memory-heavy, so the pools are counted
 * separately: DOCX/PDF (which build a document in a worker and stream it) run one at a time,
 * while at most two Markdown exports (a render plus an I/O-bound zip) may run alongside them.
 * Every kind still counts against the caller's own limit, so one user never has more than one
 * export in flight whatever the mix. A caller over a limit gets `429 export_busy` instead of
 * queueing behind an unbounded backlog.
 */
export type ExportKind = 'file' | 'markdown';

export class ExportSemaphore {
  private readonly perUser = new Map<string, number>();
  private activeFiles = 0;
  private activeMarkdown = 0;

  constructor(
    private readonly perUserLimit = 1,
    private readonly fileLimit = 1,
    private readonly markdownLimit = 2,
  ) {}

  /** The release function, or `null` when this caller has to wait (and is refused). */
  tryAcquire(userId: string, kind: ExportKind = 'file'): (() => void) | null {
    const current = this.perUser.get(userId) ?? 0;
    if (current >= this.perUserLimit) return null;
    if (
      kind === 'file'
        ? this.activeFiles >= this.fileLimit
        : this.activeMarkdown >= this.markdownLimit
    )
      return null;
    this.perUser.set(userId, current + 1);
    if (kind === 'file') this.activeFiles++;
    else this.activeMarkdown++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.perUser.get(userId) ?? 1) - 1;
      if (left <= 0) this.perUser.delete(userId);
      else this.perUser.set(userId, left);
      if (kind === 'file') this.activeFiles--;
      else this.activeMarkdown--;
    };
  }

  /** Exports in flight: for tests and diagnostics. */
  get running(): number {
    return this.activeFiles + this.activeMarkdown;
  }
}

/** The process-wide semaphore; the route uses this one unless a test injects its own. */
export const exportSemaphore = new ExportSemaphore();
