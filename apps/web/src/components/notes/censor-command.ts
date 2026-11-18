import type { Editor, JSONContent } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { contentToMarkdown, markdownToInline } from './markdown.js';

/**
 * Review fixes for the censor command:
 *  - While the password prompt is open the editor is made non-editable and the start document and
 *    selection are recorded. If anything changed the doc while the prompt was open, we abort, so a
 *    late result can never replace the wrong text and leave the secret in place.
 *  - Replacing the selection with the censored atom rebuilds the EditorState with fresh history,
 *    so no undo/redo step ever holds the plaintext. onChange only ever sees the token document.
 */

export type CensorOutcome = 'ok' | 'cancelled' | 'aborted';

/** Apply the censored atom and wipe undo history so plaintext can never be restored. */
export function commitCensored(editor: Editor, from: number, to: number, token: string): void {
  editor.chain().insertContentAt({ from, to }, { type: 'censored', attrs: { token } }).run();
  // The replacement transaction fired onUpdate -> onChange with the *token* document (never
  // plaintext). Rebuild with a fresh state so the history plugin starts empty: undo/redo can no
  // longer step back to the plaintext selection.
  const state = editor.state;
  const fresh = EditorState.create({
    doc: state.doc,
    plugins: state.plugins,
    selection: state.selection,
  });
  editor.view.updateState(fresh);
}

export async function censorSelection(
  editor: Editor,
  from: number,
  to: number,
  onCensor: (markdown: string) => Promise<string | null>,
): Promise<CensorOutcome> {
  if (!editor.isEditable) return 'aborted';
  const startDoc = editor.state.doc;
  const slice = startDoc.slice(from, to);
  const markdown = contentToMarkdown(slice.content.toJSON() as JSONContent[]);
  const wasEditable = editor.isEditable;
  // Block editing while the (async) password prompt is open. `emitUpdate=false` avoids a spurious
  // onChange carrying the still-plaintext document.
  editor.setEditable(false, false);
  let token: string | null;
  try {
    token = await onCensor(markdown);
  } catch (err) {
    editor.setEditable(wasEditable, false);
    throw err;
  }
  if (!token) {
    editor.setEditable(wasEditable, false);
    return 'cancelled';
  }
  // Edit during the prompt: stale offsets must not be used — abort with no change.
  if (!editor.state.doc.eq(startDoc)) {
    editor.setEditable(wasEditable, false);
    return 'aborted';
  }
  try {
    commitCensored(editor, from, to, token);
    return 'ok';
  } finally {
    editor.setEditable(wasEditable, false);
  }
}

/**
 * Re-find a censored node by its exact token in the *current* document (review: Remove censor must
 * not apply a late result at a stale position whose token has changed). Returns null unless there
 * is exactly one match, so a moved/deleted/duplicated token aborts the operation.
 */
export function findCensoredNode(doc: PMNode, token: string): { from: number; to: number } | null {
  const matches: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'censored' && node.attrs.token === token) {
      matches.push({ from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ?? null;
}

/**
 * Apply a Remove-censor result. Requires an editable editor and re-finds the exact token in the
 * *current* document; aborts (returns false, changes nothing) if it was moved/edited/deleted or is
 * now ambiguous. History is intentionally kept, so undo restores the token.
 */
export function applyUncensored(editor: Editor, token: string, plaintext: string): boolean {
  if (!editor.isEditable) return false;
  const found = findCensoredNode(editor.state.doc, token);
  if (!found) return false;
  const inline = markdownToInline(plaintext);
  if (inline.length === 0) {
    editor.chain().focus().deleteRange({ from: found.from, to: found.to }).run();
  } else {
    editor.chain().focus().insertContentAt({ from: found.from, to: found.to }, inline).run();
  }
  return true;
}
