import type { NotePatch } from '@bokydo/shared';
import { diffNotePatch, isStaleRevisionError, type NoteDraft } from './notes.js';

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
 * Optimistic concurrency (ADR 0025):
 *  - `baseRevision` is the `updatedAt` of the last server state the draft is based on: the initial
 *    load, then each acknowledged save's returned `note.updatedAt`. Every PATCH is sent with it.
 *  - A `409 stale_revision` stops the queue instead of retrying: the page fetches the latest note
 *    and either adopts it (nothing local to lose) or shows the conflict banner. `keepMine` resends
 *    the whole draft with the remote revision as its new premise, after the user confirmed it.
 *
 * Pure enough to run under fake timers in node: it has no DOM or React dependency.
 */

export type SaveStatus = 'saving' | 'saved' | 'error' | 'conflict';

export interface AutosaveDeps {
  /** PATCH the patch guarded by `expectedUpdatedAt`; resolves with the new `note.updatedAt`. */
  save(patch: NotePatch, expectedUpdatedAt: string): Promise<string>;
  onStatus(status: SaveStatus): void;
  onError?(err: unknown): void;
  /** A 409 `stale_revision`: the queue stops until the page resolves the conflict. */
  onConflict?(err: unknown): void;
  /**
   * Last pass over every patch that is about to be sent (debounce, flush and keepalive). The notes
   * page uses it to verify that the Markdown still re-parses to the editor document, off the
   * keystroke path. Must be synchronous and must not throw.
   */
  preparePatch?(patch: NotePatch): NotePatch;
  delayMs?: number;
}

const clone = (d: NoteDraft): NoteDraft => ({ ...d, tags: [...d.tags] });

/** Every field, for "Keep mine": it deliberately replaces the whole saved version. */
const fullPatch = (d: NoteDraft): NotePatch => ({
  title: d.title,
  body: d.body,
  tags: [...d.tags],
  pinned: d.pinned,
});

