import { localNow, parseDate } from '@bokydo/nlp';
import {
  countTemplate,
  generateNKeysBetween,
  isKnownTimeZone,
  type Command,
  type Due,
  type Preferences,
  type Template,
  type TemplateTask,
  type TemplateWarning,
} from '@bokydo/shared';
import type { SyncState } from '@bokydo/sync-client';
import { toTaskDue } from '../quick-add.js';

/** A command before the store gives it a uuid. */
export type PlannedCommand = Command extends infer C
  ? C extends Command
    ? Pick<C, 'type' | 'args'>
    : never
  : never;

export type ImportTarget = { kind: 'new'; name: string } | { kind: 'existing'; projectId: string };

export interface ImportOptions {
  template: Template;
  target: ImportTarget;
  state: SyncState;
  prefs: Pick<Preferences, 'weekStart' | 'dateFormat' | 'timeFormat'>;
  timeZone: string;
  includeComments?: boolean;
  now?: Date;
  newId?: () => string;
}

export interface ImportPlan {
  projectId: string;
  /** The tasks the commands add, to check afterwards that the server accepted them. */
  taskIds: string[];
  commands: PlannedCommand[];
  /** Problems with dates; they never stop the import, the task just comes in without a date. */
  warnings: TemplateWarning[];
  counts: { sections: number; tasks: number; comments: number };
}

const highest = (keys: string[]): string | null =>
  keys.reduce<string | null>((max, key) => (max === null || key > max ? key : max), null);

/**
 * Turn a template into ordinary sync commands. Nothing here is trusted by the server: it checks
 * every command like any other (permissions, limits, validation), so a template can't write to a
 * project the user can't edit. Dates are read the way quick add reads them.
 */
export function planImport(opts: ImportOptions): ImportPlan {
  const { template, state, prefs } = opts;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const withComments = opts.includeComments ?? true;
  const now = localNow(opts.timeZone, opts.now);
  const warnings: TemplateWarning[] = [];
  const commands: PlannedCommand[] = [];
  const taskIds: string[] = [];

  const projectId = opts.target.kind === 'existing' ? opts.target.projectId : newId();
  if (opts.target.kind === 'new') {
    commands.push({
      type: 'project_add',
      args: { id: projectId, name: opts.target.name.trim().slice(0, 120) || 'Imported project' },
    });
  }

  // Where new rows go: after what the project already has (nothing, for a new project).
  const existingSections = [...state.sections.values()].filter((s) => s.projectId === projectId);
  const existingTop = [...state.tasks.values()].filter(
    (t) => t.projectId === projectId && !t.parentId && !t.sectionId,
  );
  const sectionKeys = generateNKeysBetween(
    highest(existingSections.map((s) => s.sectionOrder)),
    null,
    template.sections.length,
  );

  const dueFor = (task: TemplateTask): Due | null => {
    if (!task.date) return null;
    const parsed = parseDate(task.date, {
      now,
      weekStart: prefs.weekStart,
      dateOrder: prefs.dateFormat,
    });
    if (!parsed) {
      warnings.push({
        row: null,
        message: `“${task.content}”: couldn't read the date “${task.date}”, so it came in without a date.`,
      });
      return null;
    }
    const due = toTaskDue(parsed, now.date, prefs);
    if (task.timezone && due.time) {
      if (isKnownTimeZone(task.timezone)) return { ...due, timezone: task.timezone };
      warnings.push({
        row: null,
        message: `“${task.content}”: the time zone “${task.timezone}” isn't recognised, so its time is not tied to a zone.`,
      });
    }
    return due;
  };
  const deadlineFor = (task: TemplateTask): string | null => {
    if (!task.deadline) return null;
    const parsed = parseDate(task.deadline, {
      now,
      weekStart: prefs.weekStart,
      dateOrder: prefs.dateFormat,
    });
    if (parsed) return parsed.date;
    warnings.push({
      row: null,
      message: `“${task.content}”: couldn't read the deadline “${task.deadline}”, so it was left out.`,
    });
    return null;
  };

  /** One list of tasks (before the first section, or one section), nested by `depth`. */
  const addList = (tasks: TemplateTask[], sectionId: string | null, existingKeys: string[]) => {
    const ids = tasks.map(() => newId());
    const parentOf = (index: number): number => {
      const depth = tasks[index]?.depth ?? 0;
      for (let i = index - 1; i >= 0; i--) if ((tasks[i]?.depth ?? 0) < depth) return i;
      return -1;
    };
    // Sibling groups, in file order: top-level tasks of this list, and each task's sub-tasks.
    const groups = new Map<number, number[]>();
    tasks.forEach((_task, index) => {
      const parent = parentOf(index);
      groups.set(parent, [...(groups.get(parent) ?? []), index]);
    });
    const order = new Map<number, string>();
    for (const [parent, members] of groups) {
      const start = parent === -1 ? highest(existingKeys) : null;
      generateNKeysBetween(start, null, members.length).forEach((key, i) => {
        const member = members[i];
        if (member !== undefined) order.set(member, key);
      });
    }
    tasks.forEach((task, index) => {
      const parent = parentOf(index);
      const id = ids[index] ?? newId();
      taskIds.push(id);
      commands.push({
        type: 'task_add',
        args: {
          id,
          projectId,
          // A sub-task always lives in its parent's section, so it doesn't name one.
          ...(parent === -1 && sectionId ? { sectionId } : {}),
          ...(parent === -1 ? {} : { parentId: ids[parent] ?? null }),
          childOrder: order.get(index) ?? 'a0',
          content: task.content,
          description: task.description,
          priority: task.priority,
          due: dueFor(task),
          deadline: deadlineFor(task),
          durationMinutes: task.durationMinutes,
        },
      });
      if (withComments)
        for (const comment of task.comments)
          commands.push({
            type: 'comment_add',
            args: { id: newId(), taskId: id, content: comment },
          });
    });
  };

  addList(
    template.tasks,
    null,
    existingTop.map((t) => t.childOrder),
  );
  template.sections.forEach((section, i) => {
    const id = newId();
    commands.push({
      type: 'section_add',
      args: { id, projectId, name: section.name, sectionOrder: sectionKeys[i] ?? 'a0' },
    });
    addList(section.tasks, id, []);
  });

  const counts = countTemplate(template);
  return {
    projectId,
    taskIds,
    commands,
    warnings,
    counts: { ...counts, comments: withComments ? counts.comments : 0 },
  };
}
