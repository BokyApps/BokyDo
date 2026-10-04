import type { Role } from '@bokydo/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { projectMembers } from '../db/schema.js';
import { ChangeRecorder, WRITE_LOCK } from './context.js';
import type { Affected } from './sync-service.js';

/**
 * Grant or change a user's access to a project. Records a user-scoped `project_access` marker so
 * the user's next sync pulls the project's full contents, and pokes existing members. (Sharing UI
 * and invitations arrive in W5; this is the mechanism they build on.)
 */
export async function grantProjectAccess(
  db: Database,
  projectId: string,
  userId: string,
  role: Exclude<Role, 'owner'>,
): Promise<Affected> {
  const recorder = new ChangeRecorder();
  await db.transaction(async (tx) => {
    await tx.execute(WRITE_LOCK);
    await tx
      .insert(projectMembers)
      .values({ projectId, userId, role })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role },
      });
    recorder.forUser('project_access', projectId, userId);
    recorder.inProject('projects', projectId, projectId);
    await recorder.flush(tx);
  });
  return { projectIds: recorder.projectScopes, userIds: recorder.userScopes };
}

/** Remove a user's access. Their next sync drops the project and everything in it. */
export async function revokeProjectAccess(
  db: Database,
  projectId: string,
  userId: string,
): Promise<Affected> {
  const recorder = new ChangeRecorder();
  await db.transaction(async (tx) => {
    await tx.execute(WRITE_LOCK);
    await tx
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
          sql`${projectMembers.role} <> 'owner'`,
        ),
      );
    recorder.forUser('project_access', projectId, userId);
    recorder.inProject('projects', projectId, projectId);
    await recorder.flush(tx);
  });
  return { projectIds: recorder.projectScopes, userIds: recorder.userScopes };
}
