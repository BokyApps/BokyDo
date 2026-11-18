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
