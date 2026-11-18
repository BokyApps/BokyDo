import type { NotePatch } from '@bokydo/shared';
import { diffNotePatch, type NoteDraft } from './notes.js';

/**
 * Debounced, diff-only autosave for a note. `update` is called as the draft changes; a PATCH with
 * only the changed fields is sent `delayMs` after the last change. `flush` saves pending edits at
 * once (navigation/unmount). Saves are serialised, and the server snapshot is tracked as the
 * baseline so a field that is typed and then undone produces no request.
 *
 * Review round 2:
 *  - `pauseBody`/`resumeBody` stop the body debounce while the censor password prompt is open, so
 *    a plaintext revision can never be PATCHed behind the prompt. `flushNextUpdate` makes the
 *    revision that follows (the token document) save immediately.
 *  - `flush` truly drains: it waits for an in-flight save, then sends the latest pending patch and
 *    only resolves once everything is acknowledged (false when a save failed or the note is gone).
 *  - `pendingPatch` is the patch a `pagehide` keepalive request must carry.
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
  private paused = false;
  private stopped = false;
  private flushRequested = false;
  private idleWaiters: (() => void)[] = [];
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
    if (this.stopped || this.paused) return;
    if (this.flushRequested) {
      // The revision that follows a successful censor saves now, not after the debounce.
      this.clearTimer();
      void this.run();
      return;
    }
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
    if (this.stopped || this.paused) return;
    if (diffNotePatch(this.baseline, this.draft) === null) return;
    this.timer = setTimeout(() => void this.run(), this.delay);
  }

  private async run(): Promise<void> {
    this.clearTimer();
    if (this.stopped || this.paused) return;
    if (this.saving) {
      this.pending = true;
      return;
    }
    await this.commit(false);
  }

  private async commit(silent: boolean): Promise<boolean> {
    const patch = diffNotePatch(this.baseline, this.draft);
    if (patch === null) {
      this.flushRequested = false;
      return true;
    }
    const target = clone(this.draft);
    this.saving = true;
    this.flushRequested = false;
    if (!silent) this.deps.onStatus('saving');
    let ok = false;
    try {
      await this.deps.save(patch);
      this.baseline = target;
      if (!silent) this.deps.onStatus('saved');
      ok = true;
    } catch (err) {
      if (!silent) this.deps.onStatus('error');
      // A failed save always reports, even from a flush: the page needs to stop on a 404 and
      // keep the draft on any other error.
      this.deps.onError?.(err);
    } finally {
      this.saving = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      this.afterCommit();
    }
    return ok;
  }

  /** Continue after a save: an explicit flush wins over the debounce. */
  private afterCommit(): void {
    if (this.stopped || this.paused) return;
    if (this.pending) {
      this.pending = false;
      if (this.flushRequested) void this.run();
      else this.schedule();
      return;
    }
    if (this.flushRequested) void this.run();
  }

  private waitForIdle(): Promise<void> {
    if (!this.saving) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Whether the draft differs from the last acknowledged server snapshot. */
  isDirty(): boolean {
    return diffNotePatch(this.baseline, this.draft) !== null;
  }

  /** Whether a PATCH is currently in flight. */
  isSaving(): boolean {
    return this.saving;
  }

  /** Work that a navigation would lose right now. */
  hasUnsavedWork(): boolean {
    return this.saving || this.isDirty();
  }

  /** The patch a `pagehide` keepalive request must send, or null when everything is saved. */
  pendingPatch(): NotePatch | null {
    return diffNotePatch(this.baseline, this.draft);
  }

  /**
   * Save pending edits now and resolve once every change is acknowledged. `true` means the server
   * has the latest draft; `false` means a save failed (the draft is kept) or the note is gone.
   */
  async flush(): Promise<boolean> {
    this.clearTimer();
    for (;;) {
      if (this.saving) {
        await this.waitForIdle();
        continue;
      }
      if (this.stopped) return false;
      if (this.paused) return !this.isDirty();
      if (diffNotePatch(this.baseline, this.draft) === null) return true;
      if (!(await this.commit(true))) return false;
    }
  }

  /** Stop the body debounce while the censor prompt is open (cancels its pending save). */
  pauseBody(): void {
    this.paused = true;
    this.clearTimer();
  }

  /** Resume after the prompt; a pending revision is rescheduled unless a flush is queued. */
  resumeBody(): void {
    this.paused = false;
    if (this.stopped) return;
    if (this.flushRequested) return; // wait for the token revision, then save it immediately
    this.schedule();
  }

  /**
   * The next `update` (the censored token document) is saved immediately, without debounce. It
   * deliberately does NOT save the current draft: while a censor prompt is open that draft is the
   * plaintext the user is about to replace.
   */
  flushNextUpdate(): void {
    this.flushRequested = true;
    this.clearTimer();
  }

  /** Reconcile with a fresh server snapshot (e.g. after a conflict). */
  reset(snapshot: NoteDraft): void {
    this.clearTimer();
    this.stopped = false;
    this.saving = false;
    this.pending = false;
    this.flushRequested = false;
    this.baseline = clone(snapshot);
    this.draft = clone(snapshot);
  }

  /** A 404: stop autosaving altogether (the draft stays on screen). */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.pending = false;
  }
}
