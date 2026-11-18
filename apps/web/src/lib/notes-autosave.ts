import type { NotePatch } from '@bokydo/shared';
import { diffNotePatch, type NoteDraft } from './notes.js';

/**
 * Debounced, diff-only autosave for a note. `update` is called as the draft changes; a PATCH with
 * only the changed fields is sent `delayMs` after the last change. `flush` saves pending edits at
 * once (navigation/unmount). Saves are serialised, and the server snapshot is tracked as the
 * baseline so a field that is typed and then undone produces no request.
 *
 * Pure enough to run under fake timers in node: it has no DOM or React dependency.
 */

export type SaveStatus = 'saving' | 'saved' | 'error';

export interface AutosaveDeps {
  save(patch: NotePatch): Promise<void>;
  onStatus(status: SaveStatus): void;
  onError?(err: unknown): void;
  delayMs?: number;
}

const clone = (d: NoteDraft): NoteDraft => ({ ...d, tags: [...d.tags] });

export class NoteAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private baseline: NoteDraft;
  private draft: NoteDraft;
  private saving = false;
  private pending = false;
  private stopped = false;
  private readonly delay: number;

  constructor(
    private readonly deps: AutosaveDeps,
    initial: NoteDraft,
  ) {
    this.baseline = clone(initial);
    this.draft = clone(initial);
    this.delay = deps.delayMs ?? 800;
  }

  /** Record the current draft and (re)start the debounce when there is something to save. */
  update(draft: NoteDraft): void {
    this.draft = clone(draft);
    if (this.stopped) return;
    this.schedule();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (diffNotePatch(this.baseline, this.draft) === null) return;
    this.timer = setTimeout(() => void this.run(), this.delay);
  }

  private async run(): Promise<void> {
    this.clearTimer();
    if (this.stopped) return;
    if (this.saving) {
      this.pending = true;
      return;
    }
    await this.commit(false);
  }

  private async commit(silent: boolean): Promise<void> {
    const patch = diffNotePatch(this.baseline, this.draft);
    if (patch === null) return;
    const target = clone(this.draft);
    this.saving = true;
    if (!silent) this.deps.onStatus('saving');
    try {
      await this.deps.save(patch);
      this.baseline = target;
      if (!silent) this.deps.onStatus('saved');
    } catch (err) {
      if (!silent) {
        this.deps.onStatus('error');
        this.deps.onError?.(err);
      }
    } finally {
      this.saving = false;
      if (this.pending) {
        this.pending = false;
        this.schedule();
      }
    }
  }

  /** Save pending edits now. Silent (no status/error callbacks) so it is safe during unmount. */
  flush(): Promise<void> {
    this.clearTimer();
    if (this.stopped || this.saving) return Promise.resolve();
    if (diffNotePatch(this.baseline, this.draft) === null) return Promise.resolve();
    return this.commit(true);
  }

  /** Reconcile with a fresh server snapshot (e.g. after a conflict). */
  reset(snapshot: NoteDraft): void {
    this.clearTimer();
    this.stopped = false;
    this.saving = false;
    this.pending = false;
    this.baseline = clone(snapshot);
    this.draft = clone(snapshot);
  }

  /** A 404: stop autosaving altogether. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }
}
