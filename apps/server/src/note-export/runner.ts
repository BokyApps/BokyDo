import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  ExportTimeoutError,
  TooLargeError,
  type DocumentSize,
  type ExportDeadline,
  type ExportLimits,
} from './limits.js';
import type {
  WorkerErrorKind,
  WorkerLimits,
  WorkerRenderMessage,
  WorkerResponse,
} from './worker.js';

/**
 * The main-thread half of the export worker. It owns exactly one `node:worker_threads` Worker
 * per export, with a hard heap and stack budget, and is the only place that terminates it:
 *
 * - the export deadline starts when the semaphore slot is acquired (in `export.ts`), so a slow
 *   worker is killed 30 s after the request started — before auth/DB time is counted differently;
 * - a client disconnect destroys the render stream, which terminates the worker immediately;
 * - the semaphore slot is released from the worker's `'exit'` handler, never earlier, so a slow
 *   kill cannot leave a terminated-but-alive thread holding a slot;
 * - a worker that dies (`ERR_WORKER_OUT_OF_MEMORY`, a non-zero exit, a thrown error) becomes
 *   `TooLargeError` (413) or a plain `Error` (500) before the first chunk, and a destroyed stream
 *   after it. Every promise is observed: nothing here can become an unhandled rejection.
 */

/** The resource budget of one render. Images are external buffers and are not in this heap. */
export const EXPORT_WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
} as const;

/** Test-only hooks. The HTTP route never sets these; `runNoteExport` passes its own. */
export interface NoteExportInternal {
  /** Replace the real renderer in the worker to exercise the failure paths. */
  testRenderer?: 'oom' | 'throw' | 'slow' | 'slow-stream';
  /** Called when the worker thread has exited, whatever ended it. */
  onWorkerExit?: () => void;
}

export interface ExportWorkerOptions {
  limits: ExportLimits;
  deadline: ExportDeadline;
  /** Release the semaphore slot; called once, from the worker's exit handler. */
  release?: () => void;
  /** Aborted when the client disconnects; the worker dies before waiting for its deadline. */
  signal?: AbortSignal;
  internal?: NoteExportInternal;
}

export interface AnalyzeResult {
  fileIds: string[];
  size: DocumentSize;
  tokens: number;
}

export interface MarkdownResult {
  markdown: string;
  fileIds: string[];
}

export type RenderMessage = Omit<WorkerRenderMessage, 'type'>;

interface PendingAnalyze {
  kind: 'analyze';
  resolve(result: AnalyzeResult): void;
  reject(err: Error): void;
}

interface PendingMarkdown {
  kind: 'markdown';
  resolve(result: MarkdownResult): void;
  reject(err: Error): void;
}

interface PendingRender {
  kind: 'render';
  stream: WorkerRenderStream;
}

type Pending = PendingAnalyze | PendingMarkdown | PendingRender;

export class ExportWorker {
  private worker: Worker | null = null;
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private exited = false;
  private disposing = false;
  private completed = false;
  private failure: Error | null = null;
  private pending: Pending | null = null;
  /** A render whose last chunk arrived; the stream ends once the worker has really exited. */
  private finishAfterExit: WorkerRenderStream | null = null;
  private timer: NodeJS.Timeout | null = null;
  private released = false;
  private readonly onAbort = () => this.fail(new Error('export aborted by the client'));

