import { resolvePreferences, type CommandArgs } from '@bokydo/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { reminders, tasks, users } from '../../db/schema.js';
import { computeFireAt } from '../../reminders/reminders.js';
import { fail, LIMITS, type CommandContext } from '../context.js';
import { requireProject } from '../policy.js';

/**
 * Reminders are personal: anyone who can see a task may remind themselves about it, and only
 * the owner sees, changes or receives a reminder.
 */
export async function reminderAdd(
  ctx: CommandContext,
  args: CommandArgs<'reminder_add'>,
): Promise<void> {
  const [task] = await ctx.tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, args.taskId), isNull(tasks.deletedAt)));
  if (!task) return fail('not_found', 'task');
  await requireProject(ctx.tx, ctx.userId, task.projectId, 'view');
  if (args.type === 'relative' && !task.due?.time)
    fail('invalid', 'relative reminders need a task with a due time');

  const [perTask] = await ctx.tx
    .select({ n: count() })
    .from(reminders)
    .where(
      and(
        eq(reminders.taskId, task.id),
        eq(reminders.userId, ctx.userId),
        isNull(reminders.deletedAt),
      ),
    );
  if ((perTask?.n ?? 0) >= LIMITS.remindersPerTask) fail('limit_exceeded', 'too many reminders');
  const [perUser] = await ctx.tx
    .select({ n: count() })
    .from(reminders)
    .where(and(eq(reminders.userId, ctx.userId), isNull(reminders.deletedAt)));
  if ((perUser?.n ?? 0) >= LIMITS.remindersPerUser) fail('limit_exceeded', 'too many reminders');

  const [me] = await ctx.tx
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, ctx.userId));
  const zone = resolvePreferences(me?.preferences).timezone ?? ctx.defaultTimeZone;
  const row =
    args.type === 'relative'
      ? {
          type: 'relative',
          minutesBefore: args.minutesBefore,
          date: null,
          time: null,
          timeZone: null,
        }
      : { type: 'absolute', minutesBefore: null, date: args.date, time: args.time, timeZone: zone };
  const fireAt = computeFireAt(row, task, zone);
  await ctx.tx.insert(reminders).values({
    id: args.id,
    userId: ctx.userId,
    taskId: task.id,
    ...row,
    fireAt,
    // Reminders set for a time that has already passed never fire.
    firedFor: fireAt && fireAt <= ctx.now ? fireAt : null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  ctx.changes.forUser('reminders', args.id, ctx.userId);
  // Your own reminder replaces the automatic one (deleted, so it doesn't come back).
  const autos = await ctx.tx
    .update(reminders)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(
      and(
        eq(reminders.taskId, task.id),
        eq(reminders.userId, ctx.userId),
        eq(reminders.isAuto, true),
        isNull(reminders.deletedAt),
      ),
    )
    .returning({ id: reminders.id });
  for (const a of autos) ctx.changes.forUser('reminders', a.id, ctx.userId);
}

export async function reminderDelete(
  ctx: CommandContext,
  args: CommandArgs<'reminder_delete'>,
): Promise<void> {
  const [row] = await ctx.tx
    .select({ id: reminders.id })
    .from(reminders)
    .where(
      and(eq(reminders.id, args.id), eq(reminders.userId, ctx.userId), isNull(reminders.deletedAt)),
    );
  if (!row) return fail('not_found', 'reminder');
  // Soft delete: a deleted automatic reminder must not come back on the next task change.
  await ctx.tx
    .update(reminders)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(reminders.id, row.id));
  ctx.changes.forUser('reminders', row.id, ctx.userId);
}
