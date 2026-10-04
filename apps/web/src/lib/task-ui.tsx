import type { Due } from '@bokydo/shared';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface AddDefaults {
  projectId?: string;
  sectionId?: string | null;
  parentId?: string | null;
  due?: Due | null;
  labels?: string[];
}

interface TaskUI {
  openTaskId: string | null;
  openTask: (id: string | null) => void;
  selected: ReadonlySet<string>;
  /** additive: ctrl/cmd-click; range: shift-click over `orderedIds`. */
  select: (id: string, mode: 'toggle' | 'range' | 'only', orderedIds?: string[]) => void;
  clearSelection: () => void;
  quickAdd: AddDefaults | null;
  openQuickAdd: (defaults?: AddDefaults) => void;
  closeQuickAdd: () => void;
  /** Defaults for quick add from the current view (set by pages). */
  viewDefaults: AddDefaults;
  setViewDefaults: (d: AddDefaults) => void;
}

const Ctx = createContext<TaskUI | null>(null);

export function TaskUIProvider({ children }: { children: ReactNode }) {
  const [openTaskId, openTask] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState<AddDefaults | null>(null);
  const [viewDefaults, setViewDefaults] = useState<AddDefaults>({});

  const select = useCallback(
    (id: string, mode: 'toggle' | 'range' | 'only', orderedIds: string[] = []) => {
      setSelected((prev) => {
        const next = new Set(mode === 'only' ? [] : prev);
        if (mode === 'range' && anchor && orderedIds.includes(anchor)) {
          const [a, b] = [orderedIds.indexOf(anchor), orderedIds.indexOf(id)].sort(
            (x, y) => x - y,
          ) as [number, number];
          for (const x of orderedIds.slice(a, b + 1)) next.add(x);
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      if (mode !== 'range') setAnchor(id);
    },
    [anchor],
  );

  const value = useMemo<TaskUI>(
    () => ({
      openTaskId,
      openTask,
      selected,
      select,
      clearSelection: () => setSelected(new Set()),
      quickAdd,
      openQuickAdd: (d) => setQuickAdd({ ...viewDefaults, ...d }),
      closeQuickAdd: () => setQuickAdd(null),
      viewDefaults,
      setViewDefaults,
    }),
    [openTaskId, selected, select, quickAdd, viewDefaults],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTaskUI(): TaskUI {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTaskUI needs <TaskUIProvider>');
  return ctx;
}
