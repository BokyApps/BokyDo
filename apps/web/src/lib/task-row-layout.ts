/**
 * Where a task row's drag handle and sub-task collapse toggle sit.
 *
 * A phone has no gutter left of the row, so there both controls come onto the row itself: the
 * collapse toggle leads it (before the checkbox) and the drag handle trails it at the row's right
 * edge. From `md` up they go back into the page gutter: the handle at −24 px, the collapse toggle
 * left of it, or, for a sub-task, in the indent next to its checkbox.
 *
 * Both stay 24 px targets and never share a slot, on a phone or on a desktop (F-041, WCAG 2.5.8).
 */

/** Base classes of a row control: a 24 px square, lined up with the checkbox. */
export const ROW_CONTROL_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded text-muted hover:text-fg -mt-0.5 md:mt-0';

/** Left padding of a row at a nesting depth, in rem (the checkbox's −4 px margin is separate). */
export const rowInsetRem = (depth: number): number => 0.25 + depth * 1.75;

/** Left offset of a sub-task's collapse toggle (depth ≥ 1) in the indent, in rem. */
export const subtaskToggleLeftRem = (depth: number): number => depth * 1.75 - 1.5;

export interface RowControlClasses {
  /** Class list for the drag handle, or null when the row has no handle. */
  dragHandle: string | null;
  /** Class list for the sub-task collapse toggle, or null when the row has no toggle. */
  collapseToggle: string | null;
}

export function rowControlClasses({
  depth,
  hasDragHandle,
  hasCollapseToggle,
}: {
  depth: number;
  hasDragHandle: boolean;
  hasCollapseToggle: boolean;
}): RowControlClasses {
  return {
    dragHandle: hasDragHandle
      ? `${ROW_CONTROL_CLASS} static order-last ml-auto cursor-grab touch-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100 md:absolute md:top-1 md:-left-6 md:order-none md:ml-0`
      : null,
    // `static` below `md` keeps the toggle in the row's flow (leading, before the checkbox) and
    // makes the desktop offset below it apply to a positioned element only.
    collapseToggle: hasCollapseToggle
      ? `${ROW_CONTROL_CLASS} static md:absolute md:top-1${depth === 0 ? ' md:-left-12' : ''}`
      : null,
  };
}
