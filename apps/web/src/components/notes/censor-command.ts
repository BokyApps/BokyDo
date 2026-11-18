import type { Editor, JSONContent } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { contentToMarkdown, docToMarkdown, markdownToDoc, markdownToInline } from './markdown.js';

/**
 * Censor commands for the editor (ADR 0025 "Censoring"). Review-round-2 rules:
 *
 *  - Only a selection inside one textblock that can hold inline atoms is censored. A code block,
 *    embed, atom, or a range across blocks is rejected BEFORE the password prompt: a token there
 *    could not survive a reload as an atom (a code block would save it as plain text).
 *  - After building the replacement document it is serialised and parsed again; the censored atom
 *    must come back with the identical token at the corresponding position, otherwise nothing is
 *    changed at all.
 *  - The replacement transaction is dispatched and then the editor state is rebuilt with fresh
 *    history, so no undo/redo step ever holds the plaintext. onChange only sees the token document.
 *  - Remove is bound to the ORIGINAL atom by a transient `removeId` attribute (mapped through
 *    transactions with the node). If that atom was deleted, Remove aborts instead of applying the
 *    plaintext to an identical token elsewhere.
 */

export type CensorOutcome = 'ok' | 'cancelled' | 'aborted' | 'unsupported';

const CENSOR_TEXTBLOCKS = new Set(['paragraph', 'heading']);
const ALLOWED_INLINE = new Set(['text', 'hardBreak']);
/** Containers whose paragraphs are ordinary editable text. */
const ALLOWED_CONTAINERS = new Set([
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
]);

/**
 * Whether a selection can be replaced by a censored atom and still survive a save. The selection
 * must sit in exactly one paragraph or heading (including paragraphs in list items, table cells
 * and blockquotes) and must not touch an atom, a code block, an embed or a block boundary.
 */
export function censorableSelection(editor: Editor, from: number, to: number): boolean {
  const { doc } = editor.state;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) return false;
  if (from < 0 || to > doc.content.size) return false;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if (!$from.parent.isTextblock || !CENSOR_TEXTBLOCKS.has($from.parent.type.name)) return false;
  if (!$from.sameParent($to)) return false;
  let ok = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) return true;
    if (node === $from.parent || ALLOWED_CONTAINERS.has(node.type.name)) return true;
    if (node.isInline) {
      if (ALLOWED_INLINE.has(node.type.name)) return true;
      ok = false;
      return false;
    }
    ok = false;
    return false;
  });
  return ok;
}

/** Every censored atom as `<top-level block>|<parent node>|<token>`, in document order. */
export function censoredPlacements(doc: JSONContent): string[] {
  const out: string[] = [];
  const walk = (node: JSONContent, blockIndex: number): void => {
    for (const child of node.content ?? []) {
      if (child.type === 'censored') {
        out.push(`${blockIndex}|${node.type}|${String(child.attrs?.token ?? '')}`);
      }
      walk(child, blockIndex);
    }
  };
  (doc.content ?? []).forEach((block, index) => walk(block, index));
  return out;
}

/**
 * Serialise the prospective document and parse it again: the censored atom must be present with
 * the identical token, in the same order and place among the other censored atoms. Anything else
 * (e.g. a token that the serialiser can only write as literal text) aborts the whole operation.
 */
export function censorRoundTripSurvives(editor: Editor, nextDoc: PMNode, token: string): boolean {
  const intermediate = nextDoc.toJSON() as JSONContent;
  const expected = censoredPlacements(intermediate);
  if (expected.length === 0) return false;
  if (expected.filter((placement) => placement.endsWith(`|${token}`)).length !== 1) return false;
  let reparsed: JSONContent;
  try {
    reparsed = markdownToDoc(docToMarkdown(intermediate));
  } catch {
    return false;
  }
  const actual = censoredPlacements(reparsed);
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) if (expected[i] !== actual[i]) return false;
  try {
    // The atom must sit in a structure the editor can load again, not merely exist as text.
    editor.schema.nodeFromJSON(reparsed).check();
    return true;
  } catch {
    return false;
  }
}

