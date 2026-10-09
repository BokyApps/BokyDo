import { parseDate, type LocalNow } from '@bokydo/nlp';
import {
  COLORS,
  commandArgs,
  filterQuerySchema,
  isKnownTimeZone,
  labelNameSchema,
  type Color,
  type CommandType,
  type Due,
  type Preferences,
  type TodoistImportCounts,
  type TodoistImportWarning,
} from '@bokydo/shared';
import { newId } from '../db/ids.js';
import {
  hasCompletionDate,
  type TodoistComment,
  type TodoistCompletedTask,
  type TodoistDue,
  type TodoistSnapshot,
  type TodoistTask,
} from './todoist-client.js';

/**
 * Turns a Todoist snapshot and the user's choices into sync commands (PLAN W11a). Pure: the
 * import service supplies what already exists, applies the commands through the sync engine (so
 * every permission check and limit applies, exactly as if the user had typed it all) and records
 * the id mappings in the same transactions. Nothing here trusts the snapshot beyond its types:
 * every command is checked against the command schemas before it is planned.
 */
export type MappingKind = 'project' | 'section' | 'task' | 'comment' | 'filter';
export const mappingKey = (kind: MappingKind, externalId: string) => `${kind}:${externalId}`;

export interface PlanInput {
  snapshot: TodoistSnapshot;
  /** Completed tasks the user asked for (absent when they did not): the choice is opt-in. */
  completed?: readonly TodoistCompletedTask[];
  choices: {
    projects: {
      id: string;
      action: 'new' | 'merge';
      targetId?: string | undefined;
      workspaceId?: string | null | undefined;
    }[];
    labels: string[];
    filters: string[];
    comments: boolean;
    people: { id: string; userId: string | null }[];
  };
  userId: string;
  /** Earlier imports whose BokyDo item still exists: mapping key → local id. */
  imported: ReadonlyMap<string, string>;
  /** The user's label names, lower-cased. */
  labelNames: ReadonlySet<string>;
  /** Members of each BokyDo project a merge may go into (to keep valid assignees). */
  members: ReadonlyMap<string, ReadonlySet<string>>;
  dates: {
    now: LocalNow;
    weekStart: Preferences['weekStart'];
    dateOrder: Preferences['dateFormat'];
  };
}

export interface PlannedStep {
  /** null: nothing to write, only the mapping to record (a project merged into an existing one). */
  type: CommandType | null;
  args: Record<string, unknown>;
  /** Recorded with the command, so a re-run knows it came over. */
  mapping: { kind: MappingKind; externalId: string; localId: string } | null;
  /** What the user would call it, for failure messages. */
  label: string;
}

/**
 * A completed task to write as completed (W11a-c1). It is not a sync command: the owner's
 * decision is that the real completion date and the original completer are kept, and only the
 * importer can write those, so it goes through the non-command write path with no completion
 * event in the activity log.
 */
export interface CompletedStep {
  args: Record<string, unknown>;
  mapping: { kind: MappingKind; externalId: string; localId: string };
  label: string;
  /** Todoist's own completion time. */
  completedAt: Date;
  /** Who completed it in Todoist, when that person is a BokyDo user; else null. */
  completedById: string | null;
}

export interface Plan {
  steps: PlannedStep[];
  completed: CompletedStep[];
  counts: TodoistImportCounts;
  warnings: TodoistImportWarning[];
}

const COLOR_SET = new Set<string>(COLORS);
const color = (c: string | null): Color | undefined =>
  c && COLOR_SET.has(c) ? (c as Color) : undefined;
const VIEW_STYLES = new Set(['list', 'board', 'calendar']);

// eslint-disable-next-line no-control-regex
const CONTROL_SINGLE = /[\u0000-\u001f\u007f]+/g;
// eslint-disable-next-line no-control-regex
const CONTROL_MULTI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** One line, at most `max` characters, never empty. */
function oneLine(value: string, max: number, fallback: string): { text: string; cut: boolean } {
  const clean = value.replace(CONTROL_SINGLE, ' ').replace(/\s+/g, ' ').trim();
  const text = clean.slice(0, max).trim() || fallback;
  return { text, cut: clean.length > max };
}

