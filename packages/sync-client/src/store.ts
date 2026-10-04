import {
  MAX_COMMANDS_PER_SYNC,
  type Command,
  type CommandResult,
  type SyncRequest,
  type SyncResponse,
} from '@bokydo/shared';
import { applyCommand } from './reducers.js';
import { applyServerResponse, draftOf, emptyState, type SyncState } from './state.js';

export interface Transport {
  sync(request: SyncRequest): Promise<SyncResponse>;
}

export interface SyncStoreOptions {
  /** Called once per command the server rejected (its optimistic effect has been rolled back). */
  onRejected?: (command: Command, result: Extract<CommandResult, { ok: false }>) => void;
  /** Called when the server can't be reached; commands stay queued and are retried. */
  onOffline?: (error: unknown) => void;
  now?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Delay before retrying after a network failure (doubles up to 60 s). */
  retryBaseMs?: number;
}

type Listener = (state: SyncState) => void;

/**
 * Client-side sync engine.
 *
 *   view = confirmed server state + replay(queued commands)
 *
 * Commands apply instantly to the view (optimistic). A batch is sent to the server; the response
 * replaces confirmed state and the batch leaves the queue. A rejected command therefore simply
 * vanishes from the replay, which *is* the rollback; commands queued meanwhile are replayed on
 * top of the new server state (rebase). Command UUIDs make retries after network failures safe.
 */
export class SyncStore {
  private confirmed: SyncState = emptyState();
  private queue: Command[] = [];
  private inflight: Command[] = [];
  private cursor: string | null = null;
  private view: SyncState = this.confirmed;
  private listeners = new Set<Listener>();
  private flushing: Promise<void> | null = null;
  private again = false;
  private retryMs: number;
  private retryScheduled = false;
  private readonly opts: Required<Pick<SyncStoreOptions, 'now' | 'setTimer' | 'retryBaseMs'>> &
    SyncStoreOptions;

  constructor(
    private readonly transport: Transport,
    opts: SyncStoreOptions = {},
  ) {
    this.opts = {
      now: () => new Date().toISOString(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      retryBaseMs: 1000,
      ...opts,
    };
    this.retryMs = this.opts.retryBaseMs;
  }

  get state(): SyncState {
    return this.view;
  }

  /** Commands not yet confirmed by the server (for "saving…" / offline indicators). */
  get pendingCount(): number {
    return this.queue.length + this.inflight.length;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply a command locally now and send it to the server soon. */
  enqueue(command: Command): void {
    this.queue.push(command);
    this.recompute();
    void this.flush();
  }

  /** Resolves when no round trip is in progress (without starting one). */
  whenIdle(): Promise<void> {
    return this.flushing ?? Promise.resolve();
  }

  /** Fetch remote changes (e.g. after an event-stream poke). */
  pull(): Promise<void> {
    return this.flush();
  }

  /** Send queued commands and merge the response. Concurrent calls coalesce into one more round. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.again = false;
          await this.roundTrip();
        } while (this.again || this.queue.length > 0);
      } catch (err) {
        this.opts.onOffline?.(err);
        this.scheduleRetry();
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  private async roundTrip(): Promise<void> {
    this.inflight = this.queue.splice(0, MAX_COMMANDS_PER_SYNC);
    let res: SyncResponse;
    try {
      res = await this.transport.sync({ cursor: this.cursor, commands: this.inflight });
    } catch (err) {
      // Put the batch back in front, in order; same UUIDs make the retry idempotent.
      this.queue.unshift(...this.inflight);
      this.inflight = [];
      throw err;
    }
    this.retryMs = this.opts.retryBaseMs;
    this.confirmed = applyServerResponse(this.confirmed, res);
    this.cursor = res.cursor;
    for (const command of this.inflight) {
      const result = res.results[command.uuid];
      if (result && !result.ok) this.opts.onRejected?.(command, result);
    }
    this.inflight = [];
    this.recompute();
  }

  private scheduleRetry(): void {
    if (this.retryScheduled) return;
    this.retryScheduled = true;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 60_000);
    this.opts.setTimer(() => {
      this.retryScheduled = false;
      void this.flush();
    }, delay);
  }

  private recompute(): void {
    const draft = draftOf(this.confirmed);
    const now = this.opts.now();
    for (const command of [...this.inflight, ...this.queue]) applyCommand(draft, command, now);
    this.view = draft;
    for (const listener of this.listeners) listener(this.view);
  }
}
