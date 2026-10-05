import type { PendingInvite } from '@bokydo/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { projectInvitations, projects } from '../db/schema.js';
import type { Tx } from '../sync/context.js';

export const openInvite = () =>
  and(
    isNull(projectInvitations.acceptedAt),
    isNull(projectInvitations.closedAt),
    gt(projectInvitations.expiresAt, new Date()),
  );

/** Direct invitations waiting for this user (sent with every sync, and via the API). */
export async function pendingInvites(
  tx: Pick<Tx, 'select'>,
  userId: string,
): Promise<PendingInvite[]> {
  const creator = sql<
    string | null
  >`(select u.username from users u where u.id = ${projectInvitations.createdById})`;
  const rows = await tx
    .select({ invite: projectInvitations, projectName: projects.name, creator })
    .from(projectInvitations)
    .innerJoin(projects, eq(projects.id, projectInvitations.projectId))
    .where(and(eq(projectInvitations.inviteeId, userId), openInvite(), isNull(projects.deletedAt)));
  return rows.map(({ invite, projectName, creator }) => ({
    id: invite.id,
    projectId: invite.projectId,
    projectName,
    role: invite.role,
    invitedBy: creator,
    expiresAt: invite.expiresAt.toISOString(),
  }));
}
