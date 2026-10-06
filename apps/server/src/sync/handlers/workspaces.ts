import type { CommandArgs, GrantableWorkspaceRole } from '@bokydo/shared';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  folders,
  projectMembers,
  projects,
  tasks,
  workspaceMembers,
  workspaces,
} from '../../db/schema.js';
import { notify } from '../../notifications/notify.js';
import {
  announceWorkspace,
  requireWorkspace,
  syncUserAccess,
  WORKSPACE_RANK,
  workspaceRole,
  workspaceUserIds,
} from '../../workspaces/access.js';
import { fail, LIMITS, type ChangeRecorder, type CommandContext, type Tx } from '../context.js';
import { nextOrderKey } from './common.js';

/**
 * Workspace rules: any member except guests can create projects in it; admins manage members
 * below admin, folders and the name; only the owner manages admins, transfers or deletes it.
 */

export async function workspaceAdd(
  ctx: CommandContext,
  args: CommandArgs<'workspace_add'>,
): Promise<void> {
  const [n] = await ctx.tx
    .select({ n: count() })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, ctx.userId), eq(workspaceMembers.role, 'owner')));
  if ((n?.n ?? 0) >= LIMITS.workspacesPerUser) fail('limit_exceeded', 'too many workspaces');
  await ctx.tx
    .insert(workspaces)
    .values({ id: args.id, name: args.name, createdAt: ctx.now, updatedAt: ctx.now });
  await ctx.tx
    .insert(workspaceMembers)
    .values({ workspaceId: args.id, userId: ctx.userId, role: 'owner' });
  announceWorkspace(ctx.changes, args.id, [ctx.userId]);
}

export async function workspaceUpdate(
  ctx: CommandContext,
  args: CommandArgs<'workspace_update'>,
): Promise<void> {
  const ws = await requireWorkspace(ctx.tx, ctx.userId, args.id, 'admin');
  await ctx.tx
    .update(workspaces)
    .set({ name: args.name, updatedAt: ctx.now })
    .where(eq(workspaces.id, ws.id));
  announceWorkspace(ctx.changes, ws.id, await workspaceUserIds(ctx.tx, ws.id));
}

/** Deleting a workspace deletes its projects (and everything in them). */
export async function workspaceDelete(
  ctx: CommandContext,
  args: CommandArgs<'workspace_delete'>,
): Promise<void> {
  const ws = await requireWorkspace(ctx.tx, ctx.userId, args.id, 'owner');
  const users = await workspaceUserIds(ctx.tx, ws.id);
  await ctx.tx
    .update(workspaces)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(workspaces.id, ws.id));
  const gone = await ctx.tx
    .update(projects)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(projects.workspaceId, ws.id), isNull(projects.deletedAt)))
    .returning({ id: projects.id });
  for (const p of gone) ctx.changes.inProject('projects', p.id, p.id);
  announceWorkspace(ctx.changes, ws.id, users);
}

/** Only the owner may create, change or remove admins (an admin may step down). */
function guardAdmins(actorRole: string, target: string, next: string | null, self: boolean) {
  if (actorRole === 'owner') return;
  if (target === 'admin' && !self) fail('forbidden', 'only the owner manages admins');
  if (next === 'admin' && target !== 'admin') fail('forbidden', 'only the owner manages admins');
}

export async function workspaceMemberUpdate(
  ctx: CommandContext,
  args: CommandArgs<'workspace_member_update'>,
): Promise<void> {
  const ws = await requireWorkspace(ctx.tx, ctx.userId, args.workspaceId, 'admin');
  const target = await workspaceRole(ctx.tx, ws.id, args.userId);
  if (!target) return fail('not_found', 'member');
  if (target === 'owner') fail('forbidden', 'transfer ownership instead');
  guardAdmins(ws.role, target, args.role, args.userId === ctx.userId);
  if (target === args.role) return;
  await ctx.tx
    .update(workspaceMembers)
    .set({ role: args.role })
    .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, args.userId)));
  await syncUserAccess(ctx.tx, ctx.changes, ws.id, args.userId);
  announceWorkspace(ctx.changes, ws.id, await workspaceUserIds(ctx.tx, ws.id));
  await notify(ctx.tx, ctx.changes, ctx.userId, {
    userId: args.userId,
    type: 'role_changed',
    data: { workspaceName: ws.name, role: args.role },
  });
}

