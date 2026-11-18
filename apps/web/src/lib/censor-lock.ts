import { censorKeys } from './censor.js';

/**
 * The single lock entry point for censored spans (review P3). It lives in its own tiny module so
 * AppShell (entry chunk) can call it without pulling the password-prompt UI or the CensorFlow into
 * the entry bundle; the notes page chunks re-export these functions from ./notes-censor.js.
 *
 * A lock clears the derived-key cache, resolves every open password prompt as cancelled (through
 * its onCensorLock subscription), closes reveal overlays and bumps the generation every flow
 * captured before its first await.
 */

export type LockReason = 'manual' | 'signout' | 'note-change' | 'unmount' | 'pagehide' | 'hidden';

let lockGeneration = 0;

/** The generation to capture before a flow's first await; it changes on every lock. */
export function censorLockGeneration(): number {
  return lockGeneration;
}

const lockListeners = new Set<(reason: LockReason) => void>();

export function onCensorLock(fn: (reason: LockReason) => void): () => void {
  lockListeners.add(fn);
  return () => {
    lockListeners.delete(fn);
  };
}

/** Lock every censored span in this tab. Idempotent and safe from any lifecycle handler. */
export function lockCensored(reason: LockReason = 'manual'): void {
  lockGeneration += 1;
  censorKeys.clear();
  // Copy: a listener may unsubscribe itself while reacting (e.g. an unmounting page).
  for (const fn of [...lockListeners]) fn(reason);
}
