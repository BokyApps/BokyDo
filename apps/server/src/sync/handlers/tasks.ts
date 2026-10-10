import { localNow, nextOccurrence } from '@bokydo/nlp';
import { resolvePreferences, type CommandArgs, type Due } from '@bokydo/shared';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { logActivity } from '../../activity/log.js';
import { notify } from '../../notifications/notify.js';
import { tasks, users } from '../../db/schema.js';
import { fail, LIMITS, type CommandContext, type Tx } from '../context.js';
import { isProjectMember, requireProject } from '../policy.js';
import { allOf, nextOrderKey } from './common.js';
import { ensureInbox } from './projects.js';
import { requireSection } from './sections.js';

type TaskRow = typeof tasks.$inferSelect;

/** A live task the user may edit. */
async function requireTask(ctx: CommandContext, id: string): Promise<TaskRow> {
  const [task] = await ctx.tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)));
  if (!task) return fail('not_found', 'task');
  const project = await requireProject(ctx.tx, ctx.userId, task.projectId, 'edit', ctx.projectIds);
  if (project.isArchived) fail('invalid', 'project is archived');
  return task;
}

async function descendantTasks(tx: Tx, taskId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    with recursive d as (
      select id from tasks where parent_id = ${taskId} and deleted_at is null
      union all
      select t.id from tasks t join d on t.parent_id = d.id where t.deleted_at is null
    ) select id from d`);
  return rows.map((r) => r.id);
}

/** The task and its ancestors, nearest first. */
async function ancestry(tx: Tx, taskId: string): Promise<{ id: string; isCompleted: boolean }[]> {
  return tx.execute<{ id: string; isCompleted: boolean }>(sql`
    with recursive a as (
      select id, parent_id, is_completed, 0 as depth from tasks where id = ${taskId}
      union all
      select t.id, t.parent_id, t.is_completed, a.depth + 1 from tasks t join a on t.id = a.parent_id where a.depth < 50
    ) select id, is_completed as "isCompleted" from a order by depth`);
}

async function subtreeHeight(tx: Tx, taskId: string): Promise<number> {
  const [row] = await tx.execute<{ height: number }>(sql`
    with recursive d as (
      select id, 1 as depth from tasks where id = ${taskId}
      union all
      select t.id, d.depth + 1 from tasks t join d on t.parent_id = d.id where t.deleted_at is null and d.depth < 50
    ) select max(depth)::int as height from d`);
  return row?.height ?? 1;
}

const siblingsOf = (projectId: string, sectionId: string | null, parentId: string | null) =>
  allOf(
    eq(tasks.projectId, projectId),
    sectionId ? eq(tasks.sectionId, sectionId) : isNull(tasks.sectionId),
    parentId ? eq(tasks.parentId, parentId) : isNull(tasks.parentId),
    isNull(tasks.deletedAt),
  );

async function checkAssignee(
  ctx: CommandContext,
  projectId: string,
  assigneeId: string | null | undefined,
) {
  if (assigneeId && !(await isProjectMember(ctx.tx, projectId, assigneeId))) {
    fail('invalid', 'assignee is not a member of the project');
  }
}

/** Label names are case-insensitively unique per task. */
function normalizeLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  return labels.filter((l) => !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()));
}

export const dueColumns = (due: Due | null | undefined) =>
  due === undefined ? {} : { due, dueDate: due?.date ?? null };

export async function taskAdd(ctx: CommandContext, args: CommandArgs<'task_add'>): Promise<void> {
  let projectId = args.projectId;
  let sectionId = args.sectionId ?? null;
  const parentId = args.parentId ?? null;

  if (parentId) {
    const parent = await requireTask(ctx, parentId);
    if (projectId && projectId !== parent.projectId)
      fail('invalid', 'sub-tasks live in their parent’s project');
    if (args.sectionId !== undefined && args.sectionId !== parent.sectionId) {
      fail('invalid', 'sub-tasks live in their parent’s section');
    }
    if ((await ancestry(ctx.tx, parent.id)).length + 1 > LIMITS.subtaskDepth + 1)
      fail('invalid', 'too deeply nested');
    projectId = parent.projectId;
    sectionId = parent.sectionId;
  }
  projectId ??= await ensureInbox(ctx);

  const project = await requireProject(ctx.tx, ctx.userId, projectId, 'edit', ctx.projectIds);
  if (project.isArchived) fail('invalid', 'project is archived');
  if (sectionId) {
    const section = await requireSection(ctx, sectionId);
    if (section.projectId !== project.id) fail('invalid', 'section belongs to another project');
  }
  await checkAssignee(ctx, project.id, args.assigneeId);

  const [existing] = await ctx.tx
    .select({ n: count() })
    .from(tasks)
    .where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)));
  if ((existing?.n ?? 0) >= LIMITS.tasksPerProject)
    fail('limit_exceeded', 'too many tasks in project');

  const inserted = await ctx.tx
    .insert(tasks)
    .values({
      id: args.id,
      projectId: project.id,
      sectionId,
      parentId,
      content: args.content,
      description: args.description ?? '',
      priority: args.priority ?? 4,
      ...dueColumns(args.due),
      deadline: args.deadline ?? null,
      durationMinutes: args.durationMinutes ?? null,
      labels: normalizeLabels(args.labels ?? []),
      assigneeId: args.assigneeId ?? null,
      assignedById: args.assigneeId ? ctx.userId : null,
      childOrder:
        args.childOrder ??
        (await nextOrderKey(
          ctx.tx,
          tasks,
          tasks.childOrder,
          siblingsOf(project.id, sectionId, parentId),
        )),
      createdById: ctx.userId,
    })
    .onConflictDoNothing()
    .returning({ id: tasks.id });
  if (inserted.length === 0) fail('conflict', 'id already in use');
  ctx.changes.inProject('tasks', args.id, project.id);
  if (args.assigneeId)
    await notify(ctx.tx, ctx.changes, ctx.userId, {
      userId: args.assigneeId,
      type: 'assigned',
      projectId: project.id,
      taskId: args.id,
      data: { title: args.content, projectName: project.name },
    });
  await logActivity(ctx.tx, ctx.userId, {
    projectId: project.id,
    taskId: args.id,
    type: 'task_added',
    data: { title: args.content, parentId: args.parentId ?? null },
  });
}

export async function taskUpdate(
  ctx: CommandContext,
  args: CommandArgs<'task_update'>,
): Promise<void> {
  const task = await requireTask(ctx, args.id);
  const { id, due, labels, assigneeId, ...rest } = args;
  if (assigneeId !== undefined && assigneeId !== task.assigneeId) {
    await checkAssignee(ctx, task.projectId, assigneeId);
  }
  await ctx.tx
    .update(tasks)
    .set({
      ...rest,
      ...dueColumns(due),
      ...(labels !== undefined ? { labels: normalizeLabels(labels) } : {}),
      ...(assigneeId !== undefined && assigneeId !== task.assigneeId
        ? { assigneeId, assignedById: assigneeId ? ctx.userId : null }
        : {}),
      updatedAt: ctx.now,
    })
    .where(eq(tasks.id, id));
  ctx.changes.inProject('tasks', id, task.projectId);
  if (assigneeId && assigneeId !== task.assigneeId)
    await notify(ctx.tx, ctx.changes, ctx.userId, {
      userId: assigneeId,
      type: 'assigned',
      projectId: task.projectId,
      taskId: id,
      data: { title: args.content ?? task.content },
    });
  const changed = Object.keys(args).filter(
    (k) =>
      k !== 'id' &&
      JSON.stringify((args as Record<string, unknown>)[k]) !==
        JSON.stringify((task as Record<string, unknown>)[k]),
  );
  if (changed.length)
    await logActivity(ctx.tx, ctx.userId, {
      projectId: task.projectId,
      taskId: id,
      type: 'task_updated',
      data: {
        title: args.content ?? task.content,
        fields: changed,
        ...(args.content !== undefined && args.content !== task.content
          ? { from: task.content }
          : {}),
        ...(assigneeId !== undefined ? { assigneeId } : {}),
        ...(due !== undefined ? { due: due?.string ?? null } : {}),
      },
    });
}

/** Move a task (with its sub-tasks) to another project, section or parent, and/or reorder it. */
export async function taskMove(ctx: CommandContext, args: CommandArgs<'task_move'>): Promise<void> {
  const task = await requireTask(ctx, args.id);
  let projectId: string;
  let sectionId: string | null;
  let parentId: string | null;

  if (args.parentId) {
    const parent = await requireTask(ctx, args.parentId);
    if (parent.id === task.id || (await descendantTasks(ctx.tx, task.id)).includes(parent.id)) {
      fail('invalid', 'cannot move a task under itself');
    }
    if (args.projectId && args.projectId !== parent.projectId)
      fail('invalid', 'sub-tasks live in their parent’s project');
    const depth =
      (await ancestry(ctx.tx, parent.id)).length + (await subtreeHeight(ctx.tx, task.id));
    if (depth > LIMITS.subtaskDepth + 1) fail('invalid', 'too deeply nested');
    projectId = parent.projectId;
    sectionId = parent.sectionId;
    parentId = parent.id;
  } else {
    projectId = args.projectId ?? task.projectId;
    const relocated =
      projectId !== task.projectId ||
      (args.sectionId !== undefined && args.sectionId !== task.sectionId);
    sectionId =
      args.sectionId !== undefined
        ? args.sectionId
        : projectId !== task.projectId
          ? null
          : task.sectionId;
    parentId = args.parentId === null || relocated ? null : task.parentId;
  }

  const project = await requireProject(ctx.tx, ctx.userId, projectId, 'edit', ctx.projectIds);
  if (project.isArchived) fail('invalid', 'project is archived');
  if (sectionId) {
    const section = await requireSection(ctx, sectionId);
    if (section.projectId !== project.id) fail('invalid', 'section belongs to another project');
  }
  // An assignee who isn't a member of the destination project is unassigned.
  const keepAssignee =
    !task.assigneeId || (await isProjectMember(ctx.tx, project.id, task.assigneeId));

  await ctx.tx
    .update(tasks)
    .set({
      projectId: project.id,
      sectionId,
      parentId,
      childOrder:
        args.childOrder ??
        (await nextOrderKey(
          ctx.tx,
          tasks,
          tasks.childOrder,
          siblingsOf(project.id, sectionId, parentId),
        )),
      ...(keepAssignee ? {} : { assigneeId: null, assignedById: null }),
      updatedAt: ctx.now,
    })
    .where(eq(tasks.id, task.id));

  const descendants = await descendantTasks(ctx.tx, task.id);
  if (descendants.length > 0 && (project.id !== task.projectId || sectionId !== task.sectionId)) {
    await ctx.tx
      .update(tasks)
      .set({ projectId: project.id, sectionId, updatedAt: ctx.now })
      .where(inArray(tasks.id, descendants));
  }
  for (const id of [task.id, ...descendants]) {
    ctx.changes.inProject('tasks', id, task.projectId);
    if (project.id !== task.projectId) ctx.changes.inProject('tasks', id, project.id);
  }
  if (project.id !== task.projectId) {
    const data = { title: task.content, from: task.projectId, to: project.id };
    await logActivity(ctx.tx, ctx.userId, {
      projectId: task.projectId,
      taskId: task.id,
      type: 'task_moved',
      data,
    });
    await logActivity(ctx.tx, ctx.userId, {
      projectId: project.id,
      taskId: task.id,
      type: 'task_moved',
      data,
    });
  }
}

/** The completing user's local time: "today" for recurrence is theirs, not the server's. */
async function userNow(ctx: CommandContext) {
  const [row] = await ctx.tx
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, ctx.userId));
  const timeZone = resolvePreferences(row?.preferences).timezone ?? ctx.defaultTimeZone;
  return localNow(timeZone, ctx.now);
}

/**
 * Completing a task completes its open sub-tasks. A recurring task instead moves to its next
 * occurrence and stays open, and its completed sub-tasks reopen for the next round (as in
 * Todoist). When the series has ended, it completes for good.
 */
export async function taskComplete(
  ctx: CommandContext,
  args: CommandArgs<'task_complete'>,
): Promise<void> {
  const task = await requireTask(ctx, args.id);
  const descendants = await descendantTasks(ctx.tx, task.id);
  const next = task.due?.recurrence ? nextOccurrence(task.due, await userNow(ctx)) : null;
  // Whoever assigned the task hears that it's done (not when they complete it themselves).
  if (!task.isCompleted && task.assigneeId && task.assignedById)
    await notify(ctx.tx, ctx.changes, ctx.userId, {
      userId: task.assignedById,
      type: 'completed',
      projectId: task.projectId,
      taskId: task.id,
      data: { title: task.content },
    });
  if (next && !task.isCompleted) {
    await ctx.tx
      .update(tasks)
      .set({ due: next, dueDate: next.date, updatedAt: ctx.now })
      .where(eq(tasks.id, task.id));
    ctx.changes.inProject('tasks', task.id, task.projectId);
    // Each completed occurrence of a repeating task is kept here.
    await logActivity(ctx.tx, ctx.userId, {
      projectId: task.projectId,
      taskId: task.id,
      type: 'task_completed',
      data: { title: task.content, occurrence: task.due?.date ?? null, next: next.date },
    });
    if (descendants.length === 0) return;
    const reopened = await ctx.tx
      .update(tasks)
      .set({ isCompleted: false, completedAt: null, completedById: null, updatedAt: ctx.now })
      .where(and(inArray(tasks.id, descendants), eq(tasks.isCompleted, true)))
      .returning({ id: tasks.id });
    for (const t of reopened) ctx.changes.inProject('tasks', t.id, task.projectId);
    return;
  }
  const ids = [task.id, ...descendants];
  const done = await ctx.tx
    .update(tasks)
    .set({ isCompleted: true, completedAt: ctx.now, completedById: ctx.userId, updatedAt: ctx.now })
    .where(and(inArray(tasks.id, ids), eq(tasks.isCompleted, false)))
    .returning({ id: tasks.id });
  for (const t of done) ctx.changes.inProject('tasks', t.id, task.projectId);
  if (!task.isCompleted)
    await logActivity(ctx.tx, ctx.userId, {
      projectId: task.projectId,
      taskId: task.id,
      type: 'task_completed',
      data: { title: task.content },
    });
}

/** Reopening a task also reopens any completed ancestors so it stays visible. */
export async function taskUncomplete(
  ctx: CommandContext,
  args: CommandArgs<'task_uncomplete'>,
): Promise<void> {
  const task = await requireTask(ctx, args.id);
  const ids = (await ancestry(ctx.tx, task.id)).filter((a) => a.isCompleted).map((a) => a.id);
  if (ids.length === 0) return;
  await ctx.tx
    .update(tasks)
    .set({ isCompleted: false, completedAt: null, completedById: null, updatedAt: ctx.now })
    .where(inArray(tasks.id, ids));
  for (const id of ids) ctx.changes.inProject('tasks', id, task.projectId);
  await logActivity(ctx.tx, ctx.userId, {
    projectId: task.projectId,
    taskId: task.id,
    type: 'task_uncompleted',
    data: { title: task.content },
  });
}

export async function taskDelete(
  ctx: CommandContext,
  args: CommandArgs<'task_delete'>,
): Promise<void> {
  const task = await requireTask(ctx, args.id);
  const ids = [task.id, ...(await descendantTasks(ctx.tx, task.id))];
  await ctx.tx
    .update(tasks)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(inArray(tasks.id, ids));
  for (const id of ids) ctx.changes.inProject('tasks', id, task.projectId);
  await logActivity(ctx.tx, ctx.userId, {
    projectId: task.projectId,
    taskId: task.id,
    type: 'task_deleted',
    data: { title: task.content, subtasks: ids.length - 1 },
  });
}
