import type { Project, Section, Task } from '@bokydo/shared';
import type { SyncState } from '@bokydo/sync-client';

export const byOrder = <T extends { childOrder: string }>(a: T, b: T) =>
  a.childOrder < b.childOrder ? -1 : a.childOrder > b.childOrder ? 1 : 0;
const bySectionOrder = (a: Section, b: Section) => (a.sectionOrder < b.sectionOrder ? -1 : 1);

export interface ProjectNode {
  project: Project;
  children: ProjectNode[];
}

/** Non-inbox projects as a tree, ordered. */
export function projectTree(state: SyncState, archived = false): ProjectNode[] {
  const all = [...state.projects.values()]
    .filter((p) => !p.isInbox && p.isArchived === archived)
    .sort(byOrder);
  const ids = new Set(all.map((p) => p.id));
  const build = (parentId: string | null): ProjectNode[] =>
    all
      .filter((p) =>
        parentId === null ? !p.parentId || !ids.has(p.parentId) : p.parentId === parentId,
      )
      .map((project) => ({ project, children: build(project.id) }));
  return build(null);
}

export function flattenTree(
  nodes: ProjectNode[],
  depth = 0,
): { project: Project; depth: number }[] {
  return nodes.flatMap((n) => [
    { project: n.project, depth },
    ...flattenTree(n.children, depth + 1),
  ]);
}

/** Tasks the user can act on: live project, not archived. */
export function liveTasks(state: SyncState): Task[] {
  return [...state.tasks.values()].filter((t) => {
    const p = state.projects.get(t.projectId);
    return p && !p.isArchived;
  });
}

export const isOpen = (t: Task) => !t.isCompleted;

export function sectionsOf(state: SyncState, projectId: string): Section[] {
  return [...state.sections.values()]
    .filter((s) => s.projectId === projectId && !s.isArchived)
    .sort(bySectionOrder);
}

export function childrenOf(state: SyncState, parentId: string): Task[] {
  return [...state.tasks.values()].filter((t) => t.parentId === parentId).sort(byOrder);
}

export function subtaskProgress(
  state: SyncState,
  taskId: string,
): { done: number; total: number } | null {
  const kids = childrenOf(state, taskId);
  return kids.length
    ? { done: kids.filter((k) => k.isCompleted).length, total: kids.length }
    : null;
}

/** Top-level open tasks of a project, grouped by section (null = no section). */
export function projectTasks(
  state: SyncState,
  projectId: string,
  showCompleted = false,
): Map<string | null, Task[]> {
  const groups = new Map<string | null, Task[]>([[null, []]]);
  for (const s of sectionsOf(state, projectId)) groups.set(s.id, []);
  for (const t of state.tasks.values()) {
    if (t.projectId !== projectId || t.parentId || (!showCompleted && t.isCompleted)) continue;
    const key = t.sectionId && groups.has(t.sectionId) ? t.sectionId : null;
    groups.get(key)?.push(t);
  }
  for (const list of groups.values()) list.sort(byOrder);
  return groups;
}

export type SortMode = 'manual' | 'date' | 'priority' | 'name';
export type GroupMode = 'none' | 'project' | 'priority' | 'date' | 'label';

export function sortTasks(
  tasks: Task[],
  mode: SortMode,
  projectOrder?: Map<string, number>,
): Task[] {
  const due = (t: Task) => (t.due ? `${t.due.date} ${t.due.time ?? '99:99'}` : '9999');
  const cmp: Record<SortMode, (a: Task, b: Task) => number> = {
    manual: (a, b) =>
      (projectOrder
        ? (projectOrder.get(a.projectId) ?? 0) - (projectOrder.get(b.projectId) ?? 0)
        : 0) || byOrder(a, b),
    date: (a, b) => due(a).localeCompare(due(b)) || a.priority - b.priority,
    priority: (a, b) => a.priority - b.priority || due(a).localeCompare(due(b)),
    name: (a, b) => a.content.localeCompare(b.content),
  };
  return [...tasks].sort(cmp[mode]);
}

export function projectOrderIndex(state: SyncState): Map<string, number> {
  const ordered = [
    state.user?.inboxProjectId,
    ...flattenTree(projectTree(state)).map((x) => x.project.id),
  ];
  return new Map(ordered.filter((x): x is string => Boolean(x)).map((id, i) => [id, i]));
}

/** Today view: overdue and due today (top-level and sub-tasks alike, as in Todoist). */
export function todayTasks(state: SyncState, today: string) {
  const open = liveTasks(state).filter((t) => isOpen(t));
  return {
    overdue: open.filter((t) => t.due && t.due.date < today),
    today: open.filter((t) => t.due?.date === today),
  };
}

export function tasksDueBetween(state: SyncState, from: string, to: string): Task[] {
  return liveTasks(state).filter(
    (t) => isOpen(t) && t.due && t.due.date >= from && t.due.date <= to,
  );
}

export function labelTasks(state: SyncState, name: string): Task[] {
  const n = name.toLowerCase();
  return liveTasks(state).filter((t) => isOpen(t) && t.labels.some((l) => l.toLowerCase() === n));
}

/** Every label name in use (personal labels plus names on shared tasks). */
export function allLabelNames(state: SyncState): string[] {
  const names = new Map<string, string>();
  for (const l of state.labels.values()) names.set(l.name.toLowerCase(), l.name);
  for (const t of state.tasks.values())
    for (const l of t.labels) if (!names.has(l.toLowerCase())) names.set(l.toLowerCase(), l);
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

export function groupTasks(
  tasks: Task[],
  mode: GroupMode,
  state: SyncState,
  today: string,
): { key: string; title: string; tasks: Task[] }[] {
  if (mode === 'none') return [{ key: 'all', title: '', tasks }];
  const groups = new Map<string, { title: string; tasks: Task[] }>();
  const add = (key: string, title: string, t: Task) => {
    const g = groups.get(key) ?? { title, tasks: [] };
    g.tasks.push(t);
    groups.set(key, g);
  };
  for (const t of tasks) {
    if (mode === 'project') add(t.projectId, state.projects.get(t.projectId)?.name ?? 'Project', t);
    else if (mode === 'priority')
      add(`p${t.priority}`, t.priority === 4 ? 'No priority' : `Priority ${t.priority}`, t);
    else if (mode === 'date') {
      // One "Overdue" group ('!' sorts before dates, '~' after).
      if (!t.due) add('~', 'No date', t);
      else if (t.due.date < today) add('!overdue', 'Overdue', t);
      else add(t.due.date, t.due.date, t);
    } else if (mode === 'label') {
      if (t.labels.length === 0) add('~', 'No label', t);
      for (const l of t.labels) add(l.toLowerCase(), `@${l}`, t);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, g]) => ({ key, ...g }));
}
