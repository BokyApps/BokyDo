import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { audit } from '../audit.js';
import type { Database } from '../db/client.js';
import {
  projectMembers,
  projects,
  tasks,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import type { SyncService } from '../sync/sync-service.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** What stops an account from being deleted: things other people still rely on. */
export interface DeletionBlockers {
  /** Projects the user owns that someone else can see: transfer or delete them first. */
  projects: { id: string; name: string }[];
  /** Teams the user owns that have other members: transfer them first. */
  workspaces: { id: string; name: string }[];
  /** The last active administrator can't delete their account (nobody could run the instance). */
  lastAdmin: boolean;
}

export const hasBlockers = (b: DeletionBlockers) =>
  b.projects.length > 0 || b.workspaces.length > 0 || b.lastAdmin;

export async function deletionBlockers(
  db: Database | Tx,
  userId: string,
): Promise<DeletionBlockers> {
  const owned = await db
    .select({ id: projects.id, name: projects.name, workspaceId: projects.workspaceId })
    .from(projects)
    .where(and(eq(projects.ownerId, userId), isNull(projects.deletedAt)));
  const shared: { id: string; name: string }[] = [];
  for (const p of owned) {
    const [others] = await db
      .select({ n: count() })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, p.id), ne(projectMembers.userId, userId)));
    let teamOthers = 0;
    if (p.workspaceId) {
      const [t] = await db
        .select({ n: count() })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, p.workspaceId), ne(workspaceMembers.userId, userId)),
        );
      teamOthers = t?.n ?? 0;
    }
    if ((others?.n ?? 0) > 0 || teamOthers > 0) shared.push({ id: p.id, name: p.name });
  }
  const ownedTeams = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.role, 'owner'),
        isNull(workspaces.deletedAt),
      ),
    );
  const teams: { id: string; name: string }[] = [];
  for (const w of ownedTeams) {
    const [others] = await db
      .select({ n: count() })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, w.id), ne(workspaceMembers.userId, userId)));
    if ((others?.n ?? 0) > 0) teams.push(w);
  }
  const [me] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId));
  let lastAdmin = false;
  if (me?.isAdmin) {
    const [others] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.isAdmin, true), isNull(users.disabledAt), ne(users.id, userId)));
    lastAdmin = (others?.n ?? 0) === 0;
  }
  return { projects: shared, workspaces: teams, lastAdmin };
}

/**
 * Delete an account (GDPR erasure). Refused while it has blockers. Removes the user and, through
 * the foreign keys, everything only they had: their projects and tasks, labels, filters,
 * reminders, sessions, passkeys, tokens, app authorizations, AI keys, push subscriptions and
 * notifications. In projects that live on, their tasks and comments stay with no author, their
 * assignments lapse and collaborators' devices are told. Attachment files of deleted projects are
 * removed by the hourly attachment purge. The audit log keeps an `account.deleted` entry with the
 * user's id only.
 */
export async function deleteAccount(
  deps: { db: Database; sync: SyncService },
  userId: string,
  actor: { userId: string; ip: string | null },
): Promise<{ deleted: true } | { deleted: false; blockers: DeletionBlockers }> {
  return deps.sync.write(async (tx, changes) => {
    // Serialise with admin promotions/demotions so the last-admin check can't race.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bokydo:admins'))`);
    const blockers = await deletionBlockers(tx, userId);
    if (hasBlockers(blockers)) return { deleted: false as const, blockers };

    // Their assignments in projects that survive lapse; everyone there sees the tasks change.
    const unassigned = await tx
      .update(tasks)
      .set({ assigneeId: null, assignedById: null, updatedAt: new Date() })
      .where(
        and(
          eq(tasks.assigneeId, userId),
          sql`${tasks.projectId} in (select id from projects where owner_id <> ${userId})`,
        ),
      )
      .returning({ id: tasks.id, projectId: tasks.projectId });
    for (const t of unassigned) changes.inProject('tasks', t.id, t.projectId);

    // Shared projects they were a member of: members see the membership change.
    const memberships = await tx
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(eq(projectMembers.userId, userId), ne(projects.ownerId, userId)));
    for (const m of memberships) changes.inProject('projects', m.projectId, m.projectId);

    // Teammates see the team's member list change.
    const teammates = await tx
      .select({ workspaceId: workspaceMembers.workspaceId, userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          ne(workspaceMembers.userId, userId),
          sql`${workspaceMembers.workspaceId} in (select workspace_id from workspace_members where user_id = ${userId})`,
        ),
      );
    for (const t of teammates) changes.forUser('workspaces', t.workspaceId, t.userId);

    // Teams only they belong to go with them (and so do the team's projects, all theirs).
    const soleTeams = await tx
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          // Fully qualified on purpose: drizzle renders columns unqualified inside sql``, which
          // inside this subquery would compare `o` with itself.
          sql`not exists (select 1 from workspace_members o where o.workspace_id = "workspace_members"."workspace_id" and o.user_id <> ${userId})`,
        ),
      );
    if (soleTeams.length)
      await tx.delete(workspaces).where(
        inArray(
          workspaces.id,
          soleTeams.map((t) => t.id),
        ),
      );

    await audit(tx, {
      action: 'account.deleted',
      actorType: 'user',
      actorUserId: actor.userId === userId ? null : actor.userId,
      targetType: 'user',
      targetId: userId,
      ip: actor.ip,
      meta: { by: actor.userId === userId ? 'self' : 'admin' },
    });
    await tx.delete(users).where(eq(users.id, userId));
    return { deleted: true as const };
  });
}
