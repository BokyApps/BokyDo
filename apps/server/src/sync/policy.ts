import type { Role } from '@bokydo/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { projectMembers, projects } from '../db/schema.js';
import { fail, type Tx } from './context.js';

/**
 * The single place that decides what a user may do with a project and everything in it
 * (sections, tasks). Every command handler and every sync read goes through here.
 */
export type ProjectAction =
  | 'view'
  | 'comment'
  | 'edit' // tasks and sections
  | 'manage' // rename, archive, move, sub-projects
  | 'delete';

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3, owner: 4 };
const REQUIRED: Record<ProjectAction, Role> = {
  view: 'viewer',
  comment: 'commenter',
  edit: 'editor',
  manage: 'admin',
  delete: 'owner',
};

export function can(role: Role, action: ProjectAction): boolean {
  return RANK[role] >= RANK[REQUIRED[action]];
}

export type ProjectRow = typeof projects.$inferSelect;

/**
 * The projects a caller is limited to: a personal access token can be restricted to some of the
 * user's projects (null = no restriction). Everything outside it is treated as invisible, exactly
 * like a project the user isn't a member of.
 */
export type ProjectScope = ReadonlySet<string> | null;

export const inScope = (scope: ProjectScope, projectId: string): boolean =>
  scope === null || scope.has(projectId);

/** The live project and the user's role in it, or null if the user can't see it. */
export async function projectAccess(
  tx: Pick<Tx, 'select'>,
  userId: string,
  projectId: string,
  scope: ProjectScope = null,
): Promise<{ project: ProjectRow; role: Role; isFavorite: boolean } | null> {
  if (!inScope(scope, projectId)) return null;
  const [row] = await tx
    .select({ project: projects, role: projectMembers.role, isFavorite: projectMembers.isFavorite })
    .from(projects)
    .innerJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  return row ?? null;
}

/**
 * Load a project the user must be allowed to act on. Invisible projects (and those outside the
 * caller's `scope`) are `not_found`, indistinguishable from nonexistent; visible-but-insufficient
 * role is `forbidden`.
 */
export async function requireProject(
  tx: Tx,
  userId: string,
  projectId: string,
  action: ProjectAction,
  scope: ProjectScope,
): Promise<ProjectRow & { role: Role }> {
  const access = await projectAccess(tx, userId, projectId, scope);
  if (!access) return fail('not_found', 'project');
  if (!can(access.role, action)) return fail('forbidden', `requires ${REQUIRED[action]}`);
  return { ...access.project, role: access.role };
}

export type VisibleProjects = Map<string, { role: Role; isFavorite: boolean }>;

/** Every live project the user can see (within `scope`), with role and per-user favorite flag. */
export async function visibleProjects(
  tx: Tx,
  userId: string,
  scope: ProjectScope = null,
): Promise<VisibleProjects> {
  if (scope?.size === 0) return new Map();
  const rows = await tx
    .select({ id: projects.id, role: projectMembers.role, isFavorite: projectMembers.isFavorite })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.userId, userId), isNull(projects.deletedAt)));
  return new Map(
    rows
      .filter((r) => inScope(scope, r.id))
      .map((r) => [r.id, { role: r.role, isFavorite: r.isFavorite }]),
  );
}

export async function isProjectMember(tx: Tx, projectId: string, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return Boolean(row);
}
