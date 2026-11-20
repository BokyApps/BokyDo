import type { NotePatch } from '@bokydo/shared';
import {
  diffNotePatch,
  isNoteGoneError,
  isStaleRevisionError,
  type NoteDraft,
  type CensorSaveResult,
} from './notes.js';

export type { CensorSaveResult };

/**
 * Debounced, diff-only autosave for a note. `update` is called as the draft changes; a PATCH with
 * only the changed fields is sent `delayMs` after the last change. `flush` saves pending edits at
 * once (navigation/unmount). Saves are serialised, and the server snapshot is tracked as the
 * baseline so a field that is typed and then undone produces no request.
 *
 * Censoring is its own save (final review). Before the password prompt the page calls `freeze`:
 * no field is debounced, flushed or sent by a keepalive while frozen. Cancelling the censor calls
 * `unfreeze`, which resumes normal autosave with the pre-censor draft exactly as it was (the
 * plaintext was part of the draft before the user chose to censor it). A successful censor calls
 * `saveCensoredBody`: ONE PATCH carrying only the verified token body, directly and with the last
 * acknowledged revision as its premise, never through the debounce queue. A network failure keeps
 * the freeze and stores the request so `retryCensoredSave` resends the same body and premise.
 *
 * The verification hook (`preparePatch`) stays available to every body save, including the
 * unmount flush. A hook may report `bodyUnsafe`: the body is then omitted (other fields still
 * save), the draft keeps it, and `onStatus('unsafe')` tells the page to show the explicit error.
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

export type SaveStatus = 'saving' | 'saved' | 'error' | 'unsafe' | 'conflict';

/** What the page's verifier decided for a patch that is about to be sent. */
export interface PreparedNotePatch {
  patch: NotePatch | null;
  /**
   * The body could not be represented safely. The body is never sent; the draft keeps it and the
   * page shows the "couldn't be saved safely" error while other fields keep saving.
   */
  bodyUnsafe?: boolean;
}

