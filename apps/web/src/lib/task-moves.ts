import { generateKeyBetween, type Task } from '@bokydo/shared';
import type { SyncState } from '@bokydo/sync-client';
import { byOrder, childrenOf } from './views.js';

/** Where a task goes: the same shape drag-and-drop hands to `actions.place`. */
export interface Placement {
  projectId: string;
  sectionId: string | null;
  parentId: string | null;
  childOrder: string;
}

export interface TaskMoves {
  up: Placement | null;
  down: Placement | null;
  /** Become the last sub-task of the task above. */
  indent: Placement | null;
  /** Leave the parent, landing right after it. */
  outdent: Placement | null;
}

/** An order key between two neighbours, tolerating keys that have drifted out of order. */
export function between(a: string | null, b: string | null): string {
  try {
    return generateKeyBetween(a, b && a && b <= a ? null : b);
  } catch {
    return generateKeyBetween(a, null);
  }
}

/** How deep a task sits (0 = top level). */
function depthOf(state: SyncState, task: Task): number {
  let depth = 0;
  for (let t = task; t.parentId && depth < 20; depth++) {
    const parent = state.tasks.get(t.parentId);
    if (!parent) break;
    t = parent;
  }
  return depth;
}

/** Sub-tasks nest at most this deep below a top-level task (the server enforces the same limit). */
export const MAX_SUBTASK_DEPTH = 4;

const siblingsOf = (state: SyncState, task: Task): Task[] =>
  [...state.tasks.values()]
    .filter(
      (t) =>
        t.projectId === task.projectId &&
        t.sectionId === task.sectionId &&
        t.parentId === task.parentId &&
        !t.isCompleted,
    )
    .sort(byOrder);

/**
 * The moves a menu can offer instead of dragging: one step up or down among siblings, and in or
 * out one level of nesting. Each is the exact placement a drag with the same effect would make.
 */
export function taskMoves(state: SyncState, task: Task): TaskMoves {
  const siblings = siblingsOf(state, task);
  const index = siblings.findIndex((t) => t.id === task.id);
  const at = (n: number) => siblings[n];
  const same = (childOrder: string): Placement => ({
    projectId: task.projectId,
    sectionId: task.sectionId,
    parentId: task.parentId,
    childOrder,
  });

  const prev = index > 0 ? at(index - 1) : undefined;
  const next = index >= 0 ? at(index + 1) : undefined;
  const up = prev ? same(between(at(index - 2)?.childOrder ?? null, prev.childOrder)) : null;
  const down = next ? same(between(next.childOrder, at(index + 2)?.childOrder ?? null)) : null;

  let indent: Placement | null = null;
  if (prev && depthOf(state, prev) + 1 <= MAX_SUBTASK_DEPTH) {
    const kids = childrenOf(state, prev.id).filter((k) => !k.isCompleted);
    indent = {
      projectId: prev.projectId,
      sectionId: prev.sectionId,
      parentId: prev.id,
      childOrder: between(kids.at(-1)?.childOrder ?? null, null),
    };
  }

  let outdent: Placement | null = null;
  const parent = task.parentId ? state.tasks.get(task.parentId) : undefined;
  if (parent) {
    const uncles = siblingsOf(state, parent);
    const after = uncles[uncles.findIndex((t) => t.id === parent.id) + 1];
    outdent = {
      projectId: parent.projectId,
      sectionId: parent.sectionId,
      parentId: parent.parentId,
      childOrder: between(parent.childOrder, after?.childOrder ?? null),
    };
  }
  return { up, down, indent, outdent };
}
