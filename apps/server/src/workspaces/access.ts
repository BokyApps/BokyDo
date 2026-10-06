import type { Role, WorkspaceRole } from '@bokydo/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { projectMembers, projects, workspaceMembers, workspaces } from '../db/schema.js';
import { fail, type ChangeRecorder, type Tx } from '../sync/context.js';

/**
 * Workspaces grant access by writing ordinary project memberships tagged `source = 'workspace'`,
 * so every existing access check (and the sync engine's visibility rules) keeps working
 * unchanged. These helpers keep those rows in step with workspace roles and project visibility:
 * - owners and admins get `admin` on workspace-visible projects, members get `editor`;
 * - guests get nothing implicitly (only what is shared with them directly);
 * - a direct share is never overwritten or removed by workspace changes, except when someone
 *   leaves or is removed from the workspace, which removes all their access to its projects.
 */

export const WORKSPACE_RANK: Record<WorkspaceRole, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function projectRoleFor(role: WorkspaceRole | null): Role | null {
  if (role === 'owner' || role === 'admin') return 'admin';
  if (role === 'member') return 'editor';
  return null;
}

export async function workspaceRole(
  tx: Pick<Tx, 'select'>,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await tx
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaces.deletedAt),
      ),
    );
  return row?.role ?? null;
}

/** A live workspace the user belongs to with at least `min`; else not_found / forbidden. */
export async function requireWorkspace(
  tx: Tx,
  userId: string,
  workspaceId: string,
  min: WorkspaceRole,
): Promise<{ id: string; name: string; role: WorkspaceRole }> {
  const [row] = await tx
    .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)),
    )
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)));
  if (!row) return fail('not_found', 'workspace');
  if (WORKSPACE_RANK[row.role] < WORKSPACE_RANK[min]) return fail('forbidden', `requires ${min}`);
  return row;
}

/** Everyone in the workspace (for fan-out of workspace-level changes). */
export async function workspaceUserIds(
  tx: Pick<Tx, 'select'>,
  workspaceId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return rows.map((r) => r.userId);
}

/** Tell every member's clients that the workspace (members, folders, name) changed. */
export function announceWorkspace(
  changes: ChangeRecorder,
  workspaceId: string,
  userIds: Iterable<string>,
) {
  for (const userId of userIds) changes.forUser('workspaces', workspaceId, userId);
}

function announceAccess(changes: ChangeRecorder, projectId: string, userId: string) {
  changes.forUser('project_access', projectId, userId);
  changes.inProject('projects', projectId, projectId);
}

/** Bring one user's workspace-granted rows on one project to `desired`. */
async function reconcile(
  tx: Tx,
  changes: ChangeRecorder,
  projectId: string,
  userId: string,
  desired: Role | null,
  current: { role: Role; source: 'direct' | 'workspace' } | undefined,
) {
  if (current?.source === 'direct') return;
  if (!desired) {
    if (!current) return;
    await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  } else if (!current) {
    await tx
      .insert(projectMembers)
      .values({ projectId, userId, role: desired, source: 'workspace' });
  } else if (current.role !== desired) {
    await tx
      .update(projectMembers)
      .set({ role: desired })
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  } else return;
  announceAccess(changes, projectId, userId);
}

/** After a project's workspace or visibility changed: fix every workspace member's access. */
export async function syncProjectAccess(tx: Tx, changes: ChangeRecorder, projectId: string) {
  const [project] = await tx
    .select({
      workspaceId: projects.workspaceId,
      visibility: projects.visibility,
      deletedAt: projects.deletedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return;
  const rows = await tx
    .select({
      userId: projectMembers.userId,
      role: projectMembers.role,
      source: projectMembers.source,
    })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));
  const current = new Map(rows.map((r) => [r.userId, r]));
  const workspaceId =
    project.visibility === 'workspace' && !project.deletedAt ? project.workspaceId : null;
  const members = workspaceId
    ? await tx
        .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId))
    : [];
  const desired = new Map(members.map((m) => [m.userId, projectRoleFor(m.role)]));
  for (const userId of new Set([...current.keys(), ...desired.keys()]))
    await reconcile(
      tx,
      changes,
      projectId,
      userId,
      desired.get(userId) ?? null,
      current.get(userId),
    );
}

/** After a user's workspace role changed (or they joined): fix their access to its projects. */
export async function syncUserAccess(
  tx: Tx,
  changes: ChangeRecorder,
  workspaceId: string,
  userId: string,
) {
  const role = await workspaceRole(tx, workspaceId, userId);
  const list = await tx
    .select({ id: projects.id, visibility: projects.visibility })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)));
  if (list.length === 0) return;
  const rows = await tx
    .select({
      projectId: projectMembers.projectId,
      role: projectMembers.role,
      source: projectMembers.source,
    })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.userId, userId),
        inArray(
          projectMembers.projectId,
          list.map((p) => p.id),
        ),
      ),
    );
  const current = new Map(rows.map((r) => [r.projectId, r]));
  for (const p of list)
    await reconcile(
      tx,
      changes,
      p.id,
      userId,
      p.visibility === 'workspace' ? projectRoleFor(role) : null,
      current.get(p.id),
    );
}
