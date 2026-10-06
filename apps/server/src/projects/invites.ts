import type { PendingInvite } from '@bokydo/shared';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { projectInvitations } from '../db/schema.js';
import type { Tx } from '../sync/context.js';

export const openInvite = () =>
  and(
    isNull(projectInvitations.acceptedAt),
    isNull(projectInvitations.closedAt),
    gt(projectInvitations.expiresAt, new Date()),
  );

/** The invite's project or workspace name, if it still exists. */
export const targetName = sql<string | null>`coalesce(
  (select p.name from projects p where p.id = "project_invitations"."project_id" and p.deleted_at is null),
  (select w.name from workspaces w where w.id = "project_invitations"."workspace_id" and w.deleted_at is null)
)`;
export const creatorName = sql<
  string | null
>`(select u.username from users u where u.id = "project_invitations"."created_by_id")`;

/** Direct invitations waiting for this user (sent with every sync, and via the API). */
export async function pendingInvites(
  tx: Pick<Tx, 'select'>,
  userId: string,
): Promise<PendingInvite[]> {
  const rows = await tx
    .select({ invite: projectInvitations, name: targetName, creator: creatorName })
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.inviteeId, userId),
        openInvite(),
        or(isNull(projectInvitations.projectId), isNull(projectInvitations.workspaceId)),
      ),
    );
  return rows
    .filter((r) => r.name !== null)
    .map(({ invite, name, creator }) => ({
      id: invite.id,
      kind: invite.workspaceId ? 'workspace' : 'project',
      targetId: (invite.workspaceId ?? invite.projectId) as string,
      name: name as string,
      role: invite.role,
      invitedBy: creator,
      expiresAt: invite.expiresAt.toISOString(),
    }));
}
