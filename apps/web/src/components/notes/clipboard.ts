import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { CENSORED_PLACEHOLDER } from './markdown.js';

/**
 * Clipboard guards for censored spans (ADR 0025: "copying, the Markdown view … never [reveal]
 * cleartext"). The cleartext is never part of the document in the first place, but these two
 * functions guarantee that *both* text/plain and text/html carry only `█████`, even while a
 * reveal overlay is on screen.
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
 * serializer runs, so no token (let alone cleartext) is ever written to the HTML clipboard.
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
  return new Slice(mapFragment(slice.content), slice.openStart, slice.openEnd);
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
 */
export interface DragCopyController {
  markDragStart(): void;
  markDragEnd(): void;
  readonly dragging: boolean;
  transformCopied(slice: Slice, schema: Schema): Slice;
}

export function createDragCopyController(): DragCopyController {
  let dragging = false;
  return {
    markDragStart() {
      dragging = true;
    },
    markDragEnd() {
      dragging = false;
    },
    get dragging() {
      return dragging;
    },
    transformCopied(slice: Slice, schema: Schema): Slice {
      // Always the placeholder. `view.dragging.slice` (ProseMirror's in-memory drag slice) is not
      // derived from this return value, so an internal drop still inserts the real token.
      return censorSlice(slice, schema);
    },
  };
}
