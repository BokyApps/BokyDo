import { parseQuickAdd, type QuickAddOptions } from './quick-add.js';

/**
 * Quick add for the Android app (ADR 0016), which runs this package in a JavaScript sandbox: JSON
 * in (`{ text, options }`, options as `QuickAddOptions` with `disabled` as an array), JSON out
 * (`QuickAddResult`). Strings only cross the boundary, so the text is never spliced into code.
 */
export function quickAddJson(json: string): string {
  const input = JSON.parse(json) as { text?: unknown; options?: unknown };
  if (typeof input.text !== 'string') throw new TypeError('text must be a string');
  const options = (input.options ?? {}) as Omit<QuickAddOptions, 'disabled'> & {
    disabled?: unknown;
  };
  if (typeof options !== 'object' || !options.now) throw new TypeError('options.now is required');
  const disabled = Array.isArray(options.disabled)
    ? new Set(options.disabled.filter((d): d is string => typeof d === 'string'))
    : new Set<string>();
  return JSON.stringify(parseQuickAdd(input.text, { ...options, disabled }));
}
