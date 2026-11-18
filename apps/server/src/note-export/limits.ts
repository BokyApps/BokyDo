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
  maxOutputBytes: 200 * 1024 * 1024,
  deadlineMs: 30_000,
};

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
 * A wall-clock deadline, checked between blocks (and between zip entries) so a pathological
 * document is abandoned instead of holding a render slot for minutes. Rendering is synchronous
 * per block, so this is as fine-grained as it can be without worker threads.
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
}

/**
 * At most one export per user and three in the whole process: an export is CPU-heavy, and a
 * handful of concurrent PDFs would starve the rest of the API. A fourth caller gets
 * `429 export_busy` instead of queueing behind an unbounded backlog.
 */
export class ExportSemaphore {
  private readonly perUser = new Map<string, number>();
  private active = 0;

  constructor(
    private readonly perUserLimit = 1,
    private readonly globalLimit = 3,
  ) {}

  /** The release function, or `null` when this caller has to wait (and is refused). */
  tryAcquire(userId: string): (() => void) | null {
    if (this.active >= this.globalLimit) return null;
    const current = this.perUser.get(userId) ?? 0;
    if (current >= this.perUserLimit) return null;
    this.perUser.set(userId, current + 1);
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.perUser.get(userId) ?? 1) - 1;
      if (left <= 0) this.perUser.delete(userId);
      else this.perUser.set(userId, left);
      this.active--;
    };
  }

  /** Exports in flight: for tests and diagnostics. */
  get running(): number {
    return this.active;
  }
}

/** The process-wide semaphore; the route uses this one unless a test injects its own. */
export const exportSemaphore = new ExportSemaphore();
