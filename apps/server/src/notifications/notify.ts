import type { AppNotification, NotificationType } from '@bokydo/shared';
import { and, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { newId } from '../db/ids.js';
import { notifications, projectMembers, users } from '../db/schema.js';
import type { ChangeRecorder, Tx } from '../sync/context.js';

/** A user may cause at most this many notifications per hour (mention / assignment spam). */
export const NOTIFICATIONS_PER_ACTOR_PER_HOUR = 300;
const KEEP = 50;

/**
 * Record a notification for `userId` (never for the actor themself) and poke their clients.
 * Over the per-actor hourly budget, further notifications are silently dropped. A null actor is
 * the system (reminders, security alerts): no budget applies.
 */
export async function notify(
  tx: Tx,
  changes: ChangeRecorder,
  actorId: string | null,
  n: {
    userId: string;
    type: NotificationType;
    projectId?: string | null;
    taskId?: string | null;
    commentId?: string | null;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  if (n.userId === actorId) return;
  if (actorId !== null) {
    const [recent] = await tx
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.actorId, actorId),
          gt(notifications.createdAt, new Date(Date.now() - 3600_000)),
        ),
      );
    if ((recent?.n ?? 0) >= NOTIFICATIONS_PER_ACTOR_PER_HOUR) return;
  }
  const id = newId();
  await tx.insert(notifications).values({
    id,
    userId: n.userId,
    type: n.type,
    actorId,
    projectId: n.projectId ?? null,
    taskId: n.taskId ?? null,
    commentId: n.commentId ?? null,
    data: n.data ?? {},
  });
  changes.forUser('notifications', id, n.userId);
}

/**
 * The user's latest notifications. Ones about projects they can no longer see are left out,
 * so nothing leaks after someone is removed from a project.
 */
export async function latestNotifications(
  tx: Pick<Tx, 'select'>,
  userId: string,
): Promise<{ notifications: AppNotification[]; unreadNotifications: number }> {
  const visible = or(
    isNull(notifications.projectId),
    sql`exists (select 1 from project_members pm where pm.project_id = "notifications"."project_id" and pm.user_id = ${userId})`,
  );
  const rows = await tx
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), visible))
    .orderBy(desc(notifications.createdAt))
    .limit(KEEP);
  const [unread] = await tx
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), visible));
  return {
    notifications: rows.map((r) => ({
      id: r.id,
      type: r.type as NotificationType,
      actorId: r.actorId,
      projectId: r.projectId,
      taskId: r.taskId,
      commentId: r.commentId,
      data: r.data as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
      read: r.readAt !== null,
    })),
    unreadNotifications: unread?.n ?? 0,
  };
}

/** Project members whose usernames are @mentioned in `text` (at most `max`, never the author). */
export async function mentionedMembers(
  tx: Pick<Tx, 'select'>,
  projectId: string,
  text: string,
  max: number,
): Promise<string[]> {
  const names = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w@])@([\w.-]{1,40})/g))
    names.add((m[1] ?? '').toLowerCase());
  if (names.size === 0) return [];
  const rows = await tx
    .select({ userId: projectMembers.userId, username: users.username })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
  return rows
    .filter((r) => names.has(r.username.toLowerCase()))
    .map((r) => r.userId)
    .slice(0, max);
}
