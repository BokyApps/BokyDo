import { matcher, parseFilter, resolveFilter, type FilterError } from '@bokydo/filter-query';
import { localNow } from '@bokydo/nlp';
import type { Preferences, Task } from '@bokydo/shared';
import type { SyncState } from '@bokydo/sync-client';
import { useMemo } from 'react';
import { usePreferences, useSyncState, useTimeZone } from './sync.js';
import { isOpen, liveTasks } from './views.js';

export type LocalFilterResult =
  | { ok: true; lists: { query: string; tasks: Task[] }[]; warnings: string[] }
  | { ok: false; error: FilterError };

/**
 * Run a filter over the synced state, instantly and offline. Same parser and semantics as the
 * server's SQL path (a differential test keeps them in step).
 */
export function runFilterLocally(
  state: SyncState,
  query: string,
  opts: { timeZone: string; prefs: Pick<Preferences, 'weekStart' | 'dateFormat'>; now?: Date },
): LocalFilterResult {
  const now = localNow(opts.timeZone, opts.now);
  const parsed = parseFilter(query, {
    now,
    weekStart: opts.prefs.weekStart,
    dateOrder: opts.prefs.dateFormat,
  });
  if (!parsed.ok) return parsed;
  const { queries, warnings } = resolveFilter(parsed.queries, {
    projects: [...state.projects.values()],
    sections: [...state.sections.values()],
  });
  const open = liveTasks(state).filter(isOpen);
  const userId = state.user?.id ?? '';
  return {
    ok: true,
    warnings,
    lists: queries.map((q) => {
      const match = matcher(q.node, { now, userId, timeZone: opts.timeZone });
      return { query: q.text, tasks: open.filter(match) };
    }),
  };
}

export function useFilter(query: string): LocalFilterResult {
  const state = useSyncState();
  const prefs = usePreferences();
  const timeZone = useTimeZone();
  return useMemo(
    () => runFilterLocally(state, query, { timeZone, prefs }),
    [state, query, timeZone, prefs],
  );
}
