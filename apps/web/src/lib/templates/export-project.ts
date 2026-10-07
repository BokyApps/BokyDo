import {
  MAX_TEMPLATE_DEPTH,
  type Due,
  type Task,
  type Template,
  type TemplateTask,
} from '@bokydo/shared';
import type { SyncState } from '@bokydo/sync-client';

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A date as text that BokyDo and Todoist can both read back: a repeating task keeps the phrase it
 * was written with ("every monday at 9am"); a one-off date is ISO, which never depends on anyone's
 * date-format preference.
 */
export function exportDate(due: Due): string {
  if (due.recurrence) return due.string;
  return due.time ? `${due.date} ${due.time}` : due.date;
}

/**
 * The open tasks and sections of a project as a template, in the order the project shows them.
 * Completed tasks are left out, as they are in Todoist's own export. Nobody's name leaves here:
 * no authors, no assignees.
 */
export function projectToTemplate(state: SyncState, projectId: string): Template {
  const project = state.projects.get(projectId);
  const tasks = [...state.tasks.values()].filter(
    (t) => t.projectId === projectId && !t.isCompleted,
  );
  const sections = [...state.sections.values()]
    .filter((s) => s.projectId === projectId && !s.isArchived)
    .sort((a, b) => byKey(a.sectionOrder, b.sectionOrder));
  const sectionIds = new Set(sections.map((s) => s.id));
  // What an archived section holds is hidden in the app, so it stays out of the file too.
  const archivedIds = new Set(
    [...state.sections.values()]
      .filter((s) => s.projectId === projectId && s.isArchived)
      .map((s) => s.id),
  );

  const children = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const list = children.get(task.parentId) ?? [];
    list.push(task);
    children.set(task.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => byKey(a.childOrder, b.childOrder));

  const comments = new Map<string, string[]>();
  for (const c of [...state.comments.values()].sort((a, b) => byKey(a.createdAt, b.createdAt))) {
    if (!c.taskId || !c.content.trim()) continue;
    comments.set(c.taskId, [...(comments.get(c.taskId) ?? []), c.content]);
  }

  const toTask = (task: Task, depth: number): TemplateTask => ({
    content: task.content,
    description: task.description,
    priority: task.priority,
    depth,
    date: task.due ? exportDate(task.due) : null,
    timezone: task.due?.time ? task.due.timezone : null,
    durationMinutes: task.durationMinutes,
    deadline: task.deadline,
    comments: comments.get(task.id) ?? [],
  });
  /** A task, then its sub-tasks; anything nested deeper than Todoist allows stays at the limit. */
  const walk = (task: Task, depth: number): TemplateTask[] => [
    toTask(task, depth),
    ...(children.get(task.id) ?? []).flatMap((child) =>
      walk(child, Math.min(depth + 1, MAX_TEMPLATE_DEPTH)),
    ),
  ];
  const top = (sectionId: string | null) =>
    (children.get(null) ?? [])
      .filter((t) => !(t.sectionId && archivedIds.has(t.sectionId)))
      .filter(
        (t) => (t.sectionId && sectionIds.has(t.sectionId) ? t.sectionId : null) === sectionId,
      )
      .flatMap((task) => walk(task, 0));

  return {
    name: project?.name ?? 'Project',
    tasks: top(null),
    sections: sections.map((s) => ({ name: s.name, tasks: top(s.id) })),
  };
}