export class NoteAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private baseline: NoteDraft;
  private draft: NoteDraft;
  private saving = false;
  private pending = false;
  private paused = false;
  /**
   * H2: while a censor prompt is open the draft body is the plaintext the user is about to
   * replace. Even if the pause is released before the token document reaches React (it is handed
   * over through a state update), the body must stay out of every lifecycle save until the
   * verified token draft arrives.
   */
  private holdBody = false;
  private stopped = false;
  private conflicted = false;
  private flushRequested = false;
  private idleWaiters: (() => void)[] = [];
  private readonly delay: number;
  private baseRevisionValue: string;
  private conflictListener: (() => void) | undefined;
  /** Registered after mount so the page's verifier can read its latest editor state. */
  private prepareHook: ((patch: NotePatch) => NotePatch) | undefined;

  constructor(
    private readonly deps: AutosaveDeps,
    initial: NoteDraft,
    initialRevision: string,
  ) {
    this.baseline = clone(initial);
    this.draft = clone(initial);
    this.baseRevisionValue = initialRevision;
    this.delay = deps.delayMs ?? 800;
  }

  /** Record the current draft and (re)start the debounce when there is something to save. */
  update(draft: NoteDraft): void {
    this.draft = clone(draft);
    if (this.stopped || this.conflicted) return;
    if (this.flushRequested) {
      // The verified token document has been handed over: the plaintext no longer exists in the
      // draft, so release the hold and save it now instead of after the debounce.
      this.paused = false;
      this.holdBody = false;
      this.clearTimer();
      void this.run();
      return;
    }
    if (this.paused) return;
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
    if (this.stopped || this.paused || this.conflicted) return;
    if (diffNotePatch(this.baseline, this.draft) === null) return;
    this.timer = setTimeout(() => void this.run(), this.delay);
  }

  private async run(): Promise<void> {
    this.clearTimer();
    if (this.stopped || this.paused || this.conflicted) return;
    if (this.saving) {
      this.pending = true;
      return;
    }
    await this.commit(false);
  }

  private async commit(silent: boolean, full = false): Promise<boolean> {
    const patch = this.prepare(
      full ? fullPatch(this.draft) : diffNotePatch(this.baseline, this.draft),
    );
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
      const revision = await this.deps.save(patch, this.baseRevisionValue);
      this.baseRevisionValue = revision;
      this.baseline = target;
      if (!silent) this.deps.onStatus('saved');
      ok = true;
    } catch (err) {
      if (isStaleRevisionError(err)) {
        // Stop sending: the draft is based on a revision the server no longer has. Retrying the
        // same premise would fail forever, and sending it unguarded could undo a censor elsewhere.
        this.conflicted = true;
        this.pending = false;
        this.flushRequested = false;
        this.deps.onStatus('conflict');
        this.deps.onConflict?.(err);
        this.conflictListener?.();
      } else {
        if (!silent) this.deps.onStatus('error');
        // A failed save always reports, even from a flush: the page needs to stop on a 404 and
        // keep the draft on any other error.
        this.deps.onError?.(err);
      }
    } finally {
      this.saving = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      this.afterCommit();
    }
    return ok;
  }

  /** Continue after a save: an explicit flush wins over the debounce. */
  private afterCommit(): void {
    if (this.stopped || this.paused || this.conflicted) return;
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

  /** The server revision the draft is based on; the premise of the next PATCH. */
  baseRevision(): string {
    return this.baseRevisionValue;
  }

  /**
   * Called once per stale-revision refusal. A listener (rather than a constructor dep) lets the
   * page build the controller in `useState` and still reach the newest conflict resolver.
   */
  setConflictListener(listener: (() => void) | undefined): void {
    this.conflictListener = listener;
  }

  /**
   * Register the page's last-pass patch hook (H4). A setter rather than only a constructor dep:
   * the page builds the controller in `useState`, and the hook must read the editor's latest
   * snapshot from a ref that only exists after mount.
   */
  setPreparePatch(hook: ((patch: NotePatch) => NotePatch) | undefined): void {
    this.prepareHook = hook;
  }

  /** Whether a 409 is waiting for the user's choice. */
  isConflicted(): boolean {
    return this.conflicted;
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

  /** Apply the page's last-pass hook, and drop the body while a censor prompt owns it. */
  private prepare(patch: NotePatch | null): NotePatch | null {
    if (patch === null) return null;
    let next: NotePatch | null = patch;
    if (this.holdBody && 'body' in next) {
      const { body: _body, ...rest } = next;
      void _body;
      next = Object.keys(rest).length ? rest : null;
    }
    if (next === null) return null;
    const prepare = this.prepareHook ?? this.deps.preparePatch;
    if (!prepare) return next;
    try {
      return prepare(next);
    } catch {
      // A verification failure must never lose the edit: send the patch as it stands.
      return next;
    }
  }

  /** The patch a `pagehide` keepalive request must send, or null when everything is saved. */
  pendingPatch(): NotePatch | null {
    return this.prepare(diffNotePatch(this.baseline, this.draft));
  }

  /**
   * Save pending edits now and resolve once every change is acknowledged. `true` means the server
   * has the latest draft; `false` means a save failed (the draft is kept), the note is gone, or a
   * revision conflict needs the user. A conflict is never retried in a loop.
   */
  async flush(): Promise<boolean> {
    this.clearTimer();
    for (;;) {
      if (this.saving) {
        await this.waitForIdle();
        continue;
      }
      if (this.stopped) return false;
      if (this.conflicted) return false;
      if (this.paused) return !this.isDirty();
      if (diffNotePatch(this.baseline, this.draft) === null) return true;
      if (!(await this.commit(true))) return false;
    }
  }

  /** Stop the body debounce while the censor prompt is open (cancels its pending save). */
  pauseBody(): void {
    this.paused = true;
    this.holdBody = true;
    this.clearTimer();
  }

  /**
   * Ordinary abort (cancelled prompt / failed censor): release the pause and restore the
   * debounce. Only used when no token is going to be applied.
   */
  resumeBody(): void {
    this.paused = false;
    this.holdBody = false;
    if (this.stopped) return;
    if (this.flushRequested) return; // wait for the token revision, then save it immediately
    this.schedule();
  }

  /**
   * A token was produced: the next `update` (the verified token document) is saved immediately
   * and releases the pause. This deliberately does NOT save the current draft: while a censor
   * prompt is open that draft is the plaintext the user is about to replace, and a page hide
   * between here and the token update must still omit it.
   */
  flushNextUpdate(): void {
    this.flushRequested = true;
    this.paused = true;
    this.holdBody = true;
    this.clearTimer();
  }

  /** Whether the body is currently withheld from lifecycle saves (censor prompt in progress). */
  isBodyHeld(): boolean {
    return this.holdBody;
  }

  /**
   * "Keep mine": the remote revision becomes the new premise and the whole draft is sent, replacing
   * the version saved elsewhere. The caller must have warned about replaced content and about
   * restoring censored text when the remote had tokens this draft lacks.
   */
  async keepMine(remoteRevision: string): Promise<boolean> {
    this.clearTimer();
    this.baseRevisionValue = remoteRevision;
    this.conflicted = false;
    this.pending = false;
    return this.commit(false, true);
  }

  /** Reconcile with a fresh server snapshot (adopting the remote note after a conflict). */
  reset(snapshot: NoteDraft, revision: string): void {
    this.clearTimer();
    this.stopped = false;
    this.conflicted = false;
    this.saving = false;
    this.pending = false;
    this.paused = false;
    this.holdBody = false;
    this.flushRequested = false;
    this.baseRevisionValue = revision;
    this.baseline = clone(snapshot);
    this.draft = clone(snapshot);
  }

  /** A 404: stop autosaving altogether (the draft stays on screen). */
  stop(): void {
    this.stopped = true;
    this.paused = false;
    this.holdBody = false;
    this.clearTimer();
    this.pending = false;
  }
}
