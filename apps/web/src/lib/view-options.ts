import { useState } from 'react';
import type { GroupMode, SortMode } from './views.js';

export type Layout = 'list' | 'board' | 'calendar';

export interface ViewOptions {
  sort: SortMode;
  group: GroupMode;
  showCompleted: boolean;
  /** For views without a synced layout of their own (labels, filters). */
  layout: Layout;
}

/** Per-view display options, remembered on this device. */
export function useViewOptions(key: string, defaults: Partial<ViewOptions> = {}) {
  const storageKey = `bokydo.view.${key}`;
  const [options, setOptions] = useState<ViewOptions>(() => {
    const base: ViewOptions = {
      sort: 'manual',
      group: 'none',
      showCompleted: false,
      layout: 'list',
      ...defaults,
    };
    try {
      return {
        ...base,
        ...(JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<ViewOptions>),
      };
    } catch {
      return base;
    }
  });
  const update = (patch: Partial<ViewOptions>) => {
    setOptions((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // storage unavailable: options still apply for this visit
      }
      return next;
    });
  };
  return [options, update] as const;
}
