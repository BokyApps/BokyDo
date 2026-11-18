import { mergeAttributes } from '@tiptap/core';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';

/**
 * Review fix (CSP `style-src 'self'`): stock TableKit emits inline `style` attributes — the table
 * `min-width`/`width`, `<col style="width:…">` from column resizing, and `text-align` on aligned
 * cells. Inline style *attributes* are blocked by our CSP. Column resizing is disabled anyway;
 * these extensions render no `style` at all, using classes / `data-align` for alignment instead.
 * We extend the individual TableKit nodes (rather than the kit) so we keep `tableRole` and the
 * tableEditing plugin (Tab navigation, cell selection) while overriding the DOM output.
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
  addAttributes() {
    return { ...this.parent?.(), align: alignAttribute() };
  },
});

export const SafeTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), align: alignAttribute() };
  },
});

export const SafeTableRow = TableRow;

/** Style-free replacements for TableKit's table/row/cell/header extensions. */
export const safeTableExtensions = [SafeTable, SafeTableRow, SafeTableCell, SafeTableHeader];
