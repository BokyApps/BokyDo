import type { LocalNow, WeekStart } from '@bokydo/nlp';
import { matcher, parseFilter, resolveFilter } from './index.js';
import type { Catalog, FilterTask } from './evaluate.js';

/**
 * Saved filters for the Android app (A2c), which runs this package in the JavaScript sandbox
 * (the same one the quick-add parser uses, ADR 0016): JSON in, JSON out, so nothing but
 * strings crosses the boundary. The parser and the evaluator are the web's own, so a filter
 * saved on the web behaves the same on the phone.
 */

export interface FilterInput {
  /** The filter text, e.g. "today | overdue". */
  query: string;
  /** The user's local date and time. */
  now: LocalNow;
  weekStart?: WeekStart;
  dateOrder?: 'dmy' | 'mdy' | 'ymd';
  /** The user's time zone (for `created:` terms). */
  timeZone?: string;
  userId?: string;
  /** The tasks to match, each with its `id`. */
  tasks: (FilterTask & { id: string })[];
  projects: Catalog['projects'];
  sections: Catalog['sections'];
  users?: Catalog['users'];
  sharedProjectIds?: string[];
  workspaces?: Catalog['workspaces'];
}

export interface FilterList {
  /** The list's own text (a comma in the query gives several lists). */
  query: string;
  /** The ids of the tasks that match, in the order they were given. */
  taskIds: string[];
}

export interface FilterOutput {
  ok: boolean;
  lists?: FilterList[];
  warnings?: string[];
  /** Why the filter doesn't work (only when `ok` is false). */
  error?: string;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

/** A task as the evaluator wants it; a missing creation date would break `Intl`. */
function toFilterTask(t: Record<string, unknown>): FilterTask {
  const due = t.due as Record<string, unknown> | null | undefined;
  const recurrence = due ? (due.recurrence ?? null) : null;
  return {
    projectId: String(t.projectId ?? ''),
    sectionId: (t.sectionId as string | null) ?? null,
    parentId: (t.parentId as string | null) ?? null,
    content: String(t.content ?? ''),
    priority: Number(t.priority ?? 4),
    due: due
      ? {
          date: String(due.date ?? ''),
          time: (due.time as string | null) ?? null,
          recurrence,
        }
      : null,
    deadline: (t.deadline as string | null) ?? null,
    labels: Array.isArray(t.labels) ? (t.labels as string[]) : [],
    assigneeId: (t.assigneeId as string | null) ?? null,
    assignedById: (t.assignedById as string | null) ?? null,
    createdAt: typeof t.createdAt === 'string' && t.createdAt ? t.createdAt : EPOCH,
  };
}

/**
 * Run a filter over the given tasks. Never throws: a filter that doesn't parse comes back as
 * `{ ok: false, error }` so the app can show the message.
 */
export function filterJson(json: string): string {
  let input: FilterInput;
  try {
    input = JSON.parse(json) as FilterInput;
  } catch {
    return JSON.stringify({ ok: false, error: 'The filter could not be read' });
  }
  if (!input || typeof input.query !== 'string' || !input.now) {
    return JSON.stringify({ ok: false, error: 'The filter is incomplete' });
  }
  return JSON.stringify(runFilter(input));
}

/** The filter itself: parse, resolve the names, then match every task. */
export function runFilter(input: FilterInput): FilterOutput {
  const parsed = parseFilter(input.query, {
    now: input.now,
    weekStart: input.weekStart ?? 'monday',
    dateOrder: input.dateOrder ?? 'dmy',
  });
  if (!parsed.ok) return { ok: false, error: parsed.error.message };
  const resolution = resolveFilter(parsed.queries, {
    projects: input.projects ?? [],
    sections: input.sections ?? [],
    users: input.users ?? [],
    sharedProjectIds: new Set(input.sharedProjectIds ?? []),
    workspaces: input.workspaces ?? [],
  });
  const tasks = (input.tasks ?? []).map((t) => ({
    id: String((t as unknown as Record<string, unknown>).id ?? ''),
    task: toFilterTask(t as unknown as Record<string, unknown>),
  }));
  const userId = input.userId ?? '';
  const timeZone = input.timeZone ?? 'UTC';
  const lists = resolution.queries.map((q) => {
    const match = matcher(q.node, { now: input.now, userId, timeZone });
    return { query: q.text, taskIds: tasks.filter((t) => match(t.task)).map((t) => t.id) };
  });
  return { ok: true, lists, warnings: resolution.warnings };
}
