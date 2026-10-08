import { TODOIST_IMPORT_LIMITS as LIMITS } from '@bokydo/shared';
import { z } from 'zod';
import { OutboundError, type OutboundFetch } from '../net/outbound.js';

/**
 * Reading a Todoist account (PLAN W11a). One Sync API request (`POST /api/v1/sync`, full sync)
 * through the public-only outbound client. The answer is untrusted input: it is validated here,
 * bounded, and normalised into a snapshot; nothing else in the importer sees Todoist's wire
 * format. Field names follow Todoist API v1 as described by Doist's own SDK (@doist/todoist-sdk).
 */
export const TODOIST_SYNC_URL = 'https://api.todoist.com/api/v1/sync';
const RESOURCE_TYPES = [
  'user',
  'projects',
  'sections',
  'items',
  'notes',
  'project_notes',
  'labels',
  'filters',
  'collaborators',
] as const;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export type TodoistErrorReason = 'unauthorized' | 'unavailable' | 'too_large' | 'invalid_response';

export class TodoistError extends Error {
  constructor(readonly reason: TodoistErrorReason) {
    super(`Todoist import: ${reason}`);
    this.name = 'TodoistError';
  }
}

// Todoist ids are opaque strings (numeric in older accounts, alphanumeric since v1).
const tid = z.string().min(1).max(64);
const str = (max: number) => z.string().max(max);
const flag = z.boolean().nullish();

const dueWire = z
  .object({
    date: z.string().max(40),
    datetime: z.string().max(40).nullish(),
    timezone: z.string().max(64).nullish(),
    string: z.string().max(500).nullish(),
    is_recurring: flag,
  })
  .loose();

const projectWire = z
  .object({
    id: tid,
    name: str(2000),
    color: str(40).nullish(),
    parent_id: tid.nullish(),
    child_order: z.number().nullish(),
    view_style: str(40).nullish(),
    is_favorite: flag,
    is_archived: flag,
    is_deleted: flag,
    is_shared: flag,
    inbox_project: flag,
  })
  .loose();

const sectionWire = z
  .object({
    id: tid,
    project_id: tid,
    name: str(2000),
    section_order: z.number().nullish(),
    is_archived: flag,
    is_deleted: flag,
  })
  .loose();

const itemWire = z
  .object({
    id: tid,
    project_id: tid,
    section_id: tid.nullish(),
    parent_id: tid.nullish(),
    content: str(100_000),
    description: str(100_000).nullish(),
    priority: z.number().int().min(1).max(4).nullish(),
    labels: z.array(str(500)).max(500).nullish(),
    due: dueWire.nullish(),
    deadline: z
      .object({ date: z.string().max(40) })
      .loose()
      .nullish(),
    duration: z
      .object({ amount: z.number(), unit: z.enum(['minute', 'day']) })
      .loose()
      .nullish(),
    responsible_uid: tid.nullish(),
    child_order: z.number().nullish(),
    checked: flag,
    is_deleted: flag,
  })
  .loose();

const noteWire = z
  .object({
    id: tid,
    item_id: tid.nullish(),
    project_id: tid.nullish(),
    content: str(100_000).nullish(),
    posted_at: z.string().max(40).nullish(),
    posted_uid: tid.nullish(),
    is_deleted: flag,
    file_attachment: z
      .object({ file_name: str(1000).nullish(), file_url: str(4000).nullish() })
      .loose()
      .nullish(),
  })
  .loose();

const labelWire = z
  .object({
    id: tid,
    name: str(2000),
    color: str(40).nullish(),
    item_order: z.number().nullish(),
    is_favorite: flag,
    is_deleted: flag,
  })
  .loose();

const filterWire = z
  .object({
    id: tid,
    name: str(2000),
    query: str(10_000),
    color: str(40).nullish(),
    item_order: z.number().nullish(),
    is_favorite: flag,
    is_deleted: flag,
  })
  .loose();

const collaboratorWire = z
  .object({ id: tid, full_name: str(1000).nullish(), email: str(1000).nullish() })
  .loose();

const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max).nullish();