  constructor(private readonly options: ExportWorkerOptions) {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    if (options.signal?.aborted) {
      this.startupFailure(new Error('export aborted by the client'));
      return;
    }
    let entry: { url: URL; execArgv: string[] };
    try {
      entry = resolveWorkerEntry();
    } catch (err) {
      this.startupFailure(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    try {
      this.worker = new Worker(entry.url, {
        resourceLimits: EXPORT_WORKER_RESOURCE_LIMITS,
        execArgv: entry.execArgv,
        ...(this.options.internal?.testRenderer
          ? { workerData: { testRenderer: this.options.internal.testRenderer } }
          : {}),
      });
    } catch (err) {
      this.startupFailure(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.worker.on('message', (message: WorkerResponse) => this.onMessage(message));
    this.worker.on('error', (err: Error) => this.onWorkerError(err));
    this.worker.on('exit', () => this.onExit());
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    // The deadline is the main thread's, not a hint to the worker: it starts at slot acquisition.
    this.timer = setTimeout(() => this.onDeadline(), this.options.deadline.remaining());
  }

  /** Whether the worker has already exited; for tests and diagnostics. */
  get isExited(): boolean {
    return this.exited;
  }

  /** Parse the body and return the file ids it references. All parsing happens in the worker. */
  async analyze(body: string): Promise<AnalyzeResult> {
    if (this.failure) throw this.failure;
    if (!this.worker || this.exited) throw new Error('export worker is not running');
    this.options.deadline.check();
    return new Promise<AnalyzeResult>((resolve, reject) => {
      this.pending = { kind: 'analyze', resolve, reject };
      try {
        this.worker?.postMessage({
          type: 'analyze',
          body,
          limits: this.workerLimits(),
        });
      } catch (err) {
        this.pending = null;
        this.fail(err instanceof Error ? err : new Error(String(err)));
        reject(this.failure ?? new Error('export worker failed'));
      }
    });
  }

  /** Render Markdown in the worker; the zip is built by the caller on the main thread. */
  async renderMarkdown(message: Omit<RenderMessage, 'format' | 'images'>): Promise<MarkdownResult> {
    if (this.failure) throw this.failure;
    if (!this.worker || this.exited) throw new Error('export worker is not running');
    this.options.deadline.check();
    return new Promise<MarkdownResult>((resolve, reject) => {
      this.pending = { kind: 'markdown', resolve, reject };
      try {
        this.worker?.postMessage({ type: 'render', format: 'md', ...message });
      } catch (err) {
        this.pending = null;
        this.fail(err instanceof Error ? err : new Error(String(err)));
        reject(this.failure ?? new Error('export worker failed'));
      }
    });
  }

  /**
   * Start a DOCX/PDF render and wait for the first chunk (or end/error) before returning. An
   * out-of-memory worker therefore becomes a status code, not a truncated download.
   */
  async render(
    message: Omit<RenderMessage, 'format'> & { format: 'docx' | 'pdf' },
  ): Promise<Readable> {
    if (this.failure) throw this.failure;
    if (!this.worker || this.exited) throw new Error('export worker is not running');
    this.options.deadline.check();
    const stream = new WorkerRenderStream(this, this.options.limits.maxOutputBytes);
    this.pending = { kind: 'render', stream };
    try {
      // The image bytes are copies made on the main thread for this message; transfer them so
      // the 50 MB image budget is never held twice while the worker renders.
      const transfer = (message.images ?? []).map((image) => image.bytes);
      this.worker.postMessage({ type: 'render', ...message }, transfer);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.fail(error);
      throw this.failure ?? error;
    }
    await stream.started;
    return stream;
  }

  /** Terminate the worker (if running) and wait until the thread has really exited. */
  async dispose(): Promise<void> {
    this.disposing = true;
    if (this.worker && !this.exited) {
      try {
        await this.worker.terminate();
      } catch {
        // Already gone; the exit handler still runs and releases the slot.
      }
    }
    await this.exitPromise;
  }

  private workerLimits(): WorkerLimits {
    return {
      maxTokens: this.options.limits.maxTokens,
      maxBlocks: this.options.limits.maxBlocks,
      maxTableCells: this.options.limits.maxTableCells,
      maxInlineRuns: this.options.limits.maxInlineRuns,
      maxImagePlacements: this.options.limits.maxImagePlacements,
      maxLinkAnnotations: this.options.limits.maxLinkAnnotations,
      maxOutputBytes: this.options.limits.maxOutputBytes,
      deadlineAt: Date.now() + this.options.deadline.remaining(),
    };
  }

  private onMessage(message: WorkerResponse): void {
    switch (message.type) {
      case 'analyzed': {
        const pending = this.pending;
        if (pending?.kind !== 'analyze') return;
        this.pending = null;
        pending.resolve({
          fileIds: message.fileIds,
          size: message.size,
          tokens: message.tokens,
        });
        return;
      }
      case 'markdown': {
        const pending = this.pending;
        if (pending?.kind !== 'markdown') return;
        this.pending = null;
        this.completed = true;
        pending.resolve({ markdown: message.markdown, fileIds: message.fileIds });
        this.stopWorker();
        return;
      }
      case 'chunk': {
        const pending = this.pending;
        if (pending?.kind !== 'render') return;
        if (pending.stream.destroyed) {
          this.stopWorker();
          return;
        }
        pending.stream.handleChunk(Buffer.from(message.bytes));
        return;
      }
      case 'done': {
        const pending = this.pending;
        if (pending?.kind !== 'render') return;
        this.pending = null;
        this.completed = true;
        // The response ends after the worker has exited, so the slot is free before a client
        // that reads the whole body asks for its next export.
        this.finishAfterExit = pending.stream;
        pending.stream.noteDone();
        this.stopWorker();
        return;
      }
      case 'error': {
        this.fail(errorFor(message.kind, message.message));
        return;
      }
      default:
        return;
    }
  }

  private onWorkerError(err: Error): void {
    const oom = (err as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY';
    this.fail(
      oom ? new TooLargeError('the note export exceeded its memory budget') : (this.failure ?? err),
    );
  }

  private onExit(): void {
    this.exited = true;
    this.options.signal?.removeEventListener('abort', this.onAbort);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // An exit with no answer (crash, kill, an injected renderer) must not leave the caller
    // waiting for a message that will never come.
    if (!this.completed && !this.disposing && !this.failure)
      this.fail(new Error('the note export worker exited before it finished'));
    this.releaseSlot();
    this.finishAfterExit?.handleDone();
    this.finishAfterExit = null;
    this.resolveExit();
  }

  private onDeadline(): void {
    this.timer = null;
    this.fail(new ExportTimeoutError());
  }

  /** Kill the worker because its output passed the byte cap. */
  failStream(err: Error): void {
    this.fail(err);
  }

  /** Record the first failure, reject whatever is waiting, and kill the worker. */
  private fail(err: Error): void {
    if (this.failure || this.completed) return;
    this.failure = err;
    const pending = this.pending;
    this.pending = null;
    if (pending?.kind === 'analyze' || pending?.kind === 'markdown') pending.reject(err);
    else if (pending?.kind === 'render') pending.stream.fail(err);
    this.stopWorker();
  }

  private stopWorker(): void {
    if (!this.worker || this.exited) return;
    void this.worker.terminate().catch(() => undefined);
  }

  private startupFailure(err: Error): void {
    this.failure = err;
    this.exited = true;
    this.releaseSlot();
    this.resolveExit();
  }

  private releaseSlot(): void {
    if (this.released) return;
    this.released = true;
    try {
      this.options.release?.();
    } finally {
      this.options.internal?.onWorkerExit?.();
    }
  }

  /** One backpressure acknowledgement for the chunk the stream just accepted. */
  sendAck(): void {
    if (!this.worker || this.exited || this.completed) return;
    try {
      this.worker.postMessage({ type: 'ack' });
    } catch {
      // The worker is going away; its exit handler will release the slot.
    }
  }

  /** The consumer destroyed the render stream: it will never read another chunk. */
  streamClosed(): void {
    this.stopWorker();
  }
}

/**
 * The readable side of a worker render. The worker sends one chunk and waits for `ack`; the ack
 * is only sent when this stream accepted the chunk, so at most one message-sized chunk is alive
 * in the main process beyond the stream's own buffer. Past `maxBytes` the worker is killed and
 * the stream errors, which is how a 100 MB output cap is enforced while data arrives.
 */
export class WorkerRenderStream extends Readable {
  readonly started: Promise<void>;
  private resolveStart!: () => void;
  private rejectStart!: (err: Error) => void;
  private startSettled = false;
  private bytes = 0;
  private ackOnRead = false;
  private done = false;

  constructor(
    private readonly runner: ExportWorker,
    private readonly maxBytes: number,
  ) {
    super();
    this.started = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    // `fail()` can destroy this stream before `render()` has handed it to a consumer (the first
    // chunk is what hands it over). That error is reported through `started`; an unobserved
    // `'error'` event here would be an uncaught exception instead.
    this.on('error', () => undefined);
    // The consumer may destroy the stream before anything awaits `started` (a route that sees
    // its socket close); that must not be an unhandled rejection.
    this.started.catch(() => undefined);
  }

  override _read(): void {
    if (!this.ackOnRead) return;
    this.ackOnRead = false;
    this.runner.sendAck();
  }

  handleChunk(chunk: Buffer): void {
    if (this.destroyed || this.done) return;
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      this.runner.failStream(new TooLargeError(`export exceeded ${this.maxBytes} bytes`));
      return;
    }
    this.settleStart();
    if (this.push(chunk)) this.runner.sendAck();
    else this.ackOnRead = true;
  }

  /** The worker said `done`; the stream still waits for the worker's exit before ending. */
  noteDone(): void {
    this.settleStart();
  }

  handleDone(): void {
    if (this.destroyed) return;
    this.done = true;
    this.settleStart();
    this.push(null);
  }

  fail(err: Error): void {
    if (this.destroyed) return;
    this.rejectStarted(err);
    this.destroy(err);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // A disconnect, a cap, or a normal end: all of them mean no consumer will read another
    // chunk, so the worker must go now and the slot is released from its exit handler.
    this.runner.streamClosed();
    this.rejectStarted(error ?? new Error('export stream closed'));
    callback(error);
  }

  private settleStart(): void {
    if (this.startSettled) return;
    this.startSettled = true;
    this.resolveStart();
  }

  private rejectStarted(err: Error): void {
    if (this.startSettled) return;
    this.startSettled = true;
    this.rejectStart(err);
  }
}

function errorFor(kind: WorkerErrorKind, message: string): Error {
  if (kind === 'too_large') return new TooLargeError(message);
  if (kind === 'timeout') return new ExportTimeoutError(message);
  return new Error(message);
}

/**
 * The worker entry:
 *
 * - while the server runs from source (vitest, `tsx watch`), `worker-boot.ts` loads the real
 *   TypeScript `worker.ts` through tsx. Node's own type stripping can run the boot file, and
 *   `tsImport` gives the rest of the graph tsx's `.js` → `.ts` mapping;
 * - after `tsc -p tsconfig.build.json`, the sibling `worker.js` is the entry and Node runs it
 *   with no loader at all.
 *
 * `tsconfig.build.json` emits every non-test file under `src`, so `worker.js` always exists in
 * `dist/note-export/`. Verified against a built tree in the task's own check script.
 */
function resolveWorkerEntry(): { url: URL; execArgv: string[] } {
  const base = new URL(import.meta.url);
  base.search = '';
  base.hash = '';
  const source = new URL('./worker.ts', base);
  if (existsSync(fileURLToPath(source))) {
    const boot = new URL('./worker-boot.ts', base);
    if (!existsSync(fileURLToPath(boot)))
      throw new Error('the note export worker bootstrap is missing');
    // `tsImport` needs tsx at runtime; report that as a configuration error, not a crash.
    try {
      createRequire(base).resolve('tsx');
    } catch {
      throw new Error('the note export worker needs tsx to load TypeScript');
    }
    return {
      url: boot,
      execArgv: ['--conditions=bokydo-source', '--disable-warning=ExperimentalWarning'],
    };
  }
  return { url: new URL('./worker.js', base), execArgv: [...process.execArgv] };
}