function buildCensoredTransaction(editor: Editor, from: number, to: number, token: string) {
  const type = editor.schema.nodes.censored;
  if (!type) throw new Error('the notes schema has no censored node');
  return editor.state.tr.replaceWith(from, to, type.create({ token }));
}

/**
 * Dispatch a replacement transaction and rebuild the state with fresh history: undo/redo can no
 * longer step back to the plaintext selection.
 */
function dispatchWithoutHistory(editor: Editor, tr: Transaction): void {
  editor.view.dispatch(tr);
  const state = editor.state;
  const fresh = EditorState.create({
    doc: state.doc,
    plugins: state.plugins,
    selection: state.selection,
  });
  editor.view.updateState(fresh);
}

/** Apply the censored atom and wipe undo history so plaintext can never be restored. */
export function commitCensored(editor: Editor, from: number, to: number, token: string): void {
  dispatchWithoutHistory(editor, buildCensoredTransaction(editor, from, to, token));
}

/** Restore editability only while the editor still exists (a lock may have remounted it). */
function restoreEditable(editor: Editor, editable: boolean): void {
  if (!editor.isDestroyed) editor.setEditable(editable, false);
}

export async function censorSelection(
  editor: Editor,
  from: number,
  to: number,
  onCensor: (markdown: string) => Promise<string | null>,
): Promise<CensorOutcome> {
  if (editor.isDestroyed || !editor.isEditable) return 'aborted';
  if (!censorableSelection(editor, from, to)) return 'unsupported';
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
    restoreEditable(editor, wasEditable);
    throw err;
  }
  if (editor.isDestroyed) return 'aborted';
  if (!token) {
    restoreEditable(editor, wasEditable);
    return 'cancelled';
  }
  // Edit during the prompt: stale offsets must not be used — abort with no change.
  if (!editor.state.doc.eq(startDoc)) {
    restoreEditable(editor, wasEditable);
    return 'aborted';
  }
  try {
    const tr = buildCensoredTransaction(editor, from, to, token);
    // Verify the saved form BEFORE dispatching anything: a token that cannot survive a reload is
    // not reported as success.
    if (!censorRoundTripSurvives(editor, tr.doc, token)) return 'unsupported';
    dispatchWithoutHistory(editor, tr);
    return 'ok';
  } finally {
    restoreEditable(editor, wasEditable);
  }
}

// ---------------------------------------------------------------------------------------------
// Remove censor: bound to the exact atom the user confirmed
// ---------------------------------------------------------------------------------------------

function removalMark(editor: Editor, pos: number): string | null {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'censored') return null;
  const removeId = `rm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, removeId });
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
  return removeId;
}

/** Tag one atom as the target of a Remove operation; returns the transient id or null. */
export function markCensoredForRemoval(editor: Editor, pos: number): string | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  return removalMark(editor, pos);
}

/** Drop a removal tag (cancelled prompt / failed verification); the atom itself is untouched. */
export function clearRemovalMark(editor: Editor, removeId: string): void {
  if (editor.isDestroyed) return;
  const pos = findRemovalTarget(editor.state.doc, removeId);
  if (!pos) return;
  const node = editor.state.doc.nodeAt(pos.from);
  if (!node) return;
  const tr = editor.state.tr.setNodeMarkup(pos.from, undefined, { ...node.attrs, removeId: null });
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}

/** The position of the atom carrying `removeId`, or null if that exact atom is gone. */
export function findRemovalTarget(
  doc: PMNode,
  removeId: string,
): { from: number; to: number } | null {
  if (!removeId) return null;
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'censored' && node.attrs.removeId === removeId) {
      found = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Apply a Remove-censor result to the atom that was tagged for removal. Aborts (returns false and
 * changes nothing) if that atom was deleted or replaced — an identical token elsewhere is never
 * used instead. History is intentionally kept, so undo restores the token.
 */
export function applyUncensored(editor: Editor, removeId: string, plaintext: string): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const target = findRemovalTarget(editor.state.doc, removeId);
  if (!target) return false;
  const inline = markdownToInline(plaintext);
  const nodes = inline.map((node) => editor.schema.nodeFromJSON(node));
  const tr = editor.state.tr;
  if (nodes.length === 0) tr.delete(target.from, target.to);
  else tr.replaceWith(target.from, target.to, Fragment.fromArray(nodes));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
