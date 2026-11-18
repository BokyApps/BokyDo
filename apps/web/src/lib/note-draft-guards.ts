import type { NotePatch } from '@bokydo/shared';
import { keepalivePatch } from './api.js';
import { pathFor } from './notes.js';

/**
 * Navigation guards for an edited note (review: navigation dropped drafts).
 *
 *  - `beforeunload` prompts while there is unsaved work.
 *  - `pagehide` fires a final `keepalive` PATCH with the latest patch, because the beforeunload
 *    prompt is not shown on every close (mobile, bfcache) and the response cannot be awaited.
 *  - `DraftLeaveGuard` is what TanStack Router's `useBlocker` calls: it flushes and reports
 *    whether the navigation must still be blocked (save failed -> keep the draft and offer Retry).
 *
 * Pure DOM/controller logic, so the whole flow is unit-testable with fake timers.
 */

export interface DraftSaver {
  hasUnsavedWork(): boolean;
  pendingPatch(): NotePatch | null;
  flush(): Promise<boolean>;
  stop(): void;
}

export interface DraftGuardTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** Install the tab-close / reload guards; returns their teardown. */
export function installDraftGuards(
  saver: DraftSaver,
  noteId: string,
  target: DraftGuardTarget = window,
): () => void {
  const onBeforeUnload = (event: Event) => {
    if (!saver.hasUnsavedWork()) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = '';
  };
  const onPageHide = () => {
    const patch = saver.pendingPatch();
    if (patch === null) return;
    // Also covers "still saving": the draft is newer than the last acknowledged snapshot, so
    // re-sending it is correct and idempotent.
    keepalivePatch(pathFor(noteId), patch);
  };
  target.addEventListener('beforeunload', onBeforeUnload);
  target.addEventListener('pagehide', onPageHide);
  return () => {
    target.removeEventListener('beforeunload', onBeforeUnload);
    target.removeEventListener('pagehide', onPageHide);
  };
}

/**
 * The router-blocker decision. `shouldBlock` flushes first: a successful flush lets the
 * navigation continue silently, a failed one blocks it so the draft stays visible with Retry and
 * an explicit "Discard changes and leave".
 */
export class DraftLeaveGuard {
  constructor(private readonly saver: DraftSaver) {}

  async shouldBlock(): Promise<boolean> {
    if (!this.saver.hasUnsavedWork()) return false;
    return !(await this.saver.flush());
  }

  /** Explicit discard: stop retrying and let the navigation proceed. */
  discard(): void {
    this.saver.stop();
  }
}
