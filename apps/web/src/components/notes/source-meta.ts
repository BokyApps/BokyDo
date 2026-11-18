import { Extension } from '@tiptap/core';

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
