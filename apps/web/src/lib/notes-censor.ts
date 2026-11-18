import { CensorError, censor, censorKeys, uncensor } from './censor.js';

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
// Lock signal: Lock / pagehide clear the key cache and also close any open password dialog and
// reveal overlay. Sign-out clears the cache directly in AppShell (the app unmounts there).
// ---------------------------------------------------------------------------------------------

const lockListeners = new Set<() => void>();

export function onCensorLock(fn: () => void): () => void {
  lockListeners.add(fn);
  return () => {
    lockListeners.delete(fn);
  };
}

export function lockCensors(): void {
  censorKeys.clear();
  for (const fn of lockListeners) fn();
}

function messageFor(err: unknown): string | null {
  return err instanceof CensorError ? (MESSAGES[err.code] ?? null) : null;
}

export class CensorFlow {
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly prompts: CensorPrompts,
    private readonly session: CensorSession = defaultSession,
  ) {}

  /** Censor a selection: warn once, ask for a password (+ confirm), return the token or null. */
  async onCensor(plaintext: string): Promise<string | null> {
    let warning = !this.session.warned;
    this.session.warned = true;
    let error: string | null = null;
    for (;;) {
      const password = await this.prompts.askPassword({ confirm: true, warning, error });
      warning = false; // the warning is shown once, even across error retries
      if (password === null) return null;
      try {
        return await censor(plaintext, password);
      } catch (err) {
        const message = messageFor(err);
        if (message === null) throw err;
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
    if (!(await this.prompts.confirmRemove())) return null;
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
    // tryUnlock tries a cached key or up to three remembered passwords, never on render.
    const cached = await censorKeys.tryUnlock(token);
    if (cached !== null) return cached;
    // Cleared (locked) while deriving: close silently rather than asking for a password.
    if (censorKeys.generation !== generation) return null;
    return this.promptAndDecrypt(token, generation);
  }

  private async promptAndDecrypt(token: string, generation: number): Promise<string | null> {
    let error: string | null = null;
    for (;;) {
      const password = await this.prompts.askPassword({ confirm: false, warning: false, error });
      if (password === null) return null;
      try {
        const plaintext = await uncensor(token, password, censorKeys);
        if (censorKeys.generation !== generation) return null; // locked while deriving
        return plaintext;
      } catch (err) {
        if (err instanceof CensorError) {
          if (err.code === 'locked') return null; // close silently
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
