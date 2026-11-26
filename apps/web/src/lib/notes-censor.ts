import {
  censorLockGeneration,
  lockCensored,
  onCensorLock,
  type LockReason,
} from './censor-lock.js';
import { CensorError, censor, censorKeys, uncensor } from './censor.js';
import { censorTokensIn } from './notes.js';

export { censorLockGeneration, lockCensored, onCensorLock };
export type { LockReason };

/**
 * The UI state machine behind the editor's three censor callbacks (ADR 0025 "Censoring" and its
 * post-review unlock rules). Crypto lives in ./censor.js; the only thing injected here is the
 * password/confirmation UI, so the whole flow is unit-testable by mocking that module.
 *
 * Invariants enforced here:
 *  - Unlocking is only ever triggered by an explicit Reveal/Remove action. Rendering a note never
 *    calls tryUnlock or uncensor; only the three methods below do.
 *  - Concurrent unlock requests for one token are merged (<= 1 in flight per token).
 *  - The "cannot be recovered" warning is shown once per session, before the first censor.
 *  - Remove censor asks for confirmation first.
 *  - A lock/clear while unlocking is treated as "locked -> close silently", never an error.
 *  - Every flow captures the lock generation BEFORE its first await (Remove before the
 *    confirmation dialog), so a lock during a prompt can never deliver a plaintext result.
 */

const BAD_PASSWORD = 'Wrong password. Try again.';
const MESSAGES: Record<string, string> = {
  empty_text: 'There is no text to censor.',
  too_large: 'The selected text is too large to censor.',
  empty_password: 'Enter a password.',
  bad_password: BAD_PASSWORD,
};

export interface PasswordPromptOptions {
  /** Censoring asks for a second (confirmation) field; revealing does not. */
  confirm: boolean;
  /** Show the unrecoverable-password warning (first censor of the session). */
  warning: boolean;
  /** An error to show above the fields (bad password, empty, too large). */
  error: string | null;
}

export interface CensorPrompts {
  askPassword(opts: PasswordPromptOptions): Promise<string | null>;
  confirmRemove(): Promise<boolean>;
}

export interface CensorSession {
  warned: boolean;
}

/** Shared across every note in the tab: the warning is a once-per-session message. */
const defaultSession: CensorSession = { warned: false };

// ---------------------------------------------------------------------------------------------
// Password prompts: one at a time; a new prompt supersedes (resolves as cancelled) the old one.
// ---------------------------------------------------------------------------------------------

export interface PasswordPromptRequest {
  id: number;
  promise: Promise<string | null>;
}

/**
 * Serialises password prompts. A Reveal and a Remove can both want a password (or a second
 * Reveal can arrive while the first dialog is open); showing two dialogs used to overwrite the
 * single stored resolver and hang the first operation. Newest wins: the earlier prompt resolves
 * `null` (cancelled), which every flow already treats as "nothing happened".
 */
export class PasswordPromptQueue {
  private seq = 0;
  private active: { id: number; resolve: (value: string | null) => void } | null = null;

  ask(): PasswordPromptRequest {
    this.active?.resolve(null);
    this.active = null;
    let resolve!: (value: string | null) => void;
    const promise = new Promise<string | null>((r) => {
      resolve = r;
    });
    const id = ++this.seq;
    this.active = { id, resolve };
    return { id, promise };
  }

  /** Settle the prompt if it is still the active one; returns whether it was. */
  settle(id: number, value: string | null): boolean {
    if (this.active?.id !== id) return false;
    const { resolve } = this.active;
    this.active = null;
    resolve(value);
    return true;
  }

  /** Resolve the active prompt as cancelled (lock, unmount). */
  cancelAll(): void {
    const active = this.active;
    this.active = null;
    active?.resolve(null);
  }

  get activeId(): number | null {
    return this.active?.id ?? null;
  }
}

function messageFor(err: unknown): string | null {
  return err instanceof CensorError ? (MESSAGES[err.code] ?? null) : null;
}

// ---------------------------------------------------------------------------------------------
// "Did my last censor save?" marker (MED 2c). A censor produces its token in the browser and the
// save that follows can lose a race with a closed tab. The marker holds a SHA-256 digest of the
// token — never the token's plaintext, never the password — so opening the note later can tell
// whether the censored span actually reached the server.
// ---------------------------------------------------------------------------------------------

const MARKER_PREFIX = 'bokydo:note-censor-pending:';

export interface PendingCensorMarker {
  noteId: string;
  /** SHA-256 hex of the whole token. */
  tokenDigest: string;
}

