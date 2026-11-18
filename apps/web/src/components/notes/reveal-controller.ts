import type { RevealAnchor } from './callbacks.js';
import type { RevealState } from './RevealOverlay.js';

type Subscriber = (state: RevealState | null) => void;

/**
 * Review fix (Reveal lifecycle): the PAGE owns the overlay's lifecycle. A monotonically increasing
 * request id invalidates any unlock still in flight when the overlay is closed, the note is locked,
 * the page is hidden, or the note changes — so a late reveal result is discarded and never mounted.
 * Unlocking itself is delegated to the injected function (the CensorFlow), which is only ever
 * triggered by an explicit Reveal action.
 *
 * This is a plain class (no React) so the stale-result rules can be unit-tested headlessly.
 */
export class RevealController {
  private seq = 0;
  private state: RevealState | null = null;
  private readonly listeners = new Set<Subscriber>();

  constructor(private readonly unlock: (token: string) => Promise<string | null>) {}

  subscribe(fn: Subscriber): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  get current(): RevealState | null {
    return this.state;
  }

  private set(state: RevealState | null): void {
    this.state = state;
    for (const fn of this.listeners) fn(state);
  }

  /** Explicit Reveal action: fire-and-forget, plaintext is delivered via subscribe(). */
  async request(token: string, anchor: RevealAnchor): Promise<void> {
    const id = ++this.seq;
    this.set(null); // close any existing overlay first
    let plaintext: string | null;
    try {
      plaintext = await this.unlock(token);
    } catch {
      return;
    }
    if (plaintext == null) return;
    // Closed / locked / pagehidden / note-changed while unlocking: discard the late result.
    if (this.seq !== id) return;
    this.set({ plaintext, anchor });
  }

  /** Close and invalidate anything still in flight. */
  close(): void {
    this.seq++;
    this.set(null);
  }
}
