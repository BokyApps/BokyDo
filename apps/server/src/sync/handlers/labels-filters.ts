import type { CommandArgs } from '@bokydo/shared';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { filters, labels, projectMembers, projects, tasks } from '../../db/schema.js';
import { fail, LIMITS, type CommandContext } from '../context.js';
import { allOf, nextOrderKey, pgCode } from './common.js';

async function requireLabel(ctx: CommandContext, id: string) {
  const [label] = await ctx.tx
    .select()
    .from(labels)
    .where(and(eq(labels.id, id), eq(labels.userId, ctx.userId), isNull(labels.deletedAt)));
  return label ?? fail('not_found', 'label');
}

async function requireFilter(ctx: CommandContext, id: string) {
  const [filter] = await ctx.tx
    .select()
    .from(filters)
    .where(and(eq(filters.id, id), eq(filters.userId, ctx.userId), isNull(filters.deletedAt)));
  return filter ?? fail('not_found', 'filter');
}

/** Run an insert/update that may hit the per-user unique label name index. */
async function uniqueName<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (pgCode(err) === '23505') return fail('conflict', 'a label with that name already exists');
    throw err;
  }
}

/**
 * Apply a label rename/removal to the tasks this user may edit. Tasks carry label names, so
 * collaborators' copies of a shared task change too, exactly as editing the task would.
 */
async function rewriteTaskLabels(
  ctx: CommandContext,
  from: string,
  to: string | null,
): Promise<void> {
  const editable = ctx.tx
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.userId, ctx.userId),
        inArray(projectMembers.role, ['owner', 'admin', 'editor']),
        isNull(projects.deletedAt),
        eq(projects.isArchived, false),
      ),
    );
  const changed = await ctx.tx
    .update(tasks)
    .set({
      labels:
        to === null
          ? sql`array_remove(${tasks.labels}, ${from})`
          : sql`array_replace(${tasks.labels}, ${from}, ${to})`,
      updatedAt: ctx.now,
    })
    .where(
      and(
        sql`${from} = any(${tasks.labels})`,
        inArray(tasks.projectId, editable),
        isNull(tasks.deletedAt),
      ),
    )
    .returning({ id: tasks.id, projectId: tasks.projectId });
  for (const t of changed) ctx.changes.inProject('tasks', t.id, t.projectId);
}

const userLabels = (userId: string) => allOf(eq(labels.userId, userId), isNull(labels.deletedAt));
const userFilters = (userId: string) =>
  allOf(eq(filters.userId, userId), isNull(filters.deletedAt));

export async function labelAdd(ctx: CommandContext, args: CommandArgs<'label_add'>): Promise<void> {
  const [existing] = await ctx.tx.select({ n: count() }).from(labels).where(userLabels(ctx.userId));
  if ((existing?.n ?? 0) >= LIMITS.labelsPerUser) fail('limit_exceeded', 'too many labels');
  const inserted = await uniqueName(async () =>
    ctx.tx
      .insert(labels)
      .values({
        id: args.id,
        userId: ctx.userId,
        name: args.name,
        color: args.color ?? 'charcoal',
        itemOrder:
          args.itemOrder ??
          (await nextOrderKey(ctx.tx, labels, labels.itemOrder, userLabels(ctx.userId))),
        isFavorite: args.isFavorite ?? false,
      })
      .onConflictDoNothing({ target: labels.id })
      .returning({ id: labels.id }),
  );
  if (inserted.length === 0) fail('conflict', 'id already in use');
  ctx.changes.forUser('labels', args.id, ctx.userId);
}

export async function labelUpdate(
  ctx: CommandContext,
  args: CommandArgs<'label_update'>,
): Promise<void> {
  const label = await requireLabel(ctx, args.id);
  const { id, ...fields } = args;
  await uniqueName(() =>
    ctx.tx
      .update(labels)
      .set({ ...fields, updatedAt: ctx.now })
      .where(eq(labels.id, id)),
  );
  if (fields.name !== undefined && fields.name !== label.name)
    await rewriteTaskLabels(ctx, label.name, fields.name);
  ctx.changes.forUser('labels', id, ctx.userId);
}

export async function labelDelete(
  ctx: CommandContext,
  args: CommandArgs<'label_delete'>,
): Promise<void> {
  const label = await requireLabel(ctx, args.id);
  await ctx.tx
    .update(labels)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(labels.id, label.id));
  await rewriteTaskLabels(ctx, label.name, null);
  ctx.changes.forUser('labels', label.id, ctx.userId);
}

export async function filterAdd(
  ctx: CommandContext,
  args: CommandArgs<'filter_add'>,
): Promise<void> {
  const [existing] = await ctx.tx
    .select({ n: count() })
    .from(filters)
    .where(userFilters(ctx.userId));
  if ((existing?.n ?? 0) >= LIMITS.filtersPerUser) fail('limit_exceeded', 'too many filters');
  const inserted = await ctx.tx
    .insert(filters)
    .values({
      id: args.id,
      userId: ctx.userId,
      name: args.name,
      query: args.query,
      color: args.color ?? 'charcoal',
      itemOrder:
        args.itemOrder ??
        (await nextOrderKey(ctx.tx, filters, filters.itemOrder, userFilters(ctx.userId))),
      isFavorite: args.isFavorite ?? false,
    })
    .onConflictDoNothing()
    .returning({ id: filters.id });
  if (inserted.length === 0) fail('conflict', 'id already in use');
  ctx.changes.forUser('filters', args.id, ctx.userId);
}

export async function filterUpdate(
  ctx: CommandContext,
  args: CommandArgs<'filter_update'>,
): Promise<void> {
  await requireFilter(ctx, args.id);
  const { id, ...fields } = args;
  await ctx.tx
    .update(filters)
    .set({ ...fields, updatedAt: ctx.now })
    .where(eq(filters.id, id));
  ctx.changes.forUser('filters', id, ctx.userId);
}

export async function filterDelete(
  ctx: CommandContext,
  args: CommandArgs<'filter_delete'>,
): Promise<void> {
  const filter = await requireFilter(ctx, args.id);
  await ctx.tx
    .update(filters)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(filters.id, filter.id));
  ctx.changes.forUser('filters', filter.id, ctx.userId);
}