function multiLine(value: string, max: number): { text: string; cut: boolean } {
  const clean = value.replace(CONTROL_MULTI, '');
  return { text: clean.slice(0, max), cut: clean.length > max };
}

const byOrder = <T extends { order: number; id: string }>(a: T, b: T) =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Names a Todoist filter query mentions: `#Project`, `##Project`, `@label` (`\ ` escapes a space). */
export function filterReferences(query: string): { projects: string[]; labels: string[] } {
  const names = (re: RegExp) =>
    [...query.matchAll(re)].map((m) => (m[1] ?? '').replace(/\\(.)/g, '$1')).filter(Boolean);
  return {
    projects: [...new Set(names(/#{1,2}((?:\\.|[^\s&|()!,\\])+)/g))],
    labels: [...new Set(names(/@((?:\\.|[^\s&|()!,\\])+)/g))],
  };
}

export const isSupportedFilter = (query: string) => filterQuerySchema.safeParse(query).success;

export function planImport(input: PlanInput): Plan {
  const { snapshot: s, choices, imported } = input;
  const completedTasks = input.completed ?? [];
  const steps: PlannedStep[] = [];
  const completed: CompletedStep[] = [];
  const warnings: TodoistImportWarning[] = [];
  const counts: TodoistImportCounts = {
    projects: 0,
    merged: 0,
    sections: 0,
    tasks: 0,
    comments: 0,
    labels: 0,
    filters: 0,
    completedTasks: 0,
    completedAlreadyImported: 0,
    alreadyImported: 0,
  };
  const warn = (kind: TodoistImportWarning['kind'], message: string) =>
    warnings.push({ kind, message });

  /** Add a step if its arguments pass the command schema (they always should; never trust). */
  const step = (
    type: CommandType,
    args: Record<string, unknown>,
    mapping: PlannedStep['mapping'],
    label: string,
  ): boolean => {
    if (!commandArgs[type].safeParse(args).success) {
      warn('failed', `“${label}” could not be imported (it doesn't fit BokyDo's limits).`);
      return false;
    }
    steps.push({ type, args, mapping, label });
    return true;
  };

  // ---- labels (by name: tasks refer to labels by name, so they work even if not created) ----
  const wantedLabels = new Set(choices.labels);
  const comingLabels = new Set(input.labelNames); // lower-cased names that will exist afterwards
  for (const l of s.labels) {
    if (!wantedLabels.has(l.id)) continue;
    const valid = labelNameSchema.safeParse(l.name).success;
    if (valid) comingLabels.add(l.name.toLowerCase());
    if (!valid) {
      warn('label', `The label “${l.name}” has spaces, @ or #, which BokyDo labels can't have.`);
      continue;
    }
    if (input.labelNames.has(l.name.toLowerCase())) continue; // merged into the existing one
    const c = color(l.color);
    if (
      step(
        'label_add',
        { id: newId(), name: l.name, ...(c ? { color: c } : {}), isFavorite: l.isFavorite },
        null,
        l.name,
      )
    )
      counts.labels++;
  }

  // ---- projects, parents first ----
  const chosen = new Map(choices.projects.map((p) => [p.id, p]));
  const projectsById = new Map(s.projects.map((p) => [p.id, p]));
  const localProject = new Map<string, string>(); // Todoist project id → BokyDo project id
  const isNew = new Set<string>(); // BokyDo ids of projects created by this import
  const people = new Map(choices.people.map((p) => [p.id, p.userId]));
  people.set(s.user.id, input.userId); // the imported account is you

  const depthOf = (id: string): number => {
    let d = 0;
    for (let p = projectsById.get(id); p?.parentId && d < 10; p = projectsById.get(p.parentId)) d++;
    return d;
  };
  const ordered = s.projects
    .filter((p) => chosen.has(p.id))
    .sort((a, b) => depthOf(a.id) - depthOf(b.id) || byOrder(a, b));
  const newDepth = new Map<string, number>(); // depth of created projects within this import

  for (const p of ordered) {
    const choice = chosen.get(p.id);
    if (!choice) continue;
    const before = imported.get(mappingKey('project', p.id));
    if (before) {
      localProject.set(p.id, before);
      counts.alreadyImported++;
      continue;
    }
    if (choice.action === 'merge' && choice.targetId) {
      localProject.set(p.id, choice.targetId);
      // Remembered, so a re-run adds into the same project.
      steps.push({
        type: null,
        args: {},
        mapping: { kind: 'project', externalId: p.id, localId: choice.targetId },
        label: p.name,
      });
      counts.merged++;
      continue;
    }
    const id = newId();
    const name = oneLine(p.name, 120, 'Imported project');
    if (name.cut) warn('truncated', `The project name “${name.text}…” was shortened.`);
    // Under its parent if that came over as a new project too and nesting allows it.
    const parentLocal = p.parentId ? localProject.get(p.parentId) : undefined;
    const parentDepth =
      parentLocal && isNew.has(parentLocal) ? (newDepth.get(parentLocal) ?? 0) : null;
    let parentId: string | null = null;
    if (parentLocal && parentDepth !== null) {
      if (parentDepth + 1 < 3) parentId = parentLocal;
      else
        warn(
          'nesting',
          `“${name.text}” is nested too deeply for BokyDo and was placed at the top.`,
        );
    }
    const c = color(p.color);
    const args: Record<string, unknown> = {
      id,
      name: name.text,
      ...(parentId ? { parentId } : {}),
      ...(c ? { color: c } : {}),
      ...(p.viewStyle && VIEW_STYLES.has(p.viewStyle) ? { viewStyle: p.viewStyle } : {}),
      ...(p.isFavorite ? { isFavorite: true } : {}),
      ...(!parentId && choice.workspaceId ? { workspaceId: choice.workspaceId } : {}),
    };
    if (!step('project_add', args, { kind: 'project', externalId: p.id, localId: id }, name.text))
      continue;
    localProject.set(p.id, id);
    isNew.add(id);
    newDepth.set(id, parentId ? (newDepth.get(parentId) ?? 0) + 1 : 0);
    counts.projects++;
  }

  // ---- sections ----
  const localSection = new Map<string, string>();
  for (const sec of [...s.sections].sort(byOrder)) {
    const projectId = localProject.get(sec.projectId);
    if (!projectId) continue;
    const before = imported.get(mappingKey('section', sec.id));
    if (before) {
      localSection.set(sec.id, before);
      counts.alreadyImported++;
      continue;
    }
    const id = newId();
    const name = oneLine(sec.name, 120, 'Section');
    if (
      step(
        'section_add',
        { id, projectId, name: name.text },
        { kind: 'section', externalId: sec.id, localId: id },
        name.text,
      )
    ) {
      localSection.set(sec.id, id);
      counts.sections++;
    }
  }

  // ---- tasks, parents before children ----
  const tasksById = new Map(s.tasks.map((t) => [t.id, t]));
  const taskDepth = (t: TodoistTask): number => {
    let d = 0;
    for (let x = t; x.parentId && d < 20; d++) {
      const parent = tasksById.get(x.parentId);
      if (!parent) break;
      x = parent;
    }
    return d;
  };
  const localTask = new Map<string, string>();
  const tasks = s.tasks
    .filter((t) => localProject.has(t.projectId))
    .sort((a, b) => taskDepth(a) - taskDepth(b) || byOrder(a, b));
  let droppedAssignees = 0;
  for (const t of tasks) {
    const projectId = localProject.get(t.projectId);
    if (!projectId) continue;
    const before = imported.get(mappingKey('task', t.id));
    if (before) {
      localTask.set(t.id, before);
      counts.alreadyImported++;
      continue;
    }
    const parentLocal = t.parentId ? localTask.get(t.parentId) : undefined;
    if (t.parentId && !parentLocal && tasksById.has(t.parentId)) continue; // its parent failed
    const content = oneLine(t.content, 1000, '(untitled)');
    const description = multiLine(t.description, 16_000);
    if (content.cut || description.cut)
      warn('truncated', `“${content.text.slice(0, 80)}” was too long and was shortened.`);
    const labels = t.labels.filter((l) => labelNameSchema.safeParse(l).success);
    if (labels.length !== t.labels.length)
      warn('label', `“${content.text.slice(0, 80)}”: labels with spaces, @ or # were left off.`);
    let assigneeId: string | null = null;
    if (t.responsibleUid) {
      const userId = people.get(t.responsibleUid) ?? null;
      // A new project has only you as a member; a merged one keeps its own members.
      const allowed = isNew.has(projectId)
        ? userId === input.userId
        : userId !== null && (input.members.get(projectId)?.has(userId) ?? false);
      if (userId && allowed) assigneeId = userId;
      else droppedAssignees++;
    }
    const sectionId = !parentLocal && t.sectionId ? localSection.get(t.sectionId) : undefined;
    const id = newId();
    const due = t.due ? toDue(t.due, content.text, input.dates, warn) : null;
    const duration = durationMinutes(t);
    if (t.duration && duration === null)
      warn('duration', `“${content.text.slice(0, 80)}”: durations over a day aren't supported.`);
    const args: Record<string, unknown> = {
      id,
      projectId,
      ...(parentLocal ? { parentId: parentLocal } : {}),
      ...(sectionId ? { sectionId } : {}),
      content: content.text,
      ...(description.text ? { description: description.text } : {}),
      priority: 5 - Math.min(4, Math.max(1, t.priority)),
      ...(due ? { due } : {}),
      ...(t.deadline ? { deadline: t.deadline } : {}),
      ...(duration ? { durationMinutes: duration } : {}),
      ...(labels.length ? { labels: labels.slice(0, 50) } : {}),
      ...(assigneeId ? { assigneeId } : {}),
    };
    if (step('task_add', args, { kind: 'task', externalId: t.id, localId: id }, content.text)) {
      localTask.set(t.id, id);
      counts.tasks++;
    }
  }
  if (droppedAssignees)
    warn(
      'assignee',
      `${droppedAssignees} task${droppedAssignees === 1 ? '' : 's'} assigned to people who aren't in the BokyDo project will be unassigned (nobody is invited automatically).`,
    );

  // ---- completed tasks (opt-in): planned like open ones, written with their real history ----
  const completedLocal = new Map<string, string>();
  const completedById = new Map(completedTasks.map((t) => [t.id, t]));
  const completedParent = (t: TodoistCompletedTask): string | undefined =>
    t.parentId ? (localTask.get(t.parentId) ?? completedLocal.get(t.parentId)) : undefined;
  const orderedCompleted = completedTasks
    .filter((t) => localProject.has(t.projectId))
    .sort(
      (a, b) =>
        taskDepth(a as unknown as TodoistTask) - taskDepth(b as unknown as TodoistTask) ||
        byOrder(a, b),
    );
  let droppedCompletions = 0;
  for (const t of orderedCompleted) {
    const projectId = localProject.get(t.projectId);
    if (!projectId) continue;
    const before = imported.get(mappingKey('task', t.id));
    if (before) {
      completedLocal.set(t.id, before);
      counts.completedAlreadyImported++;
      continue;
    }
    if (t.parentId && !completedParent(t) && completedById.has(t.parentId)) continue; // its parent failed
    if (!hasCompletionDate(t)) {
      // Without Todoist's own completion time there is nothing to keep: never invent one.
      warn(
        'completed',
        `“${oneLine(t.content, 80, '(untitled)').text}” has no completion date on Todoist's side and was skipped.`,
      );
      continue;
    }
    const content = oneLine(t.content, 1000, '(untitled)');
    const description = multiLine(t.description, 16_000);
    if (content.cut || description.cut)
      warn('truncated', `“${content.text.slice(0, 80)}” was too long and was shortened.`);
    const labels = t.labels.filter((l) => labelNameSchema.safeParse(l).success);
    if (labels.length !== t.labels.length)
      warn('label', `“${content.text.slice(0, 80)}”: labels with spaces, @ or # were left off.`);
    let assigneeId: string | null = null;
    if (t.responsibleUid) {
      const userId = people.get(t.responsibleUid) ?? null;
      const allowed = isNew.has(projectId)
        ? userId === input.userId
        : userId !== null && (input.members.get(projectId)?.has(userId) ?? false);
      if (userId && allowed) assigneeId = userId;
      else droppedAssignees++;
    }
    // Who completed it: the original person when they are a BokyDo user, else left blank.
    const completer = t.completedByUid ? (people.get(t.completedByUid) ?? null) : null;
    if (t.completedByUid && !completer) droppedCompletions++;
    const parentLocal = completedParent(t);
    const sectionId = !parentLocal && t.sectionId ? localSection.get(t.sectionId) : undefined;
    const id = newId();
    const due = t.due ? toDue(t.due, content.text, input.dates, warn) : null;
    const duration = durationMinutes(t);
    if (t.duration && duration === null)
      warn('duration', `“${content.text.slice(0, 80)}”: durations over a day aren't supported.`);
    const args: Record<string, unknown> = {
      id,
      projectId,
      ...(parentLocal ? { parentId: parentLocal } : {}),
      ...(sectionId ? { sectionId } : {}),
      content: content.text,
      ...(description.text ? { description: description.text } : {}),
      priority: 5 - Math.min(4, Math.max(1, t.priority)),
      ...(due ? { due } : {}),
      ...(t.deadline ? { deadline: t.deadline } : {}),
      ...(duration ? { durationMinutes: duration } : {}),
      ...(labels.length ? { labels: labels.slice(0, 50) } : {}),
      ...(assigneeId ? { assigneeId } : {}),
      ...(completer ? { completedById: completer } : {}),
      completedAt: t.completedAt,
    };
    completed.push({
      args,
      mapping: { kind: 'task', externalId: t.id, localId: id },
      label: content.text,
      completedAt: t.completedAt,
      completedById: completer,
    });
    completedLocal.set(t.id, id);
    counts.completedTasks++;
  }
  if (droppedCompletions)
    warn(
      'completed',
      `${droppedCompletions} completed task${droppedCompletions === 1 ? ' was' : 's were'} finished by someone who isn't a BokyDo user here, so nothing will show who completed ${droppedCompletions === 1 ? 'it' : 'them'}.`,
    );

  // ---- comments ----
  if (choices.comments) {
    const names = new Map(s.people.map((p) => [p.id, p.name || p.email]));
    const sorted = [...s.comments].sort((a, b) =>
      (a.postedAt ?? '').localeCompare(b.postedAt ?? ''),
    );
    for (const c of sorted) {
      const target = c.taskId
        ? { taskId: localTask.get(c.taskId) }
        : { projectId: c.projectId ? localProject.get(c.projectId) : undefined };
      if (!target.taskId && !('projectId' in target && target.projectId)) continue;
      const before = imported.get(mappingKey('comment', c.id));
      if (before) {
        counts.alreadyImported++;
        continue;
      }
      const content = commentText(
        c,
        c.postedUid && c.postedUid !== s.user.id ? names.get(c.postedUid) : undefined,
      );
      if (!content) continue;
      const id = newId();
      const args = {
        id,
        ...(target.taskId
          ? { taskId: target.taskId }
          : { projectId: (target as { projectId: string }).projectId }),
        content,
      };
      if (
        step('comment_add', args, { kind: 'comment', externalId: c.id, localId: id }, 'a comment')
      )
        counts.comments++;
    }
  }

  // ---- saved filters ----
  const wantedFilters = new Set(choices.filters);
  const importedProjectNames = new Set(
    s.projects.filter((p) => localProject.has(p.id)).map((p) => p.name.toLowerCase()),
  );
  for (const f of [...s.filters].sort(byOrder)) {
    if (!wantedFilters.has(f.id)) continue;
    if (imported.get(mappingKey('filter', f.id))) {
      counts.alreadyImported++;
      continue;
    }
    const name = oneLine(f.name, 120, 'Imported filter');
    if (!isSupportedFilter(f.query)) {
      warn(
        'filter',
        `The filter “${name.text}” uses syntax BokyDo doesn't understand: ${f.query.slice(0, 200)}`,
      );
      continue;
    }
    const refs = filterReferences(f.query);
    const missingProjects = refs.projects.filter((p) => !importedProjectNames.has(p.toLowerCase()));
    const missingLabels = refs.labels.filter((l) => !comingLabels.has(l.toLowerCase()));
    if (missingProjects.length || missingLabels.length)
      warn(
        'filter',
        `The filter “${name.text}” mentions ${[...missingProjects.map((p) => `#${p}`), ...missingLabels.map((l) => `@${l}`)].join(', ')}, which won't be in BokyDo; it is imported anyway.`,
      );
    const id = newId();
    const c = color(f.color);
    if (
      step(
        'filter_add',
        {
          id,
          name: name.text,
          query: f.query,
          ...(c ? { color: c } : {}),
          isFavorite: f.isFavorite,
        },
        { kind: 'filter', externalId: f.id, localId: id },
        name.text,
      )
    )
      counts.filters++;
  }

  return { steps, completed, counts, warnings };
}

function durationMinutes(t: TodoistTask): number | null {
  if (!t.duration) return null;
  const minutes = t.duration.unit === 'day' ? t.duration.amount * 1440 : t.duration.amount;
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null;
}

/** Todoist's date, kept as it is; recurrence re-read from the phrase with BokyDo's parser. */
function toDue(
  d: TodoistDue,
  task: string,
  dates: PlanInput['dates'],
  warn: (kind: TodoistImportWarning['kind'], message: string) => void,
): Due {
  let timezone: string | null = null;
  if (d.time && d.timezone) {
    if (isKnownTimeZone(d.timezone)) timezone = d.timezone;
    else
      warn(
        'timezone',
        `“${task.slice(0, 80)}”: the time zone “${d.timezone}” isn't known here, so the time floats.`,
      );
  }
  const phrase = oneLine(d.string || d.date, 200, d.date).text;
  let recurrence: Due['recurrence'] = null;
  if (d.isRecurring) {
    const parsed = parseDate(phrase, {
      now: dates.now,
      weekStart: dates.weekStart,
      dateOrder: dates.dateOrder,
    });
    if (parsed?.recurrence) recurrence = parsed.recurrence;
    else
      warn(
        'recurrence',
        `“${task.slice(0, 80)}” repeats “${phrase}”, which BokyDo can't read; it comes over as a one-off date.`,
      );
  }
  return { date: d.date, time: d.time, timezone, string: phrase, recurrence };
}

function commentText(c: TodoistComment, author: string | undefined): string {
  const parts: string[] = [];
  if (author)
    parts.push(
      `**${author.replace(/[*_`[\]]/g, '')}**${c.postedAt ? ` (${c.postedAt.slice(0, 10)})` : ''}:`,
    );
  if (c.content.trim()) parts.push(c.content);
  if (c.attachment) {
    const url = c.attachment.url && /^https:\/\//.test(c.attachment.url) ? c.attachment.url : null;
    const name = c.attachment.name.replace(/[[\]]/g, '');
    parts.push(url ? `📎 [${name}](${url})` : `📎 ${name} (attachment not imported)`);
  }
  return multiLine(parts.join('\n\n'), 15_000).text.trim();
}
