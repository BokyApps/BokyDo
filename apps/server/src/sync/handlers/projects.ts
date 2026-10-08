import { logActivity } from '../../activity/log.js';
import { requireWorkspace, syncProjectAccess } from '../../workspaces/access.js';
import type { CommandArgs } from '@bokydo/shared';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { newId } from '../../db/ids.js';
import { folders, projectMembers, projects } from '../../db/schema.js';
import { fail, LIMITS, type CommandContext, type Tx } from '../context.js';
import { requireProject, type ProjectRow } from '../policy.js';
import { allOf, nextOrderKey } from './common.js';

/** The user's inbox, created on first use. */
export async function ensureInbox(ctx: CommandContext): Promise<string> {
  const [existing] = await ctx.tx
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.ownerId, ctx.userId), eq(projects.isInbox, true), isNull(projects.deletedAt)),
    );
  if (existing) return existing.id;
  const id = newId();
  await ctx.tx.insert(projects).values({
    id,
    ownerId: ctx.userId,
    name: 'Inbox',
    childOrder: 'a0',
    isInbox: true,
  });
  await ctx.tx.insert(projectMembers).values({ projectId: id, userId: ctx.userId, role: 'owner' });
  ctx.changes.inProject('projects', id, id);
  return id;
}

/** IDs of a project's live descendants (sub-projects), nearest first. */
async function descendantProjects(tx: Tx, projectId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    with recursive d as (
      select id from projects where parent_id = ${projectId} and deleted_at is null
      union all
      select p.id from projects p join d on p.parent_id = d.id where p.deleted_at is null
    ) select id from d`);
  return rows.map((r) => r.id);
}

/** Depth of a project in its tree (top level = 1). */
async function projectDepth(tx: Tx, projectId: string): Promise<number> {
  const [row] = await tx.execute<{ depth: number }>(sql`
    with recursive a as (
      select id, parent_id, 1 as depth from projects where id = ${projectId}
      union all
      select p.id, p.parent_id, a.depth + 1 from projects p join a on p.id = a.parent_id where a.depth < 50
    ) select max(depth)::int as depth from a`);
  return row?.depth ?? 1;
}

/** Height of the subtree rooted at a project (a leaf = 1). */
async function subtreeHeight(tx: Tx, projectId: string): Promise<number> {
  const [row] = await tx.execute<{ height: number }>(sql`
    with recursive d as (
      select id, 1 as depth from projects where id = ${projectId}
      union all
      select p.id, d.depth + 1 from projects p join d on p.parent_id = d.id where p.deleted_at is null and d.depth < 50
    ) select max(depth)::int as height from d`);
  return row?.height ?? 1;
}

/** A valid parent: same owner (so ownership never splits a tree), not an inbox, manageable. */
async function requireParent(
  ctx: CommandContext,
  parentId: string,
  ownerId: string,
): Promise<ProjectRow> {
  const parent = await requireProject(ctx.tx, ctx.userId, parentId, 'manage', ctx.projectIds);
  if (parent.isInbox) fail('invalid', 'the inbox cannot have sub-projects');
  if (parent.ownerId !== ownerId)
    fail('invalid', 'sub-projects must have the same owner as their parent');
  return parent;
}

const siblingsOf = (ownerId: string, parentId: string | null) =>
  allOf(
    eq(projects.ownerId, ownerId),
    parentId ? eq(projects.parentId, parentId) : isNull(projects.parentId),
    isNull(projects.deletedAt),
  );

export async function projectAdd(
  ctx: CommandContext,
  args: CommandArgs<'project_add'>,
): Promise<void> {
  const [owned] = await ctx.tx
    .select({ n: count() })
    .from(projects)
    .where(and(eq(projects.ownerId, ctx.userId), isNull(projects.deletedAt)));
  if ((owned?.n ?? 0) >= LIMITS.projectsPerUser) fail('limit_exceeded', 'too many projects');

  const parentId = args.parentId ?? null;
  let workspaceId = args.workspaceId ?? null;
  if (parentId) {
    const parent = await requireParent(ctx, parentId, ctx.userId);
    if ((await projectDepth(ctx.tx, parentId)) + 1 > LIMITS.projectDepth)
      fail('invalid', 'too deeply nested');
    if (args.workspaceId !== undefined && args.workspaceId !== parent.workspaceId)
      fail('invalid', "sub-projects stay in their parent's workspace");
    workspaceId = parent.workspaceId;
  }
  if (workspaceId) await requireWorkspace(ctx.tx, ctx.userId, workspaceId, 'member');
  const visibility = args.visibility ?? (workspaceId ? 'workspace' : 'restricted');
  if (!workspaceId && visibility === 'workspace')
    fail('invalid', 'only workspace projects can be visible to a workspace');
  const folderId = await checkFolder(ctx, args.folderId ?? null, workspaceId);
  const inserted = await ctx.tx
    .insert(projects)
    .values({
      id: args.id,
      ownerId: ctx.userId,
      parentId,
      name: args.name,
      color: args.color ?? 'charcoal',
      viewStyle: args.viewStyle ?? 'list',
      workspaceId,
      folderId,
      visibility,
      childOrder:
        args.childOrder ??
        (await nextOrderKey(
          ctx.tx,
          projects,
          projects.childOrder,
          siblingsOf(ctx.userId, parentId),
        )),
    })
    .onConflictDoNothing()
    .returning({ id: projects.id });
  if (inserted.length === 0) fail('conflict', 'id already in use');
  await ctx.tx.insert(projectMembers).values({
    projectId: args.id,
    userId: ctx.userId,
    role: 'owner',
    isFavorite: args.isFavorite ?? false,
  });
  ctx.changes.inProject('projects', args.id, args.id);
  if (workspaceId) await syncProjectAccess(ctx.tx, ctx.changes, args.id);
}

/** A live folder of `workspaceId` (or null). */
async function checkFolder(
  ctx: CommandContext,
  folderId: string | null,
  workspaceId: string | null,
) {
  if (!folderId) return null;
  const [folder] = await ctx.tx
    .select({ workspaceId: folders.workspaceId })
    .from(folders)
    .where(and(eq(folders.id, folderId), isNull(folders.deletedAt)));
  if (!folder || folder.workspaceId !== workspaceId)
    fail('invalid', "folder isn't in the project's workspace");
  return folderId;
}

export async function projectUpdate(
  ctx: CommandContext,
  args: CommandArgs<'project_update'>,
): Promise<void> {
  const { id, isFavorite, ...shared } = args;
  const hasShared = Object.keys(shared).length > 0;
  const project = await requireProject(
    ctx.tx,
    ctx.userId,
    id,
    hasShared ? 'manage' : 'view',
    ctx.projectIds,
  );
  if (project.isInbox && shared.name !== undefined) fail('invalid', 'the inbox cannot be renamed');

  if (isFavorite !== undefined) {
    await ctx.tx
      .update(projectMembers)
      .set({ isFavorite })
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, ctx.userId)));
    ctx.changes.forUser('projects', id, ctx.userId);
  }
  if (hasShared) {
    if (shared.visibility === 'workspace' && !project.workspaceId)
      fail('invalid', 'only workspace projects can be visible to a workspace');
    if (shared.folderId !== undefined) await checkFolder(ctx, shared.folderId, project.workspaceId);
    await ctx.tx
      .update(projects)
      .set({ ...shared, updatedAt: ctx.now })
      .where(eq(projects.id, id));
    ctx.changes.inProject('projects', id, id);
    if (shared.visibility !== undefined && shared.visibility !== project.visibility)
      await syncProjectAccess(ctx.tx, ctx.changes, id);
  }
}

export async function projectMove(
  ctx: CommandContext,
  args: CommandArgs<'project_move'>,
): Promise<void> {
  const project = await requireProject(ctx.tx, ctx.userId, args.id, 'manage', ctx.projectIds);
  if (project.isInbox) fail('invalid', 'the inbox cannot be moved');
  if (args.parentId) {
    if (args.parentId === project.id) fail('invalid', 'a project cannot be its own parent');
    const parent = await requireParent(ctx, args.parentId, project.ownerId);
    if (parent.workspaceId !== project.workspaceId)
      fail('invalid', 'sub-projects stay in their parent’s workspace');
    if ((await descendantProjects(ctx.tx, project.id)).includes(args.parentId)) {
      fail('invalid', 'cannot move a project under its own sub-project');
    }
    const depth =
      (await projectDepth(ctx.tx, args.parentId)) + (await subtreeHeight(ctx.tx, project.id));
    if (depth > LIMITS.projectDepth) fail('invalid', 'too deeply nested');
  }
  await ctx.tx
    .update(projects)
    .set({
      parentId: args.parentId,
      childOrder:
        args.childOrder ??
        (await nextOrderKey(
          ctx.tx,
          projects,
          projects.childOrder,
          siblingsOf(project.ownerId, args.parentId),
        )),
      updatedAt: ctx.now,
    })
    .where(eq(projects.id, project.id));
  ctx.changes.inProject('projects', project.id, project.id);
}

async function setArchived(ctx: CommandContext, id: string, isArchived: boolean): Promise<void> {
  const project = await requireProject(ctx.tx, ctx.userId, id, 'manage', ctx.projectIds);
  if (project.isInbox) fail('invalid', 'the inbox cannot be archived');
  const ids = [project.id, ...(await descendantProjects(ctx.tx, project.id))];
  await ctx.tx
    .update(projects)
    .set({ isArchived, updatedAt: ctx.now })
    .where(inArray(projects.id, ids));
  for (const pid of ids) ctx.changes.inProject('projects', pid, pid);
  await logActivity(ctx.tx, ctx.userId, {
    projectId: id,
    type: isArchived ? 'project_archived' : 'project_unarchived',
  });
}

export const projectArchive = (ctx: CommandContext, args: CommandArgs<'project_archive'>) =>
  setArchived(ctx, args.id, true);
export const projectUnarchive = (ctx: CommandContext, args: CommandArgs<'project_unarchive'>) =>
  setArchived(ctx, args.id, false);

export async function projectDelete(
  ctx: CommandContext,
  args: CommandArgs<'project_delete'>,
): Promise<void> {
  const project = await requireProject(ctx.tx, ctx.userId, args.id, 'delete', ctx.projectIds);
  if (project.isInbox) fail('invalid', 'the inbox cannot be deleted');
  // Sections and tasks become invisible with their project; clients drop them locally.
  const ids = [project.id, ...(await descendantProjects(ctx.tx, project.id))];
  await ctx.tx
    .update(projects)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(inArray(projects.id, ids));
  for (const pid of ids) ctx.changes.inProject('projects', pid, pid);
}

/**
 * Move a top-level project and its sub-projects into a workspace (where it starts out visible
 * only to its existing members) or back to personal (workspace-granted access ends).
 */
export async function projectMoveWorkspace(
  ctx: CommandContext,
  args: CommandArgs<'project_move_workspace'>,
): Promise<void> {
  const project = await requireProject(ctx.tx, ctx.userId, args.id, 'delete', ctx.projectIds);
  if (project.isInbox) fail('invalid', 'the inbox stays personal');
  if (project.parentId) fail('invalid', 'move the top-level project instead');
  if (args.workspaceId === project.workspaceId) return;
  if (args.workspaceId) await requireWorkspace(ctx.tx, ctx.userId, args.workspaceId, 'member');
  const ids = [project.id, ...(await descendantProjects(ctx.tx, project.id))];
  await ctx.tx
    .update(projects)
    .set({
      workspaceId: args.workspaceId,
      folderId: null,
      visibility: 'restricted',
      updatedAt: ctx.now,
    })
    .where(inArray(projects.id, ids));
  for (const id of ids) {
    ctx.changes.inProject('projects', id, id);
    await syncProjectAccess(ctx.tx, ctx.changes, id);
  }
}