/** SHA-256 hex of a censor token. Only the digest is ever persisted. */
export async function censorTokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** sessionStorage can be unavailable (privacy modes, SSR/tests); the censor must still work. */
function markerStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readPendingCensor(noteId: string): PendingCensorMarker | null {
  const store = markerStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(`${MARKER_PREFIX}${noteId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingCensorMarker>;
    if (parsed.noteId !== noteId || typeof parsed.tokenDigest !== 'string') return null;
    return { noteId, tokenDigest: parsed.tokenDigest };
  } catch {
    return null;
  }
}

export function clearPendingCensor(noteId: string): void {
  try {
    markerStorage()?.removeItem(`${MARKER_PREFIX}${noteId}`);
  } catch {
    // Storage is unavailable; nothing to clear.
  }
}

/**
 * Remember the token this tab just produced, synchronously with respect to the save: the page
 * awaits this before it hands the token document to the editor, so the marker exists before the
 * first PATCH that carries the token can race a tab close.
 */
export async function markPendingCensor(noteId: string, token: string): Promise<void> {
  const store = markerStorage();
  if (!store) return;
  try {
    const marker: PendingCensorMarker = { noteId, tokenDigest: await censorTokenDigest(token) };
    store.setItem(`${MARKER_PREFIX}${noteId}`, JSON.stringify(marker));
  } catch {
    // Digesting or writing failed; the save is still attempted and the worst case is no marker.
  }
}

async function bodyHasToken(body: string, digest: string): Promise<boolean> {
  try {
    for (const token of censorTokensIn(body)) {
      if ((await censorTokenDigest(token)) === digest) return true;
    }
  } catch {
    // WebCrypto unavailable: assume the token is missing, so the user is asked to check.
  }
  return false;
}

/**
 * A PATCH was acknowledged: clear the marker only when the saved body carries the exact token.
 * An older save answering after the censor revision was queued must not clear it.
 */
export async function acknowledgePendingCensor(noteId: string, body: string): Promise<boolean> {
  const marker = readPendingCensor(noteId);
  if (!marker) return false;
  if (!(await bodyHasToken(body, marker.tokenDigest))) return false;
  clearPendingCensor(noteId);
  return true;
}

export type PendingCensorState = 'none' | 'saved' | 'missing';

/**
 * When a note is opened: is the token this tab censored present in the server's body? The marker
 * is cleared either way — `saved` means the acknowledgement was simply lost, `missing` means the
 * censor may never have reached the server.
 */
export async function checkPendingCensor(
  noteId: string,
  body: string,
): Promise<PendingCensorState> {
  const marker = readPendingCensor(noteId);
  if (!marker) return 'none';
  const saved = await bodyHasToken(body, marker.tokenDigest);
  clearPendingCensor(noteId);
  return saved ? 'saved' : 'missing';
}

export class CensorFlow {
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly prompts: CensorPrompts,
    private readonly session: CensorSession = defaultSession,
  ) {}

  /** Censor a selection: warn once, ask for a password (+ confirm), return the token or null. */
  async onCensor(plaintext: string): Promise<string | null> {
    const generation = censorLockGeneration();
    let warning = !this.session.warned;
    this.session.warned = true;
    let error: string | null = null;
    for (;;) {
      // M2: check before EVERY prompt, including the retry after a rejected encryption.
      if (censorLockGeneration() !== generation) return null;
      const password = await this.prompts.askPassword({ confirm: true, warning, error });
      // Locked while the prompt was open: close silently, reveal nothing, encrypt nothing.
      if (censorLockGeneration() !== generation) return null;
      warning = false; // the warning is shown once, even across error retries
      if (password === null) return null;
      try {
        const token = await censor(plaintext, password);
        return censorLockGeneration() === generation ? token : null;
      } catch (err) {
        const message = messageFor(err);
        if (message === null) throw err;
        // A lock while encrypting voids the operation; never reopen the prompt afterwards.
        if (censorLockGeneration() !== generation) return null;
        error = message; // empty_text / too_large / empty_password -> re-prompt with a message
      }
    }
  }

  /** Reveal: explicit action only. */
  onReveal(token: string): Promise<string | null> {
    return this.unlock(token);
  }

  /** Remove censor: confirm first, then the same explicit unlock flow. */
  async onUncensor(token: string): Promise<string | null> {
    const generation = censorLockGeneration();
    if (!(await this.prompts.confirmRemove())) return null;
    // A lock while the confirmation dialog was open voids the whole operation.
    if (censorLockGeneration() !== generation) return null;
    return this.unlock(token);
  }

  /** Merge concurrent requests for the same token. */
  private unlock(token: string): Promise<string | null> {
    const existing = this.inFlight.get(token);
    if (existing) return existing;
    const run = this.runUnlock(token).finally(() => {
      if (this.inFlight.get(token) === run) this.inFlight.delete(token);
    });
    this.inFlight.set(token, run);
    return run;
  }

  private async runUnlock(token: string): Promise<string | null> {
    const generation = censorKeys.generation;
    const lock = censorLockGeneration();
    // tryUnlock tries a cached key or up to three remembered passwords, never on render.
    const cached = await censorKeys.tryUnlock(token);
    if (lock !== censorLockGeneration()) return null;
    if (cached !== null) return cached;
    // Cleared (locked) while deriving: close silently rather than asking for a password.
    if (censorKeys.generation !== generation) return null;
    return this.promptAndDecrypt(token, generation, lock);
  }

  private async promptAndDecrypt(
    token: string,
    generation: number,
    lock: number,
  ): Promise<string | null> {
    let error: string | null = null;
    for (;;) {
      // M2: every iteration re-checks the lock (a bad-password retry used to reopen the prompt
      // after the tab was hidden and the cache cleared).
      if (lock !== censorLockGeneration() || censorKeys.generation !== generation) return null;
      const password = await this.prompts.askPassword({ confirm: false, warning: false, error });
      if (lock !== censorLockGeneration()) return null;
      if (password === null) return null;
      try {
        const plaintext = await uncensor(token, password, censorKeys);
        if (lock !== censorLockGeneration()) return null; // locked while deriving
        if (censorKeys.generation !== generation) return null; // cache cleared while deriving
        return plaintext;
      } catch (err) {
        if (err instanceof CensorError) {
          if (err.code === 'locked') return null; // close silently
          // A lock/cache clear while deriving settles the whole flow as cancelled: the next
          // iteration's prompt must not appear after "Lock" or a hidden tab.
          if (lock !== censorLockGeneration() || censorKeys.generation !== generation) return null;
          if (err.code === 'bad_password') {
            error = BAD_PASSWORD;
            continue; // show the error in the dialog and re-prompt
          }
          return null; // malformed / anything else: close silently
        }
        throw err;
      }
    }
  }
}