/**
 * Removing someone from a workspace removes all their access to its projects (shared directly
 * or not). Projects they owned pass to the workspace owner; their assignments there lapse.
 */
export async function removeFromWorkspace(
  tx: Tx,
  changes: ChangeRecorder,
  now: Date,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const members = await workspaceUserIds(tx, workspaceId);
  await tx
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  const [owner] = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')));
  const list = await tx
    .select({ id: projects.id, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId));
  const ids = list.map((p) => p.id);
  if (ids.length) {
    const ownerId = owner?.userId;
    for (const p of list) {
      if (!ownerId || p.ownerId !== userId) continue;
      await tx.update(projects).set({ ownerId, updatedAt: now }).where(eq(projects.id, p.id));
      await tx
        .insert(projectMembers)
        .values({ projectId: p.id, userId: ownerId, role: 'owner' })
        .onConflictDoUpdate({
          target: [projectMembers.projectId, projectMembers.userId],
          set: { role: 'owner', source: 'direct' },
        });
      changes.forUser('project_access', p.id, ownerId);
    }
    const dropped = await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.userId, userId), inArray(projectMembers.projectId, ids)))
      .returning({ projectId: projectMembers.projectId });
    for (const d of dropped) {
      changes.forUser('project_access', d.projectId, userId);
      changes.inProject('projects', d.projectId, d.projectId);
    }
    const unassigned = await tx
      .update(tasks)
      .set({ assigneeId: null, assignedById: null, updatedAt: now })
      .where(and(inArray(tasks.projectId, ids), eq(tasks.assigneeId, userId)))
      .returning({ id: tasks.id, projectId: tasks.projectId });
    for (const t of unassigned) changes.inProject('tasks', t.id, t.projectId);
  }
  announceWorkspace(changes, workspaceId, members);
}

export async function workspaceMemberRemove(
  ctx: CommandContext,
  args: CommandArgs<'workspace_member_remove'>,
): Promise<void> {
  const leaving = args.userId === ctx.userId;
  const ws = await requireWorkspace(
    ctx.tx,
    ctx.userId,
    args.workspaceId,
    leaving ? 'guest' : 'admin',
  );
  const target = leaving ? ws.role : await workspaceRole(ctx.tx, ws.id, args.userId);
  if (!target) return fail('not_found', 'member');
  if (target === 'owner')
    fail(
      'forbidden',
      leaving ? 'transfer ownership before leaving' : 'the owner cannot be removed',
    );
  if (!leaving) guardAdmins(ws.role, target, null, false);
  await removeFromWorkspace(ctx.tx, ctx.changes, ctx.now, ws.id, args.userId);
  if (!leaving)
    await notify(ctx.tx, ctx.changes, ctx.userId, {
      userId: args.userId,
      type: 'removed_from_project',
      data: { workspaceName: ws.name },
    });
}

export async function workspaceTransfer(
  ctx: CommandContext,
  args: CommandArgs<'workspace_transfer'>,
): Promise<void> {
  const ws = await requireWorkspace(ctx.tx, ctx.userId, args.workspaceId, 'owner');
  if (args.userId === ctx.userId) return;
  const target = await workspaceRole(ctx.tx, ws.id, args.userId);
  if (!target) return fail('not_found', 'member');
  await ctx.tx
    .update(workspaceMembers)
    .set({ role: 'owner' })
    .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, args.userId)));
  await ctx.tx
    .update(workspaceMembers)
    .set({ role: 'admin' })
    .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, ctx.userId)));
  await syncUserAccess(ctx.tx, ctx.changes, ws.id, args.userId);
  await syncUserAccess(ctx.tx, ctx.changes, ws.id, ctx.userId);
  announceWorkspace(ctx.changes, ws.id, await workspaceUserIds(ctx.tx, ws.id));
  await notify(ctx.tx, ctx.changes, ctx.userId, {
    userId: args.userId,
    type: 'became_owner',
    data: { workspaceName: ws.name },
  });
}

