import { localNow, parseDate, parseQuickAdd, type QuickAddOptions } from '@bokydo/nlp';
import { resolvePreferences, type ApiScope, type CommandType, type Task } from '@bokydo/shared';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  comments,
  filters,
  labels,
  projectMembers,
  projects,
  sections,
  tasks,
  users,
} from '../db/schema.js';
import { taskToWire } from '../sync/serialize.js';
import { visibleProjects, type ProjectScope } from '../sync/policy.js';
import type { SyncService } from '../sync/sync-service.js';
import { runFilter } from '../tasks/filter-sql.js';
import { searchTasks } from '../tasks/routes.js';

/** Everything a tool may use. The user and their scopes come from the verified token. */
export interface ToolContext {
  db: Database;
  sync: SyncService;
  userId: string;
  scopes: readonly ApiScope[];
  /** The projects a project-limited token may reach; null = all the user can see. */
  projectIds: ProjectScope;
  baseUrl: string;
  defaultTimeZone: string;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** The token needs every one of these. */
  scopes: readonly ApiScope[];
  /** Reads account-wide data, so it isn't offered to a project-limited token. */
  accountWide?: true;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: false;
  };
  args: z.ZodType;
  run(ctx: ToolContext, args: never): Promise<unknown>;
}

/** A tool failed in a way the model should see (not a protocol error). */
export class ToolError extends Error {}

const WRITABLE = new Set(['owner', 'admin', 'editor']);
const id = z.uuid();
const limit = z.number().int().min(1).max(100).default(30);

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const ADD = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const CHANGE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// ---- helpers ----

async function projectIndex(ctx: ToolContext) {
  const visible = await ctx.db.transaction((tx) => visibleProjects(tx, ctx.userId, ctx.projectIds));
  const ids = [...visible.keys()];
  const rows = ids.length
    ? await ctx.db
        .select({
          id: projects.id,
          name: projects.name,
          parentId: projects.parentId,
          isInbox: projects.isInbox,
          isArchived: projects.isArchived,
        })
        .from(projects)
        .where(and(inArray(projects.id, ids), isNull(projects.deletedAt)))
    : [];
  return new Map(
    rows.map((r) => [r.id, { ...r, role: visible.get(r.id)?.role ?? 'viewer' }] as const),
  );
}

type ProjectIndex = Awaited<ReturnType<typeof projectIndex>>;

/** The shape tools return for a task: compact, with a link back to the app. */
function present(ctx: ToolContext, t: Task, index: ProjectIndex) {
  return {
    id: t.id,
    content: t.content,
    description: t.description || undefined,
    project: { id: t.projectId, name: index.get(t.projectId)?.name ?? null },
    sectionId: t.sectionId,
    parentId: t.parentId,
    due: t.due
      ? { date: t.due.date, time: t.due.time, text: t.due.string, recurring: !!t.due.recurrence }
      : null,
    deadline: t.deadline,
    priority: `p${t.priority}`,
    labels: t.labels,
    completed: t.isCompleted,
    url: `${ctx.baseUrl}/task/${t.id}`,
  };
}

async function visibleTask(ctx: ToolContext, taskId: string) {
  const index = await projectIndex(ctx);
  const [row] = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)));
  // Same answer for "doesn't exist" and "not yours": no probing other people's IDs.
  if (!row || !index.has(row.projectId)) throw new ToolError('Task not found');
  return { task: taskToWire(row), index };
}

async function preferences(ctx: ToolContext) {
  const [row] = await ctx.db
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, ctx.userId));
  const prefs = resolvePreferences(row?.preferences);
  return { prefs, now: localNow(prefs.timezone ?? ctx.defaultTimeZone) };
}

/** Writes go through the sync engine: the same permission checks and history as the app. */
async function command(ctx: ToolContext, type: CommandType, args: Record<string, unknown>) {
  const result = await ctx.sync.apply(ctx.userId, type, newId(), args as never, ctx.projectIds);
  if (!result.ok)
    throw new ToolError(`Not done: ${result.error}${result.message ? ` (${result.message})` : ''}`);
}

// ---- tools ----

