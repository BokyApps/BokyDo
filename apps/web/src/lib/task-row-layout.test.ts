import { describe, expect, it } from 'vitest';
import {
  ROW_CONTROL_CLASS,
  rowControlClasses,
  rowInsetRem,
  subtaskToggleLeftRem,
} from './task-row-layout.js';

/** Class tokens that apply below the `md` breakpoint (a `max-md:` rule counts as a phone rule). */
const isWide = (token: string) => /^(sm|md|lg|xl|2xl):/.test(token);
const phoneTokens = (cls: string) => cls.split(/\s+/).filter((t) => t && !isWide(t));
const wideTokens = (cls: string) =>
  cls
    .split(/\s+/)
    .filter((t) => t.startsWith('md:'))
    .map((t) => t.slice(3));

const both = rowControlClasses({ depth: 0, hasDragHandle: true, hasCollapseToggle: true });
const sub = rowControlClasses({ depth: 1, hasDragHandle: true, hasCollapseToggle: true });

describe('task row controls', () => {
  it('keeps the handle and the toggle on the row on a phone', () => {
    for (const cls of [both.dragHandle, both.collapseToggle, sub.collapseToggle]) {
      expect(cls).toBeTruthy();
      const tokens = phoneTokens(cls as string);
      // Nothing is positioned or pulled off the row's left edge below md.
      expect(tokens).not.toContain('absolute');
      expect(tokens.some((t) => /^-?left-/.test(t))).toBe(false);
    }
  });

  it('leads the row with the toggle and trails it with the handle on a phone', () => {
    // The toggle is a plain flow item (it comes before the checkbox in the row).
    expect(phoneTokens(both.collapseToggle as string)).toContain('static');
    // The handle goes last, at the row's right edge.
    expect(phoneTokens(both.dragHandle as string)).toEqual(
      expect.arrayContaining(['order-last', 'ml-auto', 'static']),
    );
    // ...and it is visible there: the desktop rule hides it until hover.
    expect(phoneTokens(both.dragHandle as string)).toContain('max-md:opacity-100');
    // A touch on the handle drags the task instead of scrolling the page.
    expect(phoneTokens(both.dragHandle as string)).toContain('touch-none');
  });

  it('pulls them into the page gutter, each with its own slot, from md up', () => {
    expect(wideTokens(both.dragHandle as string)).toEqual(
      expect.arrayContaining(['absolute', 'top-1', '-left-6', 'order-none']),
    );
    expect(wideTokens(both.collapseToggle as string)).toEqual(
      expect.arrayContaining(['absolute', 'top-1', '-left-12']),
    );
    // Different slots, so the two 24 px targets can never overlap.
    expect(wideTokens(both.dragHandle as string)).toContain('-left-6');
    expect(wideTokens(both.collapseToggle as string)).toContain('-left-12');
  });

  it('puts a sub-task toggle in the indent, flush with its checkbox', () => {
    // rowInsetRem is the row's left padding; the checkbox has a −0.25 rem margin, so a sub-task's
    // checkbox starts at depth × 1.75 rem. The toggle ends exactly there.
    for (const depth of [1, 2, 3, 4, 5]) {
      const left = subtaskToggleLeftRem(depth);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + 1.5).toBeCloseTo(depth * 1.75);
      expect(left + 1.5).toBeCloseTo(rowInsetRem(depth) - 0.25);
    }
  });

  it('draws no control that was not asked for', () => {
    const none = rowControlClasses({
      depth: 0,
      hasDragHandle: false,
      hasCollapseToggle: false,
    });
    expect(none).toEqual({ dragHandle: null, collapseToggle: null });
  });

  it('keeps every control a 24 px target', () => {
    expect(phoneTokens(ROW_CONTROL_CLASS)).toContain('size-6');
  });
});
