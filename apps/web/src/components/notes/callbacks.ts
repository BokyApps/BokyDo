import type { Editor } from '@tiptap/core';

/** Viewport-relative rectangle of the censored trigger, used to position the reveal overlay. */
export interface RevealAnchor {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The subset of NoteEditorProps that NodeViews and editor props need at runtime. */
export interface NoteCallbacks {
  onUploadFile:
    ((file: File) => Promise<{ id: string; filename: string; contentType: string }>) | undefined;
  onOpenInternal: ((kind: 'note' | 'task', id: string) => void) | undefined;
  searchNotes: ((q: string) => Promise<{ id: string; title: string }[]>) | undefined;
  searchTasks: ((q: string) => Promise<{ id: string; content: string }[]>) | undefined;
  onCensor: ((plaintextMarkdown: string) => Promise<string | null>) | undefined;
  /** CONTRACT CHANGE (review): Reveal is fire-and-forget. It never returns plaintext to the
   *  editor — the page unlocks and shows a portal overlay outside the editor root. */
  onReveal: ((token: string, anchor: RevealAnchor) => void) | undefined;
  onUncensor: ((token: string) => Promise<string | null>) | undefined;
  /** Called when a Cut is refused because the selection contains a censored node. */
  onProtectedCut: (() => void) | undefined;
  /** The editor's own verdict after a censor attempt (used to end the body pause on abort). */
  onCensorSettled: ((outcome: CensorSettledOutcome) => void) | undefined;
  /** A Remove-censor result could not be applied (the atom moved, was deleted or duplicated). */
  onRemoveCensorFailed: ((reason: RemoveCensorFailure) => void) | undefined;
}

export type CensorSettledOutcome = 'ok' | 'cancelled' | 'aborted' | 'unsupported';
export type RemoveCensorFailure = 'missing' | 'duplicate' | 'mismatch';

/**
 * A saved-form snapshot produced by the lazy editor chunk. `verified()` re-parses the Markdown and
 * falls back to a fresh serialisation when source preservation changed structure (H4); it is a
 * closure over the editor document, so the page never imports markdown-it.
 */
export interface SerializedNoteBody {
  markdown: string;
  verified(): string;
}

export const EMPTY_CALLBACKS: NoteCallbacks = {
  onUploadFile: undefined,
  onOpenInternal: undefined,
  searchNotes: undefined,
  searchTasks: undefined,
  onCensor: undefined,
  onReveal: undefined,
  onUncensor: undefined,
  onProtectedCut: undefined,
  onCensorSettled: undefined,
  onRemoveCensorFailed: undefined,
};

interface CallbacksRef {
  current: NoteCallbacks;
}

/**
 * TipTap React NodeViews render in their own React roots, so React context from the editor's
 * parent tree does not reach them. A module-level WeakMap keyed by the Editor instance is the
 * robust bridge: the component registers a stable ref object once, and every NodeView reads
 * `ref.current` at interaction time, so callback props are always up to date without recreating
 * the editor. The WeakMap lets the editor/NodeViews be garbage collected together.
 */
const registry = new WeakMap<Editor, CallbacksRef>();

export function registerCallbacks(editor: Editor, ref: CallbacksRef): void {
  registry.set(editor, ref);
}

export function getCallbacks(editor: Editor): NoteCallbacks {
  return registry.get(editor)?.current ?? EMPTY_CALLBACKS;
}