const syncWire = z
  .object({
    user: z.object({ id: tid, full_name: str(1000).nullish(), email: str(1000).nullish() }).loose(),
    projects: list(projectWire, LIMITS.projects),
    sections: list(sectionWire, LIMITS.sections),
    items: list(itemWire, LIMITS.tasks),
    notes: list(noteWire, LIMITS.comments),
    project_notes: list(noteWire, LIMITS.comments),
    labels: list(labelWire, LIMITS.labels),
    filters: list(filterWire, LIMITS.filters),
    collaborators: list(collaboratorWire, LIMITS.collaborators),
  })
  .loose();

// ---- the normalised snapshot (what the planner works on) ----

export interface TodoistDue {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, or null for an all-day date. */
  time: string | null;
  /** IANA zone for a fixed-zone time; null = floating. */
  timezone: string | null;
  /** The phrase as the user wrote it ("every mon 9am"). */
  string: string;
  isRecurring: boolean;
}

export interface TodoistProject {
  id: string;
  name: string;
  color: string | null;
  parentId: string | null;
  order: number;
  viewStyle: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  isShared: boolean;
  isInbox: boolean;
}

export interface TodoistSection {
  id: string;
  projectId: string;
  name: string;
  order: number;
}

export interface TodoistTask {
  id: string;
  projectId: string;
  sectionId: string | null;
  parentId: string | null;
  content: string;
  description: string;
  /** Todoist's API numbering: 4 is the most urgent (shown as p1). */
  priority: number;
  labels: string[];
  due: TodoistDue | null;
  deadline: string | null;
  duration: { amount: number; unit: 'minute' | 'day' } | null;
  responsibleUid: string | null;
  order: number;
}

export interface TodoistComment {
  id: string;
  taskId: string | null;
  projectId: string | null;
  content: string;
  postedAt: string | null;
  postedUid: string | null;
  attachment: { name: string; url: string | null } | null;
}

export interface TodoistLabel {
  id: string;
  name: string;
  color: string | null;
  order: number;
  isFavorite: boolean;
}

export interface TodoistFilter {
  id: string;
  name: string;
  query: string;
  color: string | null;
  order: number;
  isFavorite: boolean;
}

export interface TodoistSnapshot {
  user: { id: string; name: string; email: string };
  projects: TodoistProject[];
  sections: TodoistSection[];
  tasks: TodoistTask[];
  comments: TodoistComment[];
  labels: TodoistLabel[];
  filters: TodoistFilter[];
  people: { id: string; name: string; email: string }[];
}

/** Read the whole account. The token is used for this request only; callers must not keep it. */
export async function fetchTodoistSnapshot(
  fetch: OutboundFetch,
  token: string,
  signal?: AbortSignal,
): Promise<TodoistSnapshot> {
  let res;
  try {
    res = await fetch(TODOIST_SYNC_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ sync_token: '*', resource_types: RESOURCE_TYPES }),
      timeoutMs: 120_000,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof OutboundError && err.reason === 'too_large')
      throw new TodoistError('too_large');
    throw new TodoistError('unavailable');
  }
  if (res.status === 401 || res.status === 403) {
    res.cancel();
    throw new TodoistError('unauthorized');
  }
  if (res.status !== 200) {
    res.cancel();
    throw new TodoistError('unavailable');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    if (err instanceof OutboundError && err.reason === 'too_large')
      throw new TodoistError('too_large');
    throw new TodoistError('invalid_response');
  }
  return normalise(body);
}

