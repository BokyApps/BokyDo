import { zonedInstant } from '@bokydo/nlp';
import { resolvePreferences, type Reminder } from '@bokydo/shared';
import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { notify } from '../notifications/notify.js';
import { newId } from '../db/ids.js';
import { projectMembers, reminders, tasks, users } from '../db/schema.js';
import type { ChangeRecorder, Tx } from '../sync/context.js';

export type ReminderRow = typeof reminders.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export function reminderToWire(r: ReminderRow): Reminder {
  return {
    id: r.id,
    taskId: r.taskId,
    type: r.type as Reminder['type'],
    minutesBefore: r.minutesBefore,
    date: r.date,
    time: r.time,
    timeZone: r.timeZone,
    isAuto: r.isAuto,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * When a reminder should fire. Absolute reminders are fixed; relative ones follow the task's
 * current due time (fixed to its own zone, or floating in the owner's zone) and are inactive
 * while the task has no due time.
 */
export function computeFireAt(
  r: Pick<ReminderRow, 'type' | 'minutesBefore' | 'date' | 'time' | 'timeZone'>,
  task: Pick<TaskRow, 'due'>,
  ownerZone: string,
): Date | null {
  if (r.type === 'absolute')
    return r.date && r.time
      ? new Date(zonedInstant(r.date, r.time, r.timeZone ?? ownerZone))
      : null;
  const due = task.due;
  if (!due?.time || r.minutesBefore === null) return null;
  return new Date(
    zonedInstant(due.date, due.time, due.timezone ?? ownerZone) - r.minutesBefore * 60_000,
  );
}

/** Each user's preferred zone (or the instance default) and automatic-reminder setting. */
async function owners(tx: Tx, userIds: string[], defaultTimeZone: string) {
  const rows = userIds.length
    ? await tx
        .select({ id: users.id, preferences: users.preferences })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  return new Map(
    rows.map((u) => {
      const p = resolvePreferences(u.preferences);
      return [
        u.id,
        { zone: p.timezone ?? defaultTimeZone, auto: p.notifications.autoReminder },
      ] as const;
    }),
  );
}

/**
 * Bring reminders on these tasks up to date after any change to them: automatic reminders
 * follow the task's assignee (or creator) and their preference, and every live reminder's
 * `fireAt` is recomputed. Runs inside the writer's transaction.
 */
export async function refreshTaskReminders(
  tx: Tx,
  changes: ChangeRecorder,
  taskIds: string[],
  defaultTimeZone: string,
): Promise<void> {
  if (taskIds.length === 0) return;
  const taskRows = await tx.select().from(tasks).where(inArray(tasks.id, taskIds));
  const existing = await tx.select().from(reminders).where(inArray(reminders.taskId, taskIds));
  const responsible = new Map(taskRows.map((t) => [t.id, t.assigneeId ?? t.createdById]));
  const people = await owners(
    tx,
    [...new Set([...responsible.values(), ...existing.map((r) => r.userId)])],
    defaultTimeZone,
  );
  const members = new Set(
    (
      await tx
        .select({ projectId: projectMembers.projectId, userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          inArray(
            projectMembers.projectId,
            taskRows.map((t) => t.projectId),
          ),
        )
    ).map((m) => `${m.projectId}:${m.userId}`),
  );

  const live = existing.filter((r) => !r.deletedAt);
  for (const task of taskRows) {
    const owner = responsible.get(task.id) as string;
    const auto = people.get(owner)?.auto ?? null;
    const mine = existing.filter((r) => r.taskId === task.id);
    // Automatic reminders of someone else (reassigned) or of a switched-off preference go away.
    for (const r of mine.filter((r) => r.isAuto && (r.userId !== owner || auto === null))) {
      await tx.delete(reminders).where(eq(reminders.id, r.id));
      if (r.deletedAt) continue;
      changes.forUser('reminders', r.id, r.userId);
      live.splice(live.indexOf(r), 1);
    }
    if (auto === null || task.deletedAt || task.isCompleted || !task.due?.time) continue;
    if (!members.has(`${task.projectId}:${owner}`)) continue;
    const ownerRows = mine.filter((r) => r.userId === owner);
    const autoRow = ownerRows.find((r) => r.isAuto);
    if (autoRow) {
      // A deleted automatic reminder stays deleted; a live one follows the preference.
      if (!autoRow.deletedAt && autoRow.minutesBefore !== auto) {
        await tx
          .update(reminders)
          .set({ minutesBefore: auto, updatedAt: new Date() })
          .where(eq(reminders.id, autoRow.id));
        autoRow.minutesBefore = auto;
        changes.forUser('reminders', autoRow.id, owner);
      }
      continue;
    }
    // Your own reminders on the task replace the automatic one.
    if (ownerRows.some((r) => !r.deletedAt)) continue;
    const row: ReminderRow = {
      id: newId(),
      userId: owner,
      taskId: task.id,
      type: 'relative',
      minutesBefore: auto,
      date: null,
      time: null,
      timeZone: null,
      isAuto: true,
      fireAt: null,
      firedFor: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    await tx.insert(reminders).values(row);
    live.push(row);
    changes.forUser('reminders', row.id, owner);
  }
  await updateFireTimes(tx, live, new Map(taskRows.map((t) => [t.id, t])), people, defaultTimeZone);
}

async function updateFireTimes(
  tx: Tx,
  rows: ReminderRow[],
  taskById: Map<string, Pick<TaskRow, 'due'>>,
  people: Map<string, { zone: string }>,
  defaultTimeZone: string,
) {
  for (const r of rows) {
    const task = taskById.get(r.taskId);
    if (!task) continue;
    const fireAt = computeFireAt(r, task, people.get(r.userId)?.zone ?? defaultTimeZone);
    if (fireAt?.getTime() === r.fireAt?.getTime()) continue;
    await tx.update(reminders).set({ fireAt }).where(eq(reminders.id, r.id));
  }
}

/**
 * After a user's time zone or automatic-reminder preference changed: refresh every task they
 * are responsible for or have reminders on.
 */
export async function refreshUserReminders(
  tx: Tx,
  changes: ChangeRecorder,
  userId: string,
  defaultTimeZone: string,
): Promise<void> {
  const withReminders = await tx
    .selectDistinct({ id: reminders.taskId })
    .from(reminders)
    .where(and(eq(reminders.userId, userId), isNull(reminders.deletedAt)));
  const responsibleFor = await tx
    .select({ id: tasks.id, assigneeId: tasks.assigneeId, createdById: tasks.createdById })
    .from(tasks)
    .innerJoin(
      projectMembers,
      and(eq(projectMembers.projectId, tasks.projectId), eq(projectMembers.userId, userId)),
    )
    .where(
      and(
        isNull(tasks.deletedAt),
        eq(tasks.isCompleted, false),
        sql`${tasks.due}->>'time' is not null`,
      ),
    );
  const ids = new Set(withReminders.map((r) => r.id));
  for (const t of responsibleFor) if ((t.assigneeId ?? t.createdById) === userId) ids.add(t.id);
  const list = [...ids];
  for (let i = 0; i < list.length; i += 500)
    await refreshTaskReminders(tx, changes, list.slice(i, i + 500), defaultTimeZone);
}

/** Reminders missed by more than this (e.g. the server was down) are skipped, not sent late. */
export const LATE_LIMIT_MS = 12 * 3600_000;

/**
 * Deliver every reminder whose time has come, once per `fireAt`: as an in-app notification
 * (email and push follow through the delivery outbox). Reminders on completed or deleted tasks,
 * or on projects the owner can no longer see, are marked handled without a notification.
 * Returns how many reminders were handled (a full batch means there may be more).
 */
export async function fireDueReminders(
  tx: Tx,
  changes: ChangeRecorder,
  now: Date,
  batch = 200,
): Promise<number> {
  const due = await tx
    .select({
      reminder: reminders,
      task: {
        content: tasks.content,
        projectId: tasks.projectId,
        isCompleted: tasks.isCompleted,
        deletedAt: tasks.deletedAt,
      },
      member: projectMembers.userId,
    })
    .from(reminders)
    .innerJoin(tasks, eq(tasks.id, reminders.taskId))
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, tasks.projectId),
        eq(projectMembers.userId, reminders.userId),
      ),
    )
    .where(
      and(
        isNull(reminders.deletedAt),
        lte(reminders.fireAt, now),
        or(isNull(reminders.firedFor), ne(reminders.firedFor, reminders.fireAt)),
      ),
    )
    .orderBy(reminders.fireAt)
    .limit(batch)
    .for('update', { of: reminders, skipLocked: true });
  for (const { reminder: r, task, member } of due) {
    await tx.update(reminders).set({ firedFor: r.fireAt }).where(eq(reminders.id, r.id));
    const late = now.getTime() - (r.fireAt as Date).getTime();
    if (!member || task.isCompleted || task.deletedAt || late > LATE_LIMIT_MS) continue;
    await notify(tx, changes, null, {
      userId: r.userId,
      type: 'reminder',
      projectId: task.projectId,
      taskId: r.taskId,
      data: {
        title: task.content.slice(0, 200),
        at: (r.fireAt as Date).toISOString(),
        ...(late > 5 * 60_000 ? { late: true } : {}),
      },
    });
  }
  return due.length;
}