/** Join (or rise in) a workspace; never lowers an existing role. Used by invitations. */
export async function joinWorkspace(
  tx: Tx,
  changes: ChangeRecorder,
  workspaceId: string,
  userId: string,
  role: GrantableWorkspaceRole,
): Promise<boolean> {
  const current = await workspaceRole(tx, workspaceId, userId);
  if (current && WORKSPACE_RANK[current] >= WORKSPACE_RANK[role]) return false;
  if (!current) {
    const [n] = await tx
      .select({ n: count() })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    if ((n?.n ?? 0) >= LIMITS.membersPerWorkspace) fail('limit_exceeded', 'too many members');
  }
  await tx
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { role },
    });
  await syncUserAccess(tx, changes, workspaceId, userId);
  announceWorkspace(changes, workspaceId, await workspaceUserIds(tx, workspaceId));
  return true;
}

export async function folderAdd(
  ctx: CommandContext,
  args: CommandArgs<'folder_add'>,
): Promise<void> {
  const ws = await requireWorkspace(ctx.tx, ctx.userId, args.workspaceId, 'admin');
  const [n] = await ctx.tx
    .select({ n: count() })
    .from(folders)
    .where(and(eq(folders.workspaceId, ws.id), isNull(folders.deletedAt)));
  if ((n?.n ?? 0) >= LIMITS.foldersPerWorkspace) fail('limit_exceeded', 'too many folders');
  await ctx.tx.insert(folders).values({
    id: args.id,
    workspaceId: ws.id,
    name: args.name,
    childOrder:
      args.childOrder ??
      (await nextOrderKey(
        ctx.tx,
        folders,
        folders.childOrder,
        sql`${folders.workspaceId} = ${ws.id}`,
      )),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  announceWorkspace(ctx.changes, ws.id, await workspaceUserIds(ctx.tx, ws.id));
}

async function requireFolder(ctx: CommandContext, id: string) {
  const [folder] = await ctx.tx
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), isNull(folders.deletedAt)));
  if (!folder) return fail('not_found', 'folder');
  const ws = await requireWorkspace(ctx.tx, ctx.userId, folder.workspaceId, 'admin');
  return { folder, ws };
}

export async function folderUpdate(
  ctx: CommandContext,
  args: CommandArgs<'folder_update'>,
): Promise<void> {
  const { folder, ws } = await requireFolder(ctx, args.id);
  await ctx.tx
    .update(folders)
    .set({
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.childOrder !== undefined ? { childOrder: args.childOrder } : {}),
      updatedAt: ctx.now,
    })
    .where(eq(folders.id, folder.id));
  announceWorkspace(ctx.changes, ws.id, await workspaceUserIds(ctx.tx, ws.id));
}

/** Deleting a folder keeps its projects (they just leave the folder). */
export async function folderDelete(
  ctx: CommandContext,
  args: CommandArgs<'folder_delete'>,
): Promise<void> {
  const { folder, ws } = await requireFolder(ctx, args.id);
  await ctx.tx
    .update(folders)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(folders.id, folder.id));
  const moved = await ctx.tx
    .update(projects)
    .set({ folderId: null, updatedAt: ctx.now })
    .where(eq(projects.folderId, folder.id))
    .returning({ id: projects.id });
  for (const p of moved) ctx.changes.inProject('projects', p.id, p.id);
  announceWorkspace(ctx.changes, ws.id, await workspaceUserIds(ctx.tx, ws.id));
}
