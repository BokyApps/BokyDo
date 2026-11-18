import { Extension, mergeAttributes, type Editor } from '@tiptap/core';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TextSelection } from '@tiptap/pm/state';

/**
 * Review fix (CSP `style-src 'self'`): stock TableKit emits inline `style` attributes — the table
 * `min-width`/`width`, `<col style="width:…">` from column resizing, and `text-align` on aligned
 * cells. Inline style *attributes* are blocked by our CSP. Column resizing is disabled anyway;
 * these extensions render no `style` at all, using classes / `data-align` for alignment instead.
 * We extend the individual TableKit nodes (rather than the kit) so we keep `tableRole` and the
 * tableEditing plugin (Tab navigation, cell selection) while overriding the DOM output.
 *
 * Review fix (edits vanish): a cell is exactly one paragraph of inline content, never `block+`.
 * The Markdown table grammar can only represent one line per cell, so a second paragraph, a list
 * or a nested table inside a cell could never survive a save. Enter inside a cell therefore
 * inserts a hard break, which is representable as `<br>`.
 */

const ALIGNS = new Set(['left', 'center', 'right']);

function normAlign(value: unknown): string | null {
  return typeof value === 'string' && ALIGNS.has(value.toLowerCase()) ? value.toLowerCase() : null;
}

/** Alignment is kept as a class/`data-align` attribute, never an inline `text-align` style. */
function alignAttribute() {
  return {
    default: null as string | null,
    parseHTML: (el: HTMLElement | string) =>
      typeof el === 'string'
        ? null
        : (normAlign(el.getAttribute('data-align')) ?? normAlign(el.getAttribute('align'))),
    renderHTML: (attributes: { align?: unknown }) => {
      const align = normAlign(attributes.align);
      return align ? { 'data-align': align, class: `bk-cell-${align}` } : {};
    },
    keepOnSplit: true,
  };
}

export const SafeTable = Table.extend({
  // TableView writes `this.table.style.*` inline widths; disable the node view entirely so the
  // (style-free) renderHTML below is used.
  addNodeView() {
    return null;
  },
  renderHTML({ HTMLAttributes }) {
    return ['table', mergeAttributes(HTMLAttributes, { class: 'bk-note-table' }), ['tbody', 0]];
  },
});

export const SafeTableCell = TableCell.extend({
  content: 'paragraph',
  addAttributes() {
    return { ...this.parent?.(), align: alignAttribute() };
  },
});

export const SafeTableHeader = TableHeader.extend({
  content: 'paragraph',
  addAttributes() {
    return { ...this.parent?.(), align: alignAttribute() };
  },
});

export const SafeTableRow = TableRow;

/**
 * Enter inside a table cell: a new paragraph is impossible by schema, so insert a hard break
 * instead of letting ProseMirror's `splitBlock` fail silently. Shift/Ctrl-Enter keep their
 * StarterKit behaviour (also a hard break). Outside a cell this returns false, so normal
 * paragraph splitting still happens.
 */
export function insertHardBreakInCell(editor: Editor): boolean {
  const { selection } = editor.state;
  // A CellSelection has no textblock parent to split; let ProseMirror ignore Enter there.
  if (!(selection instanceof TextSelection)) return false;
  if (!editor.isActive('tableCell') && !editor.isActive('tableHeader')) return false;
  return editor.commands.setHardBreak();
}

export const TableCellEnter = Extension.create({
  name: 'tableCellEnter',
  // Core's Keymap (Enter -> splitBlock) is a core extension; a higher priority guarantees this
  // binding is consulted first, so Enter in a cell never attempts an impossible split.
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Enter: () => insertHardBreakInCell(this.editor),
    };
  },
});

/** Style-free replacements for TableKit's table/row/cell/header extensions. */
export const safeTableExtensions = [
  SafeTable,
  SafeTableRow,
  SafeTableCell,
  SafeTableHeader,
  TableCellEnter,
];
