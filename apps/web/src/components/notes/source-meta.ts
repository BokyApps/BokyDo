import { Extension } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';

/**
 * Review fix (silent rewrite / data loss): `markdownToDoc` attaches `attrs.src`, `attrs.sep`,
 * `attrs.lead` (the block's verbatim source and the whitespace around it) and `attrs.blockId` /
 * `attrs.prevId` / `attrs.nextId` (the neighbours the separators were measured between) to every
 * top-level block so `docToMarkdown` can emit unchanged blocks verbatim without reusing a
 * separator across a block that was inserted or deleted. ProseMirror drops unknown attributes, so
 * they must be registered here as global attributes on every block node type. They are deliberately
 * *never* rendered to HTML (`renderHTML`/`parseHTML` are inert): a `src` may contain censor tokens
 * or raw Markdown and must never leak into the DOM, the clipboard HTML, or be read back from
 * pasted HTML.
 */

/**
 * Bookkeeping written by `markdownToDoc`. Never document content; it may contain the pre-censor
 * plaintext of a block (the whole point of keeping the source verbatim), so every outbound copy,
 * paste and drop strips it.
 */
export const SOURCE_META_ATTRS = ['src', 'sep', 'lead', 'blockId', 'prevId', 'nextId'] as const;

/**
 * Editor-only attributes that must never survive an insertion: `removeId` binds a Remove-censor
 * prompt to one atom. A dragged or pasted duplicate carrying the same id would make a late Remove
 * ambiguous, so inserted slices always arrive without it.
 */
export const TRANSIENT_ATTRS = ['removeId'] as const;

/** Every attribute that is editor bookkeeping rather than note content. */
export const PRIVATE_ATTRS: readonly string[] = [...SOURCE_META_ATTRS, ...TRANSIENT_ATTRS];

const SOURCE_META_SET: ReadonlySet<string> = new Set(SOURCE_META_ATTRS);
const PRIVATE_SET: ReadonlySet<string> = new Set(PRIVATE_ATTRS);

export function isPrivateAttr(name: string): boolean {
  return PRIVATE_SET.has(name);
}

function hasAttrIn(attrs: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  for (const key of Object.keys(attrs)) if (keys.has(key)) return true;
  return false;
}

function withoutAttrs(
  attrs: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) if (!keys.has(key)) out[key] = value;
  return out;
}

function rebuild(node: PMNode, attrs: Record<string, unknown>, content: Fragment): PMNode {
  // `NodeType.create` only copies declared attributes, so a global attribute that is absent from a
  // node type's spec can never sneak back in. Leaf nodes take `null` content.
  return node.type.create(attrs, node.isLeaf ? null : content, node.marks);
}

function stripFragment(fragment: Fragment, keys: ReadonlySet<string>): Fragment {
  const nodes: PMNode[] = [];
  let changed = false;
  fragment.forEach((child) => {
    const next = stripNode(child, keys);
    if (next !== child) changed = true;
    nodes.push(next);
  });
  return changed ? Fragment.fromArray(nodes) : fragment;
}

function stripNode(node: PMNode, keys: ReadonlySet<string>): PMNode {
  const attrs = node.attrs as Record<string, unknown>;
  const attrsChanged = hasAttrIn(attrs, keys);
  const content = node.content.childCount ? stripFragment(node.content, keys) : node.content;
  if (!attrsChanged && content === node.content) return node;
  return rebuild(node, attrsChanged ? withoutAttrs(attrs, keys) : attrs, content);
}

/**
 * A copy of `slice` whose every node (content and the openStart/openEnd ancestor context, which
 * ProseMirror serialises into `data-pm-slice`) has the private attributes removed.
 */
export function stripPrivateAttrsFromSlice(slice: Slice): Slice {
  const content = stripFragment(slice.content, PRIVATE_SET);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

/** A copy of `slice` with only the transient attributes (Remove-censor ids) removed. */
export function stripTransientAttrsFromSlice(slice: Slice): Slice {
  const content = stripFragment(slice.content, new Set(TRANSIENT_ATTRS));
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

/** A fragment without transient attributes, for a custom clipboard serializer. */
export function stripTransientAttrsFromFragment(fragment: Fragment): Fragment {
  return stripFragment(fragment, new Set(TRANSIENT_ATTRS));
}

/** A fragment without source-meta/transient attributes, for a custom clipboard serializer. */
export function stripPrivateAttrsFromFragment(fragment: Fragment): Fragment {
  return stripFragment(fragment, PRIVATE_SET);
}

/** Whether a node itself carries any source-meta attribute (not its descendants). */
export function hasSourceMeta(node: PMNode): boolean {
  return hasAttrIn(node.attrs as Record<string, unknown>, SOURCE_META_SET);
}

/** A node's attrs without any source-meta attribute. */
export function withoutSourceMeta(attrs: Record<string, unknown>): Record<string, unknown> {
  return withoutAttrs(attrs, SOURCE_META_SET);
}

export const SourceMeta = Extension.create({
  name: 'sourceMeta',
  addGlobalAttributes() {
    return [
      {
        types: [
          'paragraph',
          'heading',
          'codeBlock',
          'blockquote',
          'bulletList',
          'orderedList',
          'taskList',
          'taskItem',
          'listItem',
          'table',
          'tableRow',
          'tableCell',
          'tableHeader',
          'horizontalRule',
          'embed',
        ],
        attributes: {
          src: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
          sep: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
          lead: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
          blockId: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
          prevId: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
          nextId: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
        },
      },
    ];
  },
});
