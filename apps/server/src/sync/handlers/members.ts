import type { CommandArgs, GrantableRole, Role } from '@bokydo/shared';
import { and, count, eq } from 'drizzle-orm';
import { logActivity } from '../../activity/log.js';
import { notify } from '../../notifications/notify.js';
import { syncUserAccess } from '../../workspaces/access.js';
import { projectMembers, projects, tasks } from '../../db/schema.js';
import { fail, LIMITS, type ChangeRecorder, type CommandContext, type Tx } from '../context.js';
import { projectAccess, requireProject } from '../policy.js';

/**
 * Project membership. Rules:
 * - admins and owners manage members; only the owner changes or removes admins;
 * - nobody can grant "owner": ownership moves only by transfer, from the owner;
 * - anyone except the owner can leave; the inbox is never shared.
 * Each change tells the affected user's next sync to add or drop the whole project.
 */

async function memberRole(tx: Tx, projectId: string, userId: string): Promise<Role | null> {
  const [row] = await tx
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return row?.role ?? null;
}

function announce(changes: ChangeRecorder, projectId: string, userId: string) {
  changes.forUser('project_access', projectId, userId);
  changes.inProject('projects', projectId, projectId);
}

/** Add someone (or change their role) inside the caller's transaction. Used by invitations. */
export async function addMember(
  tx: Tx,
  changes: ChangeRecorder,
  projectId: string,
  userId: string,
  role: GrantableRole,
): Promise<void> {
  const existing = await memberRole(tx, projectId, userId);
  if (existing === 'owner') return;
  if (!existing) {
    const [n] = await tx
      .select({ n: count() })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId));
    if ((n?.n ?? 0) >= LIMITS.membersPerProject) fail('limit_exceeded', 'too many members');
  }
  await tx
    .insert(projectMembers)
    .values({ projectId, userId, role })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role, source: 'direct' },
    });
  announce(changes, projectId, userId);
}

export async function projectMemberUpdate(
  ctx: CommandContext,
  args: CommandArgs<'project_member_update'>,
): Promise<void> {
  const project = await requireProject(
    ctx.tx,
    ctx.userId,
    args.projectId,
    'manage',
    ctx.projectIds,
  );
  const target = await memberRole(ctx.tx, project.id, args.userId);
  if (!target) return fail('not_found', 'member');
  if (target === 'owner') fail('forbidden', 'transfer ownership instead');
  if (project.role !== 'owner') {
    // Admins manage everyone below them; only the owner creates or changes admins (an admin
    // may still step down).
    const self = args.userId === ctx.userId;
    if (target === 'admin' && !self) fail('forbidden', 'only the owner manages admins');
    if (args.role === 'admin' && target !== 'admin')
      fail('forbidden', 'only the owner manages admins');
  }
  if (target === args.role) return;
  // An explicit role is a direct share from now on (workspace changes no longer touch it).
  await ctx.tx
    .update(projectMembers)
    .set({ role: args.role, source: 'direct' })
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, args.userId)));
  announce(ctx.changes, project.id, args.userId);
  await notify(ctx.tx, ctx.changes, ctx.userId, {
    userId: args.userId,
    type: 'role_changed',
    projectId: project.id,
    data: { projectName: project.name, role: args.role },
  });
  await logActivity(ctx.tx, ctx.userId, {
    projectId: project.id,
    type: 'member_role_changed',
    data: { userId: args.userId, from: target, role: args.role },
  });
}

export async function projectMemberRemove(
  ctx: CommandContext,
  args: CommandArgs<'project_member_remove'>,
): Promise<void> {
  const leaving = args.userId === ctx.userId;
  const access = await projectAccess(ctx.tx, ctx.userId, args.projectId, ctx.projectIds);
  if (!access) return fail('not_found', 'project');
  const target = leaving ? access.role : await memberRole(ctx.tx, args.projectId, args.userId);
  if (!target) return fail('not_found', 'member');
  if (target === 'owner')
    fail(
      'forbidden',
      leaving ? 'transfer ownership before leaving' : 'the owner cannot be removed',
    );
  if (!leaving) {
    if (access.role !== 'owner' && access.role !== 'admin') fail('forbidden', 'requires admin');
    if (target === 'admin' && access.role !== 'owner')
      fail('forbidden', 'only the owner removes admins');
  }
  const [row] = await ctx.tx
    .select({ source: projectMembers.source })
    .from(projectMembers)
    .where(
      and(eq(projectMembers.projectId, args.projectId), eq(projectMembers.userId, args.userId)),
    );
  if (row?.source === 'workspace')
    fail(
      'forbidden',
      'access comes from the workspace: make the project restricted or remove them from the workspace',
    );
  await ctx.tx
    .delete(projectMembers)
    .where(
      and(eq(projectMembers.projectId, args.projectId), eq(projectMembers.userId, args.userId)),
    );
  // Their assignments in this project lapse; everyone else sees the tasks change.
  const unassigned = await ctx.tx
    .update(tasks)
    .set({ assigneeId: null, assignedById: null, updatedAt: ctx.now })
    .where(and(eq(tasks.projectId, args.projectId), eq(tasks.assigneeId, args.userId)))
    .returning({ id: tasks.id });
  for (const t of unassigned) ctx.changes.inProject('tasks', t.id, args.projectId);
  announce(ctx.changes, args.projectId, args.userId);
  // A direct member of a workspace-visible project keeps the access the workspace gives.
  if (access.project.workspaceId)
    await syncUserAccess(ctx.tx, ctx.changes, access.project.workspaceId, args.userId);
  if (!leaving)
    // No project link: they can't open it any more, only see that they were removed.
    await notify(ctx.tx, ctx.changes, ctx.userId, {
      userId: args.userId,
      type: 'removed_from_project',
      data: { projectName: access.project.name },
    });
  await logActivity(ctx.tx, ctx.userId, {
    projectId: args.projectId,
    type: leaving ? 'member_left' : 'member_removed',
    data: { userId: args.userId },
  });
}

export async function projectTransfer(
  ctx: CommandContext,
  args: CommandArgs<'project_transfer'>,
): Promise<void> {
  const project = await requireProject(
    ctx.tx,
    ctx.userId,
    args.projectId,
    'delete',
    ctx.projectIds,
  );
  if (args.userId === ctx.userId) return;
  if (project.isInbox) fail('invalid', 'the inbox cannot be transferred');
  const target = await memberRole(ctx.tx, project.id, args.userId);
  if (!target) return fail('not_found', 'member');
  await ctx.tx
    .update(projectMembers)
    .set({ role: 'owner' })
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, args.userId)));
  await ctx.tx
    .update(projectMembers)
    .set({ role: 'admin' })
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, ctx.userId)));
  await ctx.tx
    .update(projects)
    .set({ ownerId: args.userId, updatedAt: ctx.now })
    .where(eq(projects.id, project.id));
  announce(ctx.changes, project.id, args.userId);
  announce(ctx.changes, project.id, ctx.userId);
  await notify(ctx.tx, ctx.changes, ctx.userId, {
    userId: args.userId,
    type: 'became_owner',
    projectId: project.id,
    data: { projectName: project.name },
  });
  await logActivity(ctx.tx, ctx.userId, {
    projectId: project.id,
    type: 'owner_transferred',
    data: { userId: args.userId },
  });
}
