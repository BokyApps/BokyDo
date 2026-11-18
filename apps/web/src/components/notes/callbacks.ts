import type { Editor } from '@tiptap/core';

/** The subset of NoteEditorProps that NodeViews and editor props need at runtime. */
export interface NoteCallbacks {
  onUploadFile:
    ((file: File) => Promise<{ id: string; filename: string; contentType: string }>) | undefined;
  onOpenInternal: ((kind: 'note' | 'task', id: string) => void) | undefined;
  searchNotes: ((q: string) => Promise<{ id: string; title: string }[]>) | undefined;
  searchTasks: ((q: string) => Promise<{ id: string; content: string }[]>) | undefined;
  onCensor: ((plaintextMarkdown: string) => Promise<string | null>) | undefined;
  onReveal: ((token: string) => Promise<string | null>) | undefined;
  onUncensor: ((token: string) => Promise<string | null>) | undefined;
}

export const EMPTY_CALLBACKS: NoteCallbacks = {
  onUploadFile: undefined,
  onOpenInternal: undefined,
  searchNotes: undefined,
  searchTasks: undefined,
  onCensor: undefined,
  onReveal: undefined,
  onUncensor: undefined,
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
