import { activity } from '../db/schema.js';
import type { Tx } from '../sync/context.js';

export type ActivityType =
  | 'task_added'
  | 'task_completed'
  | 'task_uncompleted'
  | 'task_updated'
  | 'task_moved'
  | 'task_deleted'
  | 'comment_added'
  | 'member_joined'
  | 'member_left'
  | 'member_removed'
  | 'member_role_changed'
  | 'owner_transferred'
  | 'project_archived'
  | 'project_unarchived';

/** Append to a project's activity log (in the caller's transaction). */
export async function logActivity(
  tx: Pick<Tx, 'insert'>,
  actorId: string,
  entry: {
    projectId: string;
    taskId?: string | null;
    type: ActivityType;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(activity).values({
    projectId: entry.projectId,
    taskId: entry.taskId ?? null,
    actorId,
    type: entry.type,
    data: entry.data ?? {},
  });
}