const searchArgs = z.object({ query: z.string().min(1).max(200), limit }).strict();
const filterArgs = z.object({ query: z.string().min(1).max(1000), limit }).strict();
const taskArgs = z.object({ id }).strict();
const addArgs = z
  .object({
    text: z.string().trim().min(1).max(1000),
    description: z.string().max(16_000).optional(),
    projectId: id.optional(),
  })
  .strict();
const updateArgs = z
  .object({
    id,
    content: z.string().trim().min(1).max(1000).optional(),
    description: z.string().max(16_000).optional(),
    due: z.string().max(200).nullable().optional(),
    priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
    labels: z.array(z.string().min(1).max(60)).max(50).optional(),
  })
  .strict();
const commentArgs = z
  .object({ taskId: id, content: z.string().trim().min(1).max(15_000) })
  .strict();
const noArgs = z.object({}).strict();

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const limitProp = { type: 'integer', minimum: 1, maximum: 100, description: 'Default 30' };

export const TOOLS: ToolDefinition[] = [
  {
    name: 'search_tasks',
    title: 'Search tasks',
    description: 'Full-text search over the tasks the user can see (open tasks first).',
    scopes: ['tasks:read'],
    inputSchema: schema({ query: { type: 'string' }, limit: limitProp }, ['query']),
    annotations: READ,
    args: searchArgs,
    run: async (ctx, a: z.output<typeof searchArgs>) => {
      const index = await projectIndex(ctx);
      const found = await searchTasks(ctx.db, ctx.userId, a.query, a.limit, ctx.projectIds);
      return { tasks: found.map((t) => present(ctx, t, index)) };
    },
  },
  {
    name: 'run_filter',
    title: 'Run a filter',
    description:
      'List open tasks matching a BokyDo/Todoist filter query, e.g. "today | overdue", "#Work & p1", "7 days & @errand". "|" separates independent lists.',
    scopes: ['tasks:read'],
    inputSchema: schema({ query: { type: 'string' }, limit: limitProp }, ['query']),
    annotations: READ,
    args: filterArgs,
    run: async (ctx, a: z.output<typeof filterArgs>) => {
      const index = await projectIndex(ctx);
      const result = await ctx.db.transaction((tx) =>
        runFilter(tx, ctx.userId, a.query, {
          limit: a.limit,
          defaultTimeZone: ctx.defaultTimeZone,
          scope: ctx.projectIds,
        }),
      );
      if (!result.ok) throw new ToolError(`Invalid filter: ${result.error.message}`);
      return {
        lists: result.lists.map((l) => ({
          query: l.query,
          tasks: l.tasks.map((t) => present(ctx, t, index)),
        })),
        warnings: result.warnings,
      };
    },
  },
  {
    name: 'get_task',
    title: 'Get a task',
    description: 'One task with its sub-tasks and, with comment access, its latest comments.',
    scopes: ['tasks:read'],
    inputSchema: schema({ id: { type: 'string', format: 'uuid' } }, ['id']),
    annotations: READ,
    args: taskArgs,
    run: async (ctx, a: z.output<typeof taskArgs>) => {
      const { task, index } = await visibleTask(ctx, a.id);
      const children = await ctx.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.parentId, task.id), isNull(tasks.deletedAt)))
        .orderBy(asc(tasks.childOrder))
        .limit(100);
      const notes = ctx.scopes.includes('comments:read')
        ? await ctx.db
            .select({
              id: comments.id,
              content: comments.content,
              at: comments.createdAt,
              author: users.username,
            })
            .from(comments)
            .leftJoin(users, eq(users.id, comments.userId))
            .where(and(eq(comments.taskId, task.id), isNull(comments.deletedAt)))
            .orderBy(desc(comments.createdAt))
            .limit(30)
        : null;
      return {
        task: present(ctx, task, index),
        subtasks: children.map((c) => present(ctx, taskToWire(c), index)),
        ...(notes
          ? {
              comments: notes.map((n) => ({
                id: n.id,
                author: n.author,
                at: n.at.toISOString(),
                content: n.content,
              })),
            }
          : {}),
      };
    },
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description:
      'Projects the user can see, with their role (owner, admin, editor, commenter, viewer).',
    scopes: ['projects:read'],
    inputSchema: schema({}),
    annotations: READ,
    args: noArgs,
    run: async (ctx) => {
      const index = await projectIndex(ctx);
      return {
        projects: [...index.values()]
          .filter((p) => !p.isArchived)
          .map((p) => ({
            id: p.id,
            name: p.name,
            parentId: p.parentId,
            inbox: p.isInbox,
            role: p.role,
          })),
      };
    },
  },
  {
    name: 'list_filters',
    title: 'List saved filters',
    description: "The user's saved filters (use run_filter with a filter's query).",
    scopes: ['projects:read'],
    accountWide: true,
    inputSchema: schema({}),
    annotations: READ,
    args: noArgs,
    run: async (ctx) => {
      const rows = await ctx.db
        .select({ id: filters.id, name: filters.name, query: filters.query })
        .from(filters)
        .where(and(eq(filters.userId, ctx.userId), isNull(filters.deletedAt)))
        .orderBy(asc(filters.itemOrder));
      return { filters: rows };
    },
  },
  {
    name: 'get_report',
    title: 'Overview',
    description:
      'Overdue, today and next-7-days tasks, and how many were completed in the last 7 days.',
    scopes: ['tasks:read'],
    inputSchema: schema({}),
    annotations: READ,
    args: noArgs,
    run: async (ctx) => {
      const index = await projectIndex(ctx);
      // One query each: a combined `a | b | c` filter leaves out empty lists.
      const list = async (query: string) => {
        const result = await ctx.db.transaction((tx) =>
          runFilter(tx, ctx.userId, query, {
            limit: 50,
            defaultTimeZone: ctx.defaultTimeZone,
            scope: ctx.projectIds,
          }),
        );
        if (!result.ok) throw new ToolError('Report unavailable');
        return (result.lists[0]?.tasks ?? []).map((t) => present(ctx, t, index));
      };
      const overdue = await list('overdue');
      const today = await list('today & !overdue');
      const upcoming = await list('7 days & !today & !overdue');
      const ids = [...index.keys()];
      const done = ids.length
        ? await ctx.db
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                inArray(tasks.projectId, ids),
                eq(tasks.isCompleted, true),
                gt(tasks.completedAt, new Date(Date.now() - 7 * 86_400_000)),
                isNull(tasks.deletedAt),
              ),
            )
        : [];
      return { overdue, today, next7Days: upcoming, completedLast7Days: done.length };
    },
  },
  {
    name: 'add_task',
    title: 'Add a task',
    description:
      'Add a task from natural language, like the app\'s quick add: "Call Ana tomorrow 3pm #Work p1 @phone". Dates, #project, /section, @labels and p1–p4 are recognised; without #project it goes to the Inbox (or projectId).',
    scopes: ['tasks:write'],
    inputSchema: schema(
      {
        text: { type: 'string' },
        description: { type: 'string' },
        projectId: { type: 'string', format: 'uuid' },
      },
      ['text'],
    ),
    annotations: ADD,
    args: addArgs,
    run: async (ctx, a: z.output<typeof addArgs>) => {
      const index = await projectIndex(ctx);
      const writable = [...index.values()].filter((p) => WRITABLE.has(p.role) && !p.isArchived);
      if (a.projectId && !writable.some((p) => p.id === a.projectId))
        throw new ToolError('You can’t add tasks to that project');
      const { prefs, now } = await preferences(ctx);
      const writableIds = writable.map((p) => p.id);
      const [sectionRows, labelRows, memberRows] = await Promise.all([
        writableIds.length
          ? ctx.db
              .select({ id: sections.id, name: sections.name, projectId: sections.projectId })
              .from(sections)
              .where(and(inArray(sections.projectId, writableIds), isNull(sections.deletedAt)))
          : [],
        ctx.db
          .select({ name: labels.name })
          .from(labels)
          .where(and(eq(labels.userId, ctx.userId), isNull(labels.deletedAt))),
        writableIds.length
          ? ctx.db
              .select({ id: users.id, name: users.username, projectId: projectMembers.projectId })
              .from(projectMembers)
              .innerJoin(users, eq(users.id, projectMembers.userId))
              .where(inArray(projectMembers.projectId, writableIds))
          : [],
      ]);
      const options: QuickAddOptions = {
        now,
        weekStart: prefs.weekStart,
        dateOrder: prefs.dateFormat,
        smartDates: true,
        projects: writable.map((p) => ({ id: p.id, name: p.name })),
        sections: sectionRows,
        labels: labelRows.map((l) => l.name),
        members: memberRows,
        defaultProjectId: a.projectId ?? null,
      };
      const parsed = parseQuickAdd(a.text, options);
      const taskId = newId();
      const projectId = parsed.projectId ?? a.projectId;
      await command(ctx, 'task_add', {
        id: taskId,
        content: parsed.content.trim() || a.text,
        ...(projectId ? { projectId } : {}),
        ...(parsed.sectionId ? { sectionId: parsed.sectionId } : {}),
        ...(a.description ? { description: a.description } : {}),
        ...(parsed.due ? { due: parsed.due } : {}),
        ...(parsed.deadline ? { deadline: parsed.deadline } : {}),
        ...(parsed.priority ? { priority: parsed.priority } : {}),
        ...(parsed.labels.length ? { labels: parsed.labels } : {}),
        ...(parsed.durationMinutes ? { durationMinutes: parsed.durationMinutes } : {}),
        ...(parsed.assigneeId ? { assigneeId: parsed.assigneeId } : {}),
      });
      const { task, index: after } = await visibleTask(ctx, taskId);
      return { task: present(ctx, task, after) };
    },
  },
  {
    name: 'update_task',
    title: 'Update a task',
    description:
      'Change a task’s title, description, due date (natural language like "next fri 9am" or "every monday"; null removes it), priority or labels (replaces them).',
    scopes: ['tasks:write'],
    inputSchema: schema(
      {
        id: { type: 'string', format: 'uuid' },
        content: { type: 'string' },
        description: { type: 'string' },
        due: { type: ['string', 'null'] },
        priority: { type: 'string', enum: ['p1', 'p2', 'p3', 'p4'] },
        labels: { type: 'array', items: { type: 'string' } },
      },
      ['id'],
    ),
    annotations: CHANGE,
    args: updateArgs,
    run: async (ctx, a: z.output<typeof updateArgs>) => {
      await visibleTask(ctx, a.id);
      const patch: Record<string, unknown> = { id: a.id };
      if (a.content !== undefined) patch.content = a.content;
      if (a.description !== undefined) patch.description = a.description;
      if (a.priority !== undefined) patch.priority = Number(a.priority.slice(1));
      if (a.labels !== undefined) patch.labels = a.labels;
      if (a.due === null) patch.due = null;
      else if (a.due !== undefined) {
        const { prefs, now } = await preferences(ctx);
        const due = parseDate(a.due, {
          now,
          weekStart: prefs.weekStart,
          dateOrder: prefs.dateFormat,
        });
        if (!due) throw new ToolError(`Couldn't understand the date "${a.due}"`);
        patch.due = due;
      }
      if (Object.keys(patch).length === 1) throw new ToolError('Nothing to change');
      await command(ctx, 'task_update', patch);
      const { task, index } = await visibleTask(ctx, a.id);
      return { task: present(ctx, task, index) };
    },
  },
  {
    name: 'complete_task',
    title: 'Complete a task',
    description: 'Mark a task done (a recurring task moves to its next date instead).',
    scopes: ['tasks:write'],
    inputSchema: schema({ id: { type: 'string', format: 'uuid' } }, ['id']),
    annotations: { ...CHANGE, destructiveHint: false },
    args: taskArgs,
    run: async (ctx, a: z.output<typeof taskArgs>) => {
      await visibleTask(ctx, a.id);
      await command(ctx, 'task_complete', { id: a.id });
      const { task, index } = await visibleTask(ctx, a.id);
      return { task: present(ctx, task, index) };
    },
  },
  {
    name: 'add_comment',
    title: 'Comment on a task',
    description: 'Add a comment (Markdown) to a task.',
    scopes: ['comments:write'],
    inputSchema: schema(
      { taskId: { type: 'string', format: 'uuid' }, content: { type: 'string' } },
      ['taskId', 'content'],
    ),
    annotations: ADD,
    args: commentArgs,
    run: async (ctx, a: z.output<typeof commentArgs>) => {
      await visibleTask(ctx, a.taskId);
      const commentId = newId();
      await command(ctx, 'comment_add', { id: commentId, taskId: a.taskId, content: a.content });
      return { comment: { id: commentId, taskId: a.taskId } };
    },
  },
];
