import {
  commandArgs,
  resolvePreferences,
  ENTITY_TYPES,
  type CommandResult,
  type CommandType,
  type EntityType,
  type SyncRequest,
  type Comment,
  type SyncResponse,
} from '@bokydo/shared';
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  attachments,
  changes,
  commentReactions,
  comments,
  filters,
  folders,
  labels,
  processedCommands,
  projectMembers,
  projects,
  reminders,
  sections,
  tasks,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import { refreshTaskReminders, reminderToWire } from '../reminders/reminders.js';
import {
  ChangeRecorder,
  CommandFailure,
  WRITE_LOCK,
  type CommandContext,
  type Tx,
} from './context.js';
import { pgCode } from './handlers/common.js';
import { pendingInvites } from '../projects/invites.js';
import { latestNotifications } from '../notifications/notify.js';
import * as h from './handlers/index.js';
import { visibleProjects, type VisibleProjects } from './policy.js';
import {
  commentToWire,
  filterToWire,
  labelToWire,
  projectToWire,
  sectionToWire,
  taskToWire,
} from './serialize.js';

/** Change markers for data sent whole in every response (they only poke clients). */
const PER_RESPONSE = new Set(['user', 'invitations', 'notifications', 'workspaces']);

/** Completed tasks older than this are left out of a full sync (fetched on demand instead). */
const COMPLETED_WINDOW_DAYS = 7;

type Handler = (ctx: CommandContext, args: never) => Promise<unknown>;
const HANDLERS: Record<CommandType, Handler> = {
  project_add: h.projectAdd,
  project_update: h.projectUpdate,
  project_move: h.projectMove,
  project_archive: h.projectArchive,
  project_unarchive: h.projectUnarchive,
  project_delete: h.projectDelete,
  section_add: h.sectionAdd,
  section_update: h.sectionUpdate,
  section_move: h.sectionMove,
  section_archive: h.sectionArchive,
  section_unarchive: h.sectionUnarchive,
  section_delete: h.sectionDelete,
  task_add: h.taskAdd,
  task_update: h.taskUpdate,
  task_move: h.taskMove,
  task_complete: h.taskComplete,
  task_uncomplete: h.taskUncomplete,
  task_delete: h.taskDelete,
  label_add: h.labelAdd,
  label_update: h.labelUpdate,
  label_delete: h.labelDelete,
  filter_add: h.filterAdd,
  filter_update: h.filterUpdate,
  filter_delete: h.filterDelete,
  user_update_preferences: h.userUpdatePreferences,
  project_member_update: h.projectMemberUpdate,
  project_member_remove: h.projectMemberRemove,
  project_transfer: h.projectTransfer,
  comment_add: h.commentAdd,
  comment_update: h.commentUpdate,
  comment_delete: h.commentDelete,
  reaction_toggle: h.reactionToggle,
  notifications_mark_read: h.notificationsMarkRead,
  workspace_add: h.workspaceAdd,
  workspace_update: h.workspaceUpdate,
  workspace_delete: h.workspaceDelete,
  workspace_member_update: h.workspaceMemberUpdate,
  workspace_member_remove: h.workspaceMemberRemove,
  workspace_transfer: h.workspaceTransfer,
  folder_add: h.folderAdd,
  folder_update: h.folderUpdate,
  folder_delete: h.folderDelete,
  project_move_workspace: h.projectMoveWorkspace,
  reminder_add: h.reminderAdd,
  reminder_delete: h.reminderDelete,
};

export interface Affected {
  projectIds: Set<string>;
  userIds: Set<string>;
}

export class SyncService {
  constructor(
    private readonly db: Database,
    private readonly onCommitted: (affected: Affected) => void = () => undefined,
    private readonly defaultTimeZone: () => string = () => 'UTC',
  ) {}

  private context(tx: Tx, userId: string, changes: ChangeRecorder): CommandContext {
    return { tx, userId, now: new Date(), changes, defaultTimeZone: this.defaultTimeZone() };
  }