/** Validate a full-sync answer and keep only live items, in a shape the planner can trust. */
export function normalise(body: unknown): TodoistSnapshot {
  const parsed = syncWire.safeParse(body);
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some((i) => i.code === 'too_big' && i.origin === 'array');
    throw new TodoistError(tooMany ? 'too_large' : 'invalid_response');
  }
  const w = parsed.data;
  const live = <T extends { is_deleted?: boolean | null | undefined }>(
    xs: T[] | null | undefined,
  ) => (xs ?? []).filter((x) => !x.is_deleted);

  const projects = live(w.projects).map((p): TodoistProject => ({
    id: p.id,
    name: p.name,
    color: p.color ?? null,
    parentId: p.parent_id ?? null,
    order: p.child_order ?? 0,
    viewStyle: p.view_style ?? null,
    isFavorite: !!p.is_favorite,
    isArchived: !!p.is_archived,
    isShared: !!p.is_shared,
    isInbox: !!p.inbox_project,
  }));
  const projectIds = new Set(projects.map((p) => p.id));
  const sections = live(w.sections)
    .filter((s) => projectIds.has(s.project_id) && !s.is_archived)
    .map((s): TodoistSection => ({
      id: s.id,
      projectId: s.project_id,
      name: s.name,
      order: s.section_order ?? 0,
    }));
  const tasks = live(w.items)
    .filter((t) => projectIds.has(t.project_id) && !t.checked)
    .map((t): TodoistTask => ({
      id: t.id,
      projectId: t.project_id,
      sectionId: t.section_id ?? null,
      parentId: t.parent_id ?? null,
      content: t.content,
      description: t.description ?? '',
      priority: t.priority ?? 1,
      labels: t.labels ?? [],
      due: t.due ? toDue(t.due) : null,
      deadline: t.deadline && /^\d{4}-\d{2}-\d{2}$/.test(t.deadline.date) ? t.deadline.date : null,
      duration: t.duration ? { amount: t.duration.amount, unit: t.duration.unit } : null,
      responsibleUid: t.responsible_uid ?? null,
      order: t.child_order ?? 0,
    }));
  const comments = [...live(w.notes), ...live(w.project_notes)].map((n): TodoistComment => ({
    id: n.id,
    taskId: n.item_id ?? null,
    projectId: n.item_id ? null : (n.project_id ?? null),
    content: n.content ?? '',
    postedAt: n.posted_at ?? null,
    postedUid: n.posted_uid ?? null,
    attachment: n.file_attachment
      ? {
          name: n.file_attachment.file_name ?? 'attachment',
          url: n.file_attachment.file_url ?? null,
        }
      : null,
  }));
  const labels = live(w.labels).map((l): TodoistLabel => ({
    id: l.id,
    name: l.name,
    color: l.color ?? null,
    order: l.item_order ?? 0,
    isFavorite: !!l.is_favorite,
  }));
  const filters = live(w.filters).map((f): TodoistFilter => ({
    id: f.id,
    name: f.name,
    query: f.query,
    color: f.color ?? null,
    order: f.item_order ?? 0,
    isFavorite: !!f.is_favorite,
  }));
  const user = {
    id: w.user.id,
    name: w.user.full_name ?? '',
    email: w.user.email ?? '',
  };
  const people = new Map<string, { id: string; name: string; email: string }>();
  people.set(user.id, user);
  for (const c of w.collaborators ?? [])
    if (!people.has(c.id))
      people.set(c.id, { id: c.id, name: c.full_name ?? '', email: c.email ?? '' });
  return {
    user,
    projects,
    sections,
    tasks,
    comments,
    labels,
    filters,
    people: [...people.values()],
  };
}

/**
 * Todoist dates: `date` is YYYY-MM-DD, or a floating local time YYYY-MM-DDTHH:MM:SS, or (with a
 * `timezone`) a UTC instant ending in Z; newer answers may carry the time in `datetime` instead.
 */
function toDue(d: z.output<typeof dueWire>): TodoistDue | null {
  const raw = d.datetime ?? d.date;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z)?)?$/.exec(raw);
  if (!m?.[1]) return null;
  let date = m[1];
  let time = m[2] && m[3] ? `${m[2]}:${m[3]}` : null;
  let timezone = d.timezone ?? null;
  if (m[4] && time) {
    // A UTC instant: shown in its own zone (or UTC if Todoist didn't say which).
    const local = utcToZone(`${date}T${time}:00Z`, timezone ?? 'UTC');
    if (!local) return null;
    ({ date, time } = local);
    timezone ??= 'UTC';
  }
  if (!time) timezone = null;
  return {
    date,
    time,
    timezone,
    string: (d.string ?? '').trim(),
    isRecurring: !!d.is_recurring,
  };
}

function utcToZone(iso: string, timeZone: string): { date: string; time: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      time: `${get('hour')}:${get('minute')}`,
    };
  } catch {
    return null;
  }
}
