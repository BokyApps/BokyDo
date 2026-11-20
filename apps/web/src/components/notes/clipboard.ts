import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { CENSORED_PLACEHOLDER } from './markdown.js';
import { stripPrivateAttrsFromSlice } from './source-meta.js';

/**
 * Clipboard guards for censored spans (ADR 0025: "copying, the Markdown view … never [reveal]
 * cleartext"). The cleartext is never part of the document in the first place, but these two
 * functions guarantee that *both* text/plain and text/html carry only `█████` (and no source-meta
 * attribute that might still hold the pre-censor plaintext), even while a reveal overlay is on
 * screen.
 */

/** text/plain: leaf nodes with no text (censored atoms) render as the placeholder. */
export function clipboardTextSerializer(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, '\n\n', (node: PMNode) => {
    if (node.type.name === 'censored') return CENSORED_PLACEHOLDER;
    if (node.isText) return node.text ?? '';
    if (node.type.name === 'hardBreak') return '\n';
    return '';
  });
}

/**
 * text/html: replace every censored atom with a plain `█████` text node *before* the DOM
 * serializer runs, so no token (let alone cleartext) is ever written to the HTML clipboard, and
 * drop every source-meta/transient attribute (ProseMirror copies the openStart/openEnd ancestor
 * attributes into `data-pm-slice`, and a retained `src` holds the block's pre-censor plaintext).
 */
export function censorSlice(slice: Slice, schema: Schema): Slice {
  const mapFragment = (fragment: Fragment): Fragment => {
    const out: PMNode[] = [];
    fragment.forEach((node) => {
      if (node.type.name === 'censored') {
        out.push(schema.text(CENSORED_PLACEHOLDER, node.marks));
      } else if (node.content.childCount > 0) {
        out.push(node.copy(mapFragment(node.content)));
      } else {
        out.push(node);
      }
    });
    return Fragment.fromArray(out);
  };
  const content = mapFragment(slice.content);
  return stripPrivateAttrsFromSlice(new Slice(content, slice.openStart, slice.openEnd));
}

/** Whether a slice contains a censored atom (used to refuse Cut). */
export function sliceHasCensored(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    if (node.type.name === 'censored') {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Decision behind the editor's `cut` DOM handler (unit-testable without a real browser): a cut of
 * a selection containing a censored atom is refused — the caller prevents default, notifies, and
 * does NOT delete, so the token survives. Returns whether the cut was refused.
 */
export function refuseCutIfCensored(slice: Slice, notify: () => void): boolean {
  if (!sliceHasCensored(slice)) return false;
  notify();
  return true;
}

/**
 * Review fix (outbound drag / copy): the DataTransfer must never contain a censor token, not even
 * for an internal drag. ProseMirror keeps the real slice in `view.dragging.slice` for an in-editor
 * drop and applies `transformCopied` only to the text it serialises into `text/plain` and
 * `text/html`, so always censoring the serialised copy is safe: moving an atom inside the editor
 * still moves the real node, while any drag that leaves the editor carries `█████` only.
 *
 * The controller is kept (dragstart/dragend still mark state) so the decision stays unit-testable
 * and a drag is never mistaken for an ordinary copy. `transformCopied` ignores the flag by design.
 * Review fix (N1): the slice ProseMirror actually passed to `transformCopied` during the drag is
 * captured here, so an internal drop restores exactly that slice (with its openStart/openEnd
 * node-selection metadata) instead of re-reading the selection.
 */
export interface DragCopyController {
  markDragStart(): void;
  markDragEnd(): void;
  readonly dragging: boolean;
  /** The real (un-censored) slice ProseMirror handed to transformCopied for this drag. */
  readonly originalSlice: Slice | null;
  transformCopied(slice: Slice, schema: Schema): Slice;
}

export function createDragCopyController(): DragCopyController {
  let dragging = false;
  let original: Slice | null = null;
  return {
    markDragStart() {
      dragging = true;
      original = null;
    },
    markDragEnd() {
      dragging = false;
      original = null;
    },
    get dragging() {
      return dragging;
    },
    get originalSlice() {
      return original;
    },
    transformCopied(slice: Slice, schema: Schema): Slice {
      // Capture the slice ProseMirror passed BEFORE censoring it: `view.dragging.slice` is not
      // derived from this return value, so an in-editor drop can still insert the real token.
      if (dragging && original === null) original = slice;
      return censorSlice(slice, schema);
    },
  };
}
