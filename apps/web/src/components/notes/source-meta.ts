import { Extension } from '@tiptap/core';

/**
 * Review fix (silent rewrite / data loss): `markdownToDoc` attaches `attrs.src`, `attrs.sep`,
 * `attrs.lead` and `attrs.hash` to every top-level block so `docToMarkdown` can emit unchanged
 * blocks verbatim. ProseMirror drops unknown attributes, so they must be registered here as global
 * attributes on every block node type. They are deliberately *never* rendered to HTML
 * (`renderHTML`/`parseHTML` are inert): a `src` may contain censor tokens or raw Markdown and must
 * never leak into the DOM, the clipboard HTML, or be read back from pasted HTML.
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
          hash: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
        },
      },
    ];
  },
});
