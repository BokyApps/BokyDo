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
 * Review fix (drag/cut): `transformCopied` must not rewrite an internal drag's slice, or moving a
 * censored span would replace it with the `█████` placeholder. During a drag started inside the
 * editor the slice is passed through untouched (ProseMirror re-inserts the real node on an
 * in-editor drop); ordinary Copy/Cut still export only the placeholder. `dragstart`/`dragend`
 * flip the flag; a drag that leaves the editor is ended by `drop`/`dragend` as well.
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
      return dragging ? slice : censorSlice(slice, schema);
    },
  };
}