  /**
   * A write outside the command stream (e.g. accepting an invitation): same global write lock,
   * same change log, and connected clients are poked afterwards.
   */
  async write<T>(fn: (tx: Tx, changes: ChangeRecorder) => Promise<T>): Promise<T> {
    const recorder = new ChangeRecorder();
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(WRITE_LOCK);
      const value = await fn(tx, recorder);
      await this.afterWrite(tx, recorder);
      await recorder.flush(tx);
      return value;
    });
    if (!recorder.isEmpty)
      this.onCommitted({ projectIds: recorder.projectScopes, userIds: recorder.userScopes });
    return result;
  }

  async sync(userId: string, request: SyncRequest): Promise<SyncResponse> {
    const results: Record<string, CommandResult> = {};
    for (const command of request.commands ?? []) {
      results[command.uuid] = await this.apply(userId, command.type, command.uuid, command.args);
    }
    await this.ensureInbox(userId);
    return { ...(await this.read(userId, request.cursor ?? null)), results };
  }

  /** Apply one command in its own transaction. Replaying a command UUID returns the first result. */
  async apply(
    userId: string,
    type: CommandType,
    uuid: string,
    rawArgs: unknown,
  ): Promise<CommandResult> {
    const recorder = new ChangeRecorder();
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(WRITE_LOCK);
      const [done] = await tx
        .select({ result: processedCommands.result })
        .from(processedCommands)
        .where(and(eq(processedCommands.userId, userId), eq(processedCommands.uuid, uuid)));
      if (done) return done.result as CommandResult;

      let result: CommandResult;
      const parsed = commandArgs[type].safeParse(rawArgs);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        result = {
          ok: false,
          error: 'invalid',
          message: issue ? `${issue.path.join('.')}: ${issue.message}` : undefined,
        } as CommandResult;
      } else {
        result = await this.runHandler(tx, userId, type, parsed.data, recorder);
      }
      if (result.ok) {
        await this.afterWrite(tx, recorder);
        await recorder.flush(tx);
      }
      await tx.insert(processedCommands).values({ userId, uuid, result });
      return result;
    });
    if (result.ok && !recorder.isEmpty) {
      this.onCommitted({ projectIds: recorder.projectScopes, userIds: recorder.userScopes });
    }
    return result;
  }

  /** Derived state that follows task changes: reminder times and automatic reminders. */
  private async afterWrite(tx: Tx, recorder: ChangeRecorder): Promise<void> {
    await refreshTaskReminders(tx, recorder, recorder.touched('tasks'), this.defaultTimeZone());
  }

  private async runHandler(
    tx: Tx,
    userId: string,
    type: CommandType,
    args: unknown,
    recorder: ChangeRecorder,
  ): Promise<CommandResult> {
    try {
      // Savepoint: a failing command rolls back its own partial writes only.
      await tx.transaction(async (sp) => {
        await HANDLERS[type](this.context(sp, userId, recorder), args as never);
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof CommandFailure)
        return { ok: false, error: err.code, message: err.message };
      if (pgCode(err) === '23505') return { ok: false, error: 'conflict' };
      if (pgCode(err) === '23503') return { ok: false, error: 'not_found' };
      throw err;
    }
  }

  private async ensureInbox(userId: string): Promise<void> {
    const [inbox] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.ownerId, userId), eq(projects.isInbox, true), isNull(projects.deletedAt)),
      );
    if (inbox) return;
    const recorder = new ChangeRecorder();
    await this.db.transaction(async (tx) => {
      await tx.execute(WRITE_LOCK);
      await h.ensureInbox(this.context(tx, userId, recorder));
      await recorder.flush(tx);
    });
  }

  /**
   * Everything the user should know since `cursor`. Changes are only markers: we re-load each
   * entity and re-check visibility now, so anything deleted, moved away or no longer shared
   * becomes a removal, and nothing outside the user's scopes is ever read.
   */
  async read(userId: string, cursor: string | null): Promise<Omit<SyncResponse, 'results'>> {
    return this.db.transaction(
      async (tx) => {
        const [head] = await tx
          .select({ seq: sql<number>`coalesce(max(${changes.seq}), 0)::bigint` })
          .from(changes);
        const headSeq = Number(head?.seq ?? 0);
        const visible = await visibleProjects(tx, userId);
        const [user] = await tx.select().from(users).where(eq(users.id, userId));
        const inbox = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.ownerId, userId),
              eq(projects.isInbox, true),
              isNull(projects.deletedAt),
            ),
          );
        const team = await this.team(tx, userId, [...visible.keys()]);
        const base = {
          ...team,
          cursor: String(headSeq),
          user: {
            id: userId,
            username: user?.username ?? '',
            isAdmin: user?.isAdmin ?? false,
            inboxProjectId: inbox[0]?.id ?? '',
            preferences: resolvePreferences(user?.preferences),
          },
        };

        const since = cursor === null ? null : Number(cursor);
        if (since === null || !Number.isSafeInteger(since) || since > headSeq) {
          return { ...base, fullSync: true, ...(await this.snapshot(tx, userId, visible)) };
        }
        return {
          ...base,
          fullSync: false,
          ...(await this.delta(tx, userId, visible, since, headSeq)),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /** Memberships of every visible project, and the people behind them (always complete). */
  /**
   * People, memberships, workspaces, folders, invitations and notifications: small, and sent
   * whole with every response. Workspace guests see only themselves in a workspace's member list.
   */
  private async team(tx: Tx, userId: string, projectIds: string[]) {
    const invitations = await pendingInvites(tx, userId);
    const inbox = await latestNotifications(tx, userId);
    const mine = await tx
      .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)));
    const full = mine.filter((w) => w.role !== 'guest').map((w) => w.id);
    const wsRows = full.length
      ? await tx
          .select({
            workspaceId: workspaceMembers.workspaceId,
            userId: workspaceMembers.userId,
            role: workspaceMembers.role,
            username: users.username,
          })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(inArray(workspaceMembers.workspaceId, full))
      : [];
    const folderRows = mine.length
      ? await tx
          .select()
          .from(folders)
          .where(
            and(
              inArray(
                folders.workspaceId,
                mine.map((w) => w.id),
              ),
              isNull(folders.deletedAt),
            ),
          )
      : [];
    const rows = projectIds.length
      ? await tx
          .select({
            projectId: projectMembers.projectId,
            userId: projectMembers.userId,
            role: projectMembers.role,
            username: users.username,
          })
          .from(projectMembers)
          .innerJoin(users, eq(users.id, projectMembers.userId))
          .where(inArray(projectMembers.projectId, projectIds))
      : [];
    const people = new Map(
      [...rows, ...wsRows].map((r) => [r.userId, { id: r.userId, username: r.username }]),
    );
    return {
      collaborators: [...people.values()],
      members: rows.map(({ projectId, userId, role }) => ({ projectId, userId, role })),
      workspaces: mine,
      workspaceMembers: [
        ...wsRows.map(({ workspaceId, userId, role }) => ({ workspaceId, userId, role })),
        ...mine
          .filter((w) => w.role === 'guest')
          .map((w) => ({ workspaceId: w.id, userId, role: w.role })),
      ],
      folders: folderRows.map((f) => ({
        id: f.id,
        workspaceId: f.workspaceId,
        name: f.name,
        childOrder: f.childOrder,
      })),
      invitations,
      ...inbox,
    };
  }

  private async snapshot(tx: Tx, userId: string, visible: VisibleProjects) {
    const projectIds = [...visible.keys()];
    const cutoff = new Date(Date.now() - COMPLETED_WINDOW_DAYS * 86_400_000);
    const [p, s, t, l, f] = projectIds.length
      ? await Promise.all([
          tx.select().from(projects).where(inArray(projects.id, projectIds)),
          tx
            .select()
            .from(sections)
            .where(and(inArray(sections.projectId, projectIds), isNull(sections.deletedAt))),
          tx
            .select()
            .from(tasks)
            .where(
              and(
                inArray(tasks.projectId, projectIds),
                isNull(tasks.deletedAt),
                or(eq(tasks.isCompleted, false), gt(tasks.completedAt, cutoff)),
              ),
            ),
          this.userLabels(tx, userId),
          this.userFilters(tx, userId),
        ])
      : [[], [], [], await this.userLabels(tx, userId), await this.userFilters(tx, userId)];
    const taskIds = new Set(t.map((x) => x.id));
    const c = projectIds.length
      ? (
          await this.loadComments(
            tx,
            and(inArray(comments.projectId, projectIds), isNull(comments.deletedAt)),
          )
        ).filter((x) => x.taskId === null || taskIds.has(x.taskId))
      : [];
    return {
      projects: p.map((row) => projectToWire(row, member(visible, row.id))),
      sections: s.map(sectionToWire),
      tasks: t.map(taskToWire),
      labels: l.map(labelToWire),
      filters: f.map(filterToWire),
      comments: c,
      reminders: (await this.userReminders(tx, userId)).filter((r) => taskIds.has(r.taskId)),
      removed: emptyRemoved(),
    };
  }

  private async delta(
    tx: Tx,
    userId: string,
    visible: VisibleProjects,
    since: number,
    head: number,
  ) {
    // Scopes include projects the user is still a member of even if deleted, so deletions reach them.
    const memberOf = (
      await tx
        .select({ id: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, userId))
    ).map((r) => r.id);
    const scope = memberOf.length
      ? or(inArray(changes.projectId, memberOf), eq(changes.userId, userId))
      : eq(changes.userId, userId);
    const marked = await tx
      .selectDistinct({ type: changes.entityType, id: changes.entityId })
      .from(changes)
      .where(and(gt(changes.seq, since), lte(changes.seq, head), scope));

    const ids: Record<EntityType, Set<string>> = {
      projects: new Set(),
      sections: new Set(),
      tasks: new Set(),
      labels: new Set(),
      filters: new Set(),
      comments: new Set(),
      reminders: new Set(),
    };
    const granted: string[] = [];
    for (const m of marked) {
      if (m.type === 'project_access') granted.push(m.id);
      // The user row, memberships, invitations and notifications are in every response.
      else if (!PER_RESPONSE.has(m.type)) ids[m.type as EntityType].add(m.id);
    }

    const isVisible = (projectId: string) => visible.has(projectId);
    const deletedComments = new Set(
      ids.comments.size
        ? (
            await tx
              .select({ id: comments.id })
              .from(comments)
              .where(and(inArray(comments.id, [...ids.comments]), isNotNull(comments.deletedAt)))
          ).map((r) => r.id)
        : [],
    );
    const load = <T>(set: Set<string>, fn: (list: string[]) => Promise<T[]>) =>
      set.size ? fn([...set]) : Promise.resolve([]);
    const [p, s, t, l, f] = await Promise.all([
      load(ids.projects, (list) => tx.select().from(projects).where(inArray(projects.id, list))),
      load(ids.sections, (list) => tx.select().from(sections).where(inArray(sections.id, list))),
      load(ids.tasks, (list) => tx.select().from(tasks).where(inArray(tasks.id, list))),
      load(ids.labels, (list) =>
        tx
          .select()
          .from(labels)
          .where(
            and(inArray(labels.id, list), eq(labels.userId, userId), isNull(labels.deletedAt)),
          ),
      ),
      load(ids.filters, (list) =>
        tx
          .select()
          .from(filters)
          .where(
            and(inArray(filters.id, list), eq(filters.userId, userId), isNull(filters.deletedAt)),
          ),
      ),
    ]);

    const c = ids.comments.size
      ? (await this.loadComments(tx, inArray(comments.id, [...ids.comments]))).filter(
          (x) => isVisible(x.projectId) && !deletedComments.has(x.id),
        )
      : [];
    const r = ids.reminders.size
      ? (
          await tx
            .select({
              reminder: reminders,
              projectId: tasks.projectId,
              taskDeleted: tasks.deletedAt,
            })
            .from(reminders)
            .innerJoin(tasks, eq(tasks.id, reminders.taskId))
            .where(and(inArray(reminders.id, [...ids.reminders]), eq(reminders.userId, userId)))
        )
          .filter((x) => !x.reminder.deletedAt && !x.taskDeleted && isVisible(x.projectId))
          .map((x) => reminderToWire(x.reminder))
      : [];
    const out = {
      comments: c,
      reminders: r,
      projects: p
        .filter((r) => isVisible(r.id) && !r.deletedAt)
        .map((r) => projectToWire(r, member(visible, r.id))),
      sections: s.filter((r) => isVisible(r.projectId) && !r.deletedAt).map(sectionToWire),
      tasks: t.filter((r) => isVisible(r.projectId) && !r.deletedAt).map(taskToWire),
      labels: l.map(labelToWire),
      filters: f.map(filterToWire),
    };

    // Newly granted projects: send their full contents (earlier changes predate the user's access).
    const newlyVisible = granted.filter(isVisible);
    if (newlyVisible.length) {
      const known = new Set(out.projects.map((x) => x.id));
      const [gp, gs, gt] = await Promise.all([
        tx.select().from(projects).where(inArray(projects.id, newlyVisible)),
        tx
          .select()
          .from(sections)
          .where(and(inArray(sections.projectId, newlyVisible), isNull(sections.deletedAt))),
        tx
          .select()
          .from(tasks)
          .where(
            and(
              inArray(tasks.projectId, newlyVisible),
              isNull(tasks.deletedAt),
              eq(tasks.isCompleted, false),
            ),
          ),
      ]);
      out.projects.push(
        ...gp.filter((r) => !known.has(r.id)).map((r) => projectToWire(r, member(visible, r.id))),
      );
      out.sections.push(...gs.map(sectionToWire));
      out.tasks.push(...gt.map(taskToWire));
      const grantedTasks = new Set(gt.map((x) => x.id));
      out.comments.push(
        ...(
          await this.loadComments(
            tx,
            and(inArray(comments.projectId, newlyVisible), isNull(comments.deletedAt)),
          )
        ).filter((x) => x.taskId === null || grantedTasks.has(x.taskId)),
      );
      out.reminders.push(
        ...(await this.userReminders(tx, userId)).filter((x) => grantedTasks.has(x.taskId)),
      );
    }
    // Revoked projects: tell the client to drop them.
    for (const id of granted) if (!isVisible(id)) ids.projects.add(id);

    const sent = (list: { id: string }[]) => new Set(list.map((x) => x.id));
    const removed = emptyRemoved();
    for (const type of ENTITY_TYPES) {
      const kept = sent(out[type]);
      removed[type] = [...ids[type]].filter((id) => !kept.has(id));
    }
    return { ...out, removed };
  }

  /** The user's live reminders (callers keep those on tasks they send). */
  private async userReminders(tx: Tx, userId: string) {
    const rows = await tx
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), isNull(reminders.deletedAt)));
    return rows.map(reminderToWire);
  }

  /** Comments with their reactions folded in. */
  private async loadComments(tx: Tx, where: SQL | undefined): Promise<Comment[]> {
    const rows = await tx.select().from(comments).where(where);
    if (rows.length === 0) return [];
    const reactions = await tx
      .select()
      .from(commentReactions)
      .where(
        inArray(
          commentReactions.commentId,
          rows.map((r) => r.id),
        ),
      );
    const byComment = new Map<string, Comment['reactions']>();
    for (const r of reactions) {
      const map = byComment.get(r.commentId) ?? {};
      const emoji = r.emoji as keyof Comment['reactions'];
      (map[emoji] ??= []).push(r.userId);
      byComment.set(r.commentId, map);
    }
    const files = await tx
      .select({
        commentId: attachments.commentId,
        id: attachments.id,
        filename: attachments.filename,
        contentType: attachments.contentType,
        size: attachments.size,
      })
      .from(attachments)
      .where(
        and(
          inArray(
            attachments.commentId,
            rows.map((r) => r.id),
          ),
          isNull(attachments.deletedAt),
        ),
      )
      .orderBy(attachments.createdAt);
    const filesByComment = new Map<string, Comment['attachments']>();
    for (const { commentId, ...file } of files) {
      if (!commentId) continue;
      const list = filesByComment.get(commentId) ?? [];
      list.push(file);
      filesByComment.set(commentId, list);
    }
    return rows.map((r) =>
      commentToWire(r, byComment.get(r.id) ?? {}, filesByComment.get(r.id) ?? []),
    );
  }

  private userLabels(tx: Tx, userId: string) {
    return tx
      .select()
      .from(labels)
      .where(and(eq(labels.userId, userId), isNull(labels.deletedAt)));
  }

  private userFilters(tx: Tx, userId: string) {
    return tx
      .select()
      .from(filters)
      .where(and(eq(filters.userId, userId), isNull(filters.deletedAt)));
  }
}

function member(visible: VisibleProjects, projectId: string) {
  const m = visible.get(projectId);
  if (!m) throw new Error('serialising a project the user cannot see');
  return m;
}

function emptyRemoved(): Record<EntityType, string[]> {
  return {
    projects: [],
    sections: [],
    tasks: [],
    labels: [],
    filters: [],
    comments: [],
    reminders: [],
  };
}