export type PreparePatch = (patch: NotePatch) => NotePatch | PreparedNotePatch | null;

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
  preparePatch?: PreparePatch;
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
  /**
   * Censor freeze: no debounce, flush, keepalive or direct save may start while this is true. The
   * page sets it synchronously before opening the password prompt.
   */
  private frozen = false;
  /** The verified token save that failed; a retry must reuse its body AND premise. */
  private pendingCensorSave: { body: string; expectedUpdatedAt: string } | null = null;
  private stopped = false;
  private conflicted = false;
  private idleWaiters: (() => void)[] = [];
  private readonly delay: number;
  private baseRevisionValue: string;
  private conflictListener: (() => void) | undefined;
  /** Registered after mount so the page's verifier can read its latest editor state. */
  private prepareHook: PreparePatch | undefined;

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
    if (this.stopped || this.conflicted || this.frozen) return;
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
    if (this.stopped || this.frozen || this.conflicted) return;
    if (diffNotePatch(this.baseline, this.draft) === null) return;
    this.timer = setTimeout(() => void this.run(), this.delay);
  }

  private async run(): Promise<void> {
    this.clearTimer();
    if (this.stopped || this.frozen || this.conflicted) return;
    if (this.saving) {
      this.pending = true;
      return;
    }
    await this.commit(false);
  }

  private async commit(silent: boolean, full = false): Promise<boolean> {
    const prepared = this.prepare(
      full ? fullPatch(this.draft) : diffNotePatch(this.baseline, this.draft),
    );
    const patch = prepared.patch;
    if (patch === null) {
      // A body-only patch that the verifier refused is not a successful save: keep the draft and
      // let the caller (flush / navigation) know there is still unsent work.
      if (prepared.bodyUnsafe) this.deps.onStatus('unsafe');
      return !prepared.bodyUnsafe;
    }
    const target = clone(this.draft);
    this.saving = true;
    if (!silent) this.deps.onStatus('saving');
    let ok = false;
    try {
      const revision = await this.deps.save(patch, this.baseRevisionValue);
      this.baseRevisionValue = revision;
      if (prepared.bodyUnsafe) {
        // Only the fields actually sent are acknowledged; the body stays dirty on purpose.
        this.applyPartialBaseline(patch, target);
        this.deps.onStatus('unsafe');
      } else {
        this.baseline = target;
        if (!silent) this.deps.onStatus('saved');
        ok = true;
      }
    } catch (err) {
      if (isStaleRevisionError(err)) {
        // Stop sending: the draft is based on a revision the server no longer has. Retrying the
        // same premise would fail forever, and sending it unguarded could undo a censor elsewhere.
        this.conflicted = true;
        this.pending = false;
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

  /** Acknowledge only the fields in `patch`, using their values from `target`. */
  private applyPartialBaseline(patch: NotePatch, target: NoteDraft): void {
    if ('title' in patch) this.baseline.title = target.title;
    if ('body' in patch) this.baseline.body = target.body;
    if ('tags' in patch) this.baseline.tags = [...target.tags];
    if ('pinned' in patch) this.baseline.pinned = target.pinned;
  }

  /** Continue after a save: a run requested while this one was in flight waits for the debounce. */
  private afterCommit(): void {
    if (this.stopped || this.frozen || this.conflicted) return;
    if (this.pending) {
      this.pending = false;
      this.schedule();
    }
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
   * Register the page's last-pass patch hook. A setter rather than only a constructor dep: the
   * page builds the controller in `useState`, and the hook must read the editor's latest snapshot
   * from a ref that only exists after mount. The page deliberately never unregisters it, so the
   * unmount flush still verifies the body.
   */
  setPreparePatch(hook: PreparePatch | undefined): void {
    this.prepareHook = hook;
  }

  /** Whether a 409 is waiting for the user's choice. */
  isConflicted(): boolean {
    return this.conflicted;
  }

  /** Whether the censor freeze is active. */
  isFrozen(): boolean {
    return this.frozen;
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

  /** Apply the page's last-pass hook and normalise its verdict. */
  private prepare(patch: NotePatch | null): PreparedNotePatch {
    if (patch === null) return { patch: null, bodyUnsafe: false };
    const prepare = this.prepareHook ?? this.deps.preparePatch;
    if (!prepare) return { patch, bodyUnsafe: false };
    let result: NotePatch | PreparedNotePatch | null;
    try {
      result = prepare(patch);
    } catch {
      // A verification failure must never lose the edit: send the patch as it stands.
      return { patch, bodyUnsafe: false };
    }
    if (result === null) return { patch: null, bodyUnsafe: false };
    if ('patch' in result) {
      const bodyUnsafe = result.bodyUnsafe === true;
      let next = result.patch;
      if (bodyUnsafe && next && 'body' in next) {
        const { body: _body, ...rest } = next;
        void _body;
        next = Object.keys(rest).length ? rest : null;
      }
      return { patch: next, bodyUnsafe };
    }
    return { patch: result, bodyUnsafe: false };
  }

  /**
   * What a `pagehide` keepalive must send. It always carries the revision premise; while the censor
   * freeze is active it sends nothing at all.
   */
  keepaliveRequest(): { patch: NotePatch; expectedUpdatedAt: string } | null {
    if (this.stopped || this.frozen) return null;
    const prepared = this.prepare(diffNotePatch(this.baseline, this.draft));
    if (prepared.patch === null) return null;
    return { patch: prepared.patch, expectedUpdatedAt: this.baseRevisionValue };
  }

  /**
   * Save pending edits now and resolve once every change is acknowledged. `true` means the server
   * has the latest draft; `false` means a save failed (the draft is kept), the note is gone, a
   * revision conflict needs the user, or the censor freeze is active. A conflict is never retried
   * in a loop.
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
      if (this.frozen) return !this.isDirty();
      if (diffNotePatch(this.baseline, this.draft) === null) return true;
      if (!(await this.commit(true))) return false;
    }
  }

  /**
   * Freeze autosave for every field before the censor password prompt. Cancels a pending debounce
   * and prevents flushes and keepalives; an already-sent request cannot be recalled.
   */
  freeze(): void {
    this.frozen = true;
    this.pending = false;
    this.clearTimer();
  }

  /**
   * Cancelling a censor resumes normal autosave with the draft exactly as it was before the freeze
   * (the plaintext was already part of it). The direct censor save uses its own path instead.
   */
  unfreeze(): void {
    this.frozen = false;
    if (this.stopped || this.conflicted) return;
    this.schedule();
  }

  /**
   * The one censor PATCH: the verified token body, sent directly with the last acknowledged
   * revision as its premise. On success the baseline/revision come from the answer and the freeze
   * is released; on 409 the queue stays frozen for the conflict banner; on a network error the
   * request is kept so a retry uses the SAME body and premise.
   */
  async saveCensoredBody(body: string): Promise<CensorSaveResult> {
    if (this.stopped) return 'error';
    this.clearTimer();
    // Never let the pre-censor plaintext remain the draft that unfreeze would schedule.
    this.draft.body = body;
    await this.waitForIdle();
    if (this.pendingCensorSave === null) {
      this.pendingCensorSave = { body, expectedUpdatedAt: this.baseRevisionValue };
    }
    return this.commitCensored();
  }

  /** Retry a failed censor save with the same token body and the same revision premise. */
  async retryCensoredSave(): Promise<CensorSaveResult> {
    if (this.stopped || this.pendingCensorSave === null) return 'error';
    await this.waitForIdle();
    return this.commitCensored();
  }

  private async commitCensored(): Promise<CensorSaveResult> {
    const request = this.pendingCensorSave;
    if (request === null) return 'error';
    this.saving = true;
    this.deps.onStatus('saving');
    try {
      const revision = await this.deps.save({ body: request.body }, request.expectedUpdatedAt);
      this.baseRevisionValue = revision;
      this.baseline.body = request.body;
      this.draft.body = request.body;
      this.pendingCensorSave = null;
      this.conflicted = false;
      this.frozen = false;
      this.deps.onStatus('saved');
      return 'saved';
    } catch (err) {
      if (isStaleRevisionError(err)) {
        this.conflicted = true;
        this.deps.onStatus('conflict');
        this.deps.onConflict?.(err);
        this.conflictListener?.();
        return 'conflict';
      }
      this.deps.onStatus('error');
      this.deps.onError?.(err);
      return isNoteGoneError(err) ? 'gone' : 'error';
    } finally {
      this.saving = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
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
    const kept = await this.commit(false, true);
    if (kept) {
      this.pendingCensorSave = null;
      this.frozen = false;
    }
    return kept;
  }

  /** Reconcile with a fresh server snapshot (adopting the remote note after a conflict). */
  reset(snapshot: NoteDraft, revision: string): void {
    this.clearTimer();
    this.stopped = false;
    this.conflicted = false;
    this.saving = false;
    this.pending = false;
    this.frozen = false;
    this.pendingCensorSave = null;
    this.baseRevisionValue = revision;
    this.baseline = clone(snapshot);
    this.draft = clone(snapshot);
  }

  /** A 404: stop autosaving altogether (the draft stays on screen). */
  stop(): void {
    this.stopped = true;
    this.frozen = false;
    this.pendingCensorSave = null;
    this.clearTimer();
    this.pending = false;
  }
}
