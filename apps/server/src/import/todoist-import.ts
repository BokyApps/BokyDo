import { localNow } from '@bokydo/nlp';
import {
  resolvePreferences,
  TODOIST_IMPORT_LIMITS,
  type TodoistCompletedWindow,
  type CommandType,
  type Due,
  type TodoistImportChoices,
  type TodoistImportCounts,
  type TodoistImportPlanSummary,
  type TodoistImportRun,
  type TodoistImportWarning,
  type TodoistPreview,
} from '@bokydo/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  comments,
  filters,
  importMappings,
  imports,
  labels,
  projectMembers,
  projects,
  sections,
  tasks,
  users,
} from '../db/schema.js';
import type { OutboundFetch } from '../net/outbound.js';
import { allOf, nextOrderKey } from '../sync/handlers/common.js';
import { dueColumns } from '../sync/handlers/tasks.js';
import type { ChangeRecorder, Tx } from '../sync/context.js';
import { visibleProjects } from '../sync/policy.js';
import type { SyncService } from '../sync/sync-service.js';
import {
  fetchTodoistCompleted,
  fetchTodoistSnapshot,
  hasCompletionDate,
  TODOIST_COMPLETED_MAX_MONTHS,
  type TodoistCompletedTask,
  type TodoistSnapshot,
} from './todoist-client.js';
import {
  filterReferences,
  isSupportedFilter,
  mappingKey,
  planImport,
  type CompletedStep,
  type MappingKind,
  type Plan,
  type PlannedStep,
} from './todoist-plan.js';

const WRITABLE = new Set(['owner', 'admin', 'editor']);
/** Commands per transaction: small enough not to hold the global write lock for long. */
const CHUNK = 200;
const MAX_WARNINGS = 300;
/** Snapshots held in memory at once (each up to the response cap): oldest dropped first. */
const MAX_SESSIONS = 8;

interface Session {
  userId: string;
  snapshot: TodoistSnapshot;
  expiresAt: number;
  /** The account's completed tasks read at connect (Todoist's capped window). */
  completed: TodoistCompletedTask[];
}

export class ImportSessionError extends Error {
  constructor(readonly code: 'session_expired' | 'import_running' | 'invalid_choice') {
    super(code);
  }
}

/**
 * Todoist import (PLAN W11a, ADR 0020). The token is used for one read and dropped; the snapshot
 * lives in memory for a short session (preview, dry run, run) and is never written anywhere. The
 * run applies the plan through `SyncService.applyAll` in chunks, recording which BokyDo item each
 * Todoist item became in the same transaction, so an interrupted or repeated import never
 * duplicates anything.
 */
export class TodoistImporter {
  private readonly sessions = new Map<string, Session>();
  private readonly running = new Set<string>();

  constructor(
    private readonly deps: {
      db: Database;
      sync: SyncService;
      fetch: OutboundFetch;
      defaultTimeZone: () => string;
      log: FastifyBaseLogger;
    },
  ) {}

  /** After a restart nothing is running: a run cut short is marked failed (re-running resumes). */
  async recover(): Promise<void> {
    await this.deps.db
      .update(imports)
      .set({ status: 'failed', error: 'interrupted', finishedAt: new Date() })
      .where(eq(imports.status, 'running'));
  }

  /** Read the Todoist account and open a preview session (replacing the user's previous one). */
  async connect(userId: string, token: string): Promise<TodoistPreview> {
    const snapshot = await fetchTodoistSnapshot(this.deps.fetch, token);
    // The same token, still only for this read: the account's completed tasks over Todoist's
    // capped window, so the preview can count them before the user chooses (W11a-c1).
    const until = new Date();
    const since = new Date(until);
    since.setMonth(since.getMonth() - TODOIST_COMPLETED_MAX_MONTHS);
    const completed = await fetchTodoistCompleted(this.deps.fetch, token, { since, until });
    this.sweep();
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const sessionId = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + TODOIST_IMPORT_LIMITS.sessionMinutes * 60_000;
    this.sessions.set(sessionId, { userId, snapshot, expiresAt, completed });
    return this.preview(userId, sessionId, snapshot, expiresAt, completed);
  }

  /** Forget the snapshot now (the user closed the import). */
  disconnect(userId: string, sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s?.userId === userId) this.sessions.delete(sessionId);
  }

  async plan(userId: string, choices: TodoistImportChoices): Promise<TodoistImportPlanSummary> {
    const { plan } = await this.build(userId, choices);
    return summary(plan.counts, plan.warnings);
  }

  async start(userId: string, choices: TodoistImportChoices): Promise<{ id: string }> {
    if (this.running.has(userId)) throw new ImportSessionError('import_running');
    const { plan } = await this.build(userId, choices);
    const id = newId();
    this.running.add(userId);
    try {
      await this.deps.db.transaction(async (tx) => {
        const [busy] = await tx
          .select({ id: imports.id })
          .from(imports)
          .where(and(eq(imports.userId, userId), eq(imports.status, 'running')))
          .for('update');
        if (busy) throw new ImportSessionError('import_running');
        await tx.insert(imports).values({
          id,
          userId,
          source: 'todoist',
          status: 'running',
          total: plan.steps.length + plan.completed.length,
          warnings: [],
        });
      });
    } catch (err) {
      this.running.delete(userId);
      throw err;
    }
    void this.execute(userId, id, plan).finally(() => this.running.delete(userId));
    return { id };
  }

  /** Resolves when the user's running import (if any) has finished: for tests. */
  async idle(userId: string): Promise<void> {
    while (this.running.has(userId)) await new Promise((r) => setTimeout(r, 20));
  }

  async status(userId: string, id: string): Promise<TodoistImportRun | null> {
    const [row] = await this.deps.db
      .select()
      .from(imports)
      .where(and(eq(imports.id, id), eq(imports.userId, userId)));
    return row ? toRun(row) : null;
  }

  async latest(userId: string): Promise<TodoistImportRun | null> {
    const [row] = await this.deps.db
      .select()
      .from(imports)
      .where(eq(imports.userId, userId))
      .orderBy(desc(imports.startedAt))
      .limit(1);
    return row ? toRun(row) : null;
  }

  // ---- internals ----

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(id);
  }

  private session(userId: string, sessionId: string): Session {
    this.sweep();
    const s = this.sessions.get(sessionId);
    // Someone else's session id answers exactly like an expired one.
    if (!s || s.userId !== userId) throw new ImportSessionError('session_expired');
    return s;
  }

  private async build(userId: string, choices: TodoistImportChoices) {
    const s = this.session(userId, choices.sessionId);
    // Read at connect (Todoist's read window is capped at 3 months there); the choice only
    // filters it, so the further-back history is out of scope rather than a second fetch.
    const completed = choices.completed ? withinWindow(s.completed, choices.completedWindow) : [];
    const known = new Set(s.snapshot.projects.map((p) => p.id));
    if (choices.projects.some((p) => !known.has(p.id)))
      throw new ImportSessionError('invalid_choice');
    const ctx = await this.context(
      userId,
      choices.projects.flatMap((p) => (p.targetId ? [p.targetId] : [])),
    );
    for (const p of choices.projects)
      if (p.targetId && !ctx.writable.has(p.targetId))
        throw new ImportSessionError('invalid_choice');
    const plan = planImport({
      snapshot: s.snapshot,
      completed,
      choices: {
        projects: choices.projects,
        labels: choices.labels,
        filters: choices.filters,
        comments: choices.comments,
        people: choices.people,
      },
      userId,
      imported: ctx.imported,
      labelNames: ctx.labelNames,
      members: ctx.members,
      dates: ctx.dates,
    });
    return { plan, snapshot: s.snapshot };
  }

  /** What exists on the BokyDo side that the plan depends on. */
  private async context(userId: string, mergeTargets: string[]) {
    return this.deps.db.transaction(async (tx) => {
      const visible = await visibleProjects(tx, userId);
      const writable = new Set(
        [...visible].filter(([, v]) => WRITABLE.has(v.role)).map(([id]) => id),
      );
      const imported = await aliveMappings(tx, userId, writable);
      const labelRows = await tx
        .select({ name: labels.name })
        .from(labels)
        .where(and(eq(labels.userId, userId), isNull(labels.deletedAt)));
      const memberOf = [...new Set([...mergeTargets, ...imported.values()])].filter((id) =>
        writable.has(id),
      );
      const memberRows = memberOf.length
        ? await tx
            .select({ projectId: projectMembers.projectId, userId: projectMembers.userId })
            .from(projectMembers)
            .where(inArray(projectMembers.projectId, memberOf))
        : [];
      const members = new Map<string, Set<string>>();
      for (const m of memberRows) {
        const set = members.get(m.projectId) ?? new Set<string>();
        set.add(m.userId);
        members.set(m.projectId, set);
      }
      const [user] = await tx
        .select({ preferences: users.preferences })
        .from(users)
        .where(eq(users.id, userId));
      const prefs = resolvePreferences(user?.preferences);
      return {
        visible,
        writable,
        imported,
        labelNames: new Set(labelRows.map((l) => l.name.toLowerCase())),
        members,
        dates: {
          now: localNow(prefs.timezone ?? this.deps.defaultTimeZone()),
          weekStart: prefs.weekStart,
          dateOrder: prefs.dateFormat,
        },
      };
    });
  }

  private async preview(
    userId: string,
    sessionId: string,
    snapshot: TodoistSnapshot,
    expiresAt: number,
    /** Read at connect, so the preview can count what the completed choice would bring. */
    completed: readonly TodoistCompletedTask[] = [],
  ): Promise<TodoistPreview> {
    const ctx = await this.context(userId, []);
    const names = new Map<string, string>(); // lower-cased name → writable BokyDo project
    let inbox: string | null = null;
    if (ctx.writable.size) {
      const rows = await this.deps.db
        .select({
          id: projects.id,
          name: projects.name,
          isInbox: projects.isInbox,
          ownerId: projects.ownerId,
        })
        .from(projects)
        .where(
          and(
            inArray(projects.id, [...ctx.writable]),
            isNull(projects.deletedAt),
            eq(projects.isArchived, false),
          ),
        );
      for (const r of rows) {
        if (r.isInbox && r.ownerId === userId) inbox = r.id;
        else if (!names.has(r.name.toLowerCase())) names.set(r.name.toLowerCase(), r.id);
      }
    }
    const count = <T>(xs: T[], key: (x: T) => string | null) => {
      const m = new Map<string, number>();
      for (const x of xs) {
        const k = key(x);
        if (k) m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };
    const sectionsPer = count(snapshot.sections, (x) => x.projectId);
    const tasksPer = count(snapshot.tasks, (x) => x.projectId);
    const taskProject = new Map(snapshot.tasks.map((t) => [t.id, t.projectId]));
    const commentsPer = count(snapshot.comments, (c) =>
      c.taskId ? (taskProject.get(c.taskId) ?? null) : c.projectId,
    );
    const labelUse = new Map<string, number>();
    for (const t of snapshot.tasks)
      for (const l of t.labels)
        labelUse.set(l.toLowerCase(), (labelUse.get(l.toLowerCase()) ?? 0) + 1);
    return {
      sessionId,
      expiresAt: new Date(expiresAt).toISOString(),
      account: { name: snapshot.user.name, email: snapshot.user.email },
      projects: snapshot.projects.map((p) => ({
        id: p.id,
        name: p.name,
        parentId: p.parentId,
        isInbox: p.isInbox,
        isArchived: p.isArchived,
        isShared: p.isShared,
        sections: sectionsPer.get(p.id) ?? 0,
        tasks: tasksPer.get(p.id) ?? 0,
        comments: commentsPer.get(p.id) ?? 0,
        suggestedMerge: p.isInbox ? inbox : (names.get(p.name.toLowerCase()) ?? null),
        importedAs: ctx.imported.get(mappingKey('project', p.id)) ?? null,
      })),
      labels: snapshot.labels.map((l) => ({
        id: l.id,
        name: l.name,
        tasks: labelUse.get(l.name.toLowerCase()) ?? 0,
        exists: ctx.labelNames.has(l.name.toLowerCase()),
        invalid: /[\s@#]/.test(l.name) || l.name.length > 60,
      })),
      filters: snapshot.filters.map((f) => ({
        id: f.id,
        name: f.name,
        query: f.query,
        supported: isSupportedFilter(f.query),
        ...filterReferences(f.query),
        importedAs: ctx.imported.get(mappingKey('filter', f.id)) ?? null,
      })),
      people: snapshot.people.map((p) => ({ ...p, isYou: p.id === snapshot.user.id })),
      totals: {
        projects: snapshot.projects.length,
        sections: snapshot.sections.length,
        tasks: snapshot.tasks.length,
        comments: snapshot.comments.length,
        completed: completed.length,
      },
    };
  }

  /** Apply the plan in chunks; a failing command is skipped and reported, the rest carries on. */
  private async execute(userId: string, id: string, plan: Plan): Promise<void> {
    const failures: TodoistImportWarning[] = [];
    const applied = new Map<CommandType, number>();
    let done = 0;
    const apply = async (steps: PlannedStep[]): Promise<void> => {
      let rest = steps;
      while (rest.length) {
        const chunk = rest.slice(0, CHUNK);
        const commands = chunk.flatMap((s) => (s.type ? [{ type: s.type, args: s.args }] : []));
        const result = await this.deps.sync.applyAll(userId, commands, null, (tx) =>
          recordMappings(tx, userId, chunk),
        );
        if (result.ok) {
          for (const s of chunk) if (s.type) applied.set(s.type, (applied.get(s.type) ?? 0) + 1);
          rest = rest.slice(chunk.length);
          done += chunk.length;
          await this.progress(id, done);
          continue;
        }
        // Everything before the failing command again, then skip it and go on.
        const failedAt = indexOfCommand(chunk, result.index);
        if (failedAt > 0) await apply(chunk.slice(0, failedAt));
        const failed = chunk[failedAt];
        if (failed)
          failures.push({
            kind: 'failed',
            message: `“${failed.label.slice(0, 80)}” could not be imported (${result.result.ok ? 'error' : result.result.error}).`,
          });
        done += 1;
        rest = rest.slice(failedAt + 1);
      }
    };
    let writtenCompleted = 0;
    const writeCompleted = async (steps: CompletedStep[]): Promise<void> => {
      const one = async (step: CompletedStep): Promise<void> => {
        try {
          await this.deps.sync.write(async (tx, changes) => {
            await insertCompletedTask(tx, changes, userId, step);
            await recordMappings(tx, userId, [{ ...step, type: null }]);
          });
        } catch {
          failures.push({
            kind: 'completed',
            message: `“${step.label.slice(0, 80)}” could not be imported as completed.`,
          });
        }
        done += 1;
        await this.progress(id, done);
      };
      let rest = steps;
      while (rest.length) {
        const chunk = rest.slice(0, CHUNK);
        try {
          await this.deps.sync.write(async (tx, changes) => {
            for (const step of chunk) await insertCompletedTask(tx, changes, userId, step);
            await recordMappings(
              tx,
              userId,
              chunk.map((step) => ({ ...step, type: null })),
            );
          });
          writtenCompleted += chunk.length;
          done += chunk.length;
          await this.progress(id, done);
        } catch {
          // One bad row must not stop the rest: go through this chunk one at a time.
          for (const step of chunk) await one(step);
        }
        rest = rest.slice(chunk.length);
      }
    };
    try {
      await apply(plan.steps);
      await writeCompleted(plan.completed);
      const counts: TodoistImportCounts = {
        ...plan.counts,
        projects: applied.get('project_add') ?? 0,
        sections: applied.get('section_add') ?? 0,
        tasks: applied.get('task_add') ?? 0,
        comments: applied.get('comment_add') ?? 0,
        labels: applied.get('label_add') ?? 0,
        filters: applied.get('filter_add') ?? 0,
        completedTasks: writtenCompleted,
      };
      const warnings = [...failures, ...plan.warnings].slice(0, MAX_WARNINGS);
      await this.deps.db
        .update(imports)
        .set({ status: 'done', done, counts, warnings, finishedAt: new Date() })
        .where(eq(imports.id, id));
    } catch (err) {
      this.deps.log.error({ err, importId: id }, 'todoist import failed');
      await this.deps.db
        .update(imports)
        .set({
          status: 'failed',
          done,
          error: 'internal',
          warnings: failures.slice(0, MAX_WARNINGS),
          finishedAt: new Date(),
        })
        .where(eq(imports.id, id));
    }
  }

  private async progress(id: string, done: number): Promise<void> {
    await this.deps.db.update(imports).set({ done }).where(eq(imports.id, id));
  }
}

/** Completed tasks finished within the window the user picked (the read already capped it). */
function withinWindow(
  tasks: readonly TodoistCompletedTask[],
  window: TodoistCompletedWindow,
): TodoistCompletedTask[] {
  const months = window === '1m' ? 1 : TODOIST_COMPLETED_MAX_MONTHS;
  const from = Date.now() - months * 30 * 86_400_000;
  return tasks.filter((t) => hasCompletionDate(t) && t.completedAt.getTime() >= from);
}

/**
 * Write one Todoist completed task as completed (W11a-c1). Mirrors the command layer's insert
 * for the fields the command layer owns, then sets the completion from Todoist: the real
 * `completed_at`, `completed_by` only when that person is a BokyDo user, and no activity event.
 * A completion in the log would be a fabricated history; the import row is the record.
 */
async function insertCompletedTask(
  tx: Tx,
  changes: ChangeRecorder,
  userId: string,
  step: CompletedStep,
): Promise<void> {
  const a = step.args;
  const projectId = String(a.projectId);
  const parentId = typeof a.parentId === 'string' ? a.parentId : null;
  const sectionId = typeof a.sectionId === 'string' ? a.sectionId : null;
  const childOrder = await nextOrderKey(
    tx,
    tasks,
    tasks.childOrder,
    allOf(
      eq(tasks.projectId, projectId),
      sectionId ? eq(tasks.sectionId, sectionId) : isNull(tasks.sectionId),
      parentId ? eq(tasks.parentId, parentId) : isNull(tasks.parentId),
      isNull(tasks.deletedAt),
    ),
  );
  await tx
    .insert(tasks)
    .values({
      id: typeof a.id === 'string' ? a.id : newId(),
      projectId,
      sectionId,
      parentId,
      content: String(a.content),
      description: typeof a.description === 'string' ? a.description : '',
      priority: typeof a.priority === 'number' ? a.priority : 4,
      ...dueColumns(typeof a.due === 'object' && a.due !== null ? (a.due as Due) : null),
      deadline: typeof a.deadline === 'string' ? a.deadline : null,
      durationMinutes: typeof a.durationMinutes === 'number' ? a.durationMinutes : null,
      labels: Array.isArray(a.labels) ? (a.labels as string[]) : [],
      assigneeId: typeof a.assigneeId === 'string' ? a.assigneeId : null,
      assignedById: typeof a.assigneeId === 'string' ? userId : null,
      childOrder,
      isCompleted: true,
      completedAt: step.completedAt,
      completedById: step.completedById,
      createdById: userId,
    })
    .onConflictDoNothing();
  changes.inProject('tasks', String(a.id), projectId);
}

/** The step index of the n-th real command in a chunk (mapping-only steps carry no command). */
function indexOfCommand(chunk: PlannedStep[], n: number): number {
  let seen = -1;
  for (const [i, s] of chunk.entries()) {
    if (s.type && ++seen === n) return i;
  }
  return chunk.length - 1;
}

async function recordMappings(tx: Tx, userId: string, chunk: PlannedStep[]): Promise<void> {
  const rows = chunk.flatMap((s) =>
    s.mapping
      ? [
          {
            userId,
            source: 'todoist' as const,
            kind: s.mapping.kind,
            externalId: s.mapping.externalId,
            localId: s.mapping.localId,
          },
        ]
      : [],
  );
  if (!rows.length) return;
  await tx
    .insert(importMappings)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        importMappings.userId,
        importMappings.source,
        importMappings.kind,
        importMappings.externalId,
      ],
      set: { localId: sql`excluded.local_id`, createdAt: sql`now()` },
    });
}

/**
 * Earlier imports whose BokyDo item is still there (and, for projects, still writable by the
 * user): a re-run skips those. Items deleted since come over again.
 */
async function aliveMappings(
  tx: Tx,
  userId: string,
  writable: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      kind: importMappings.kind,
      externalId: importMappings.externalId,
      localId: importMappings.localId,
    })
    .from(importMappings)
    .where(and(eq(importMappings.userId, userId), eq(importMappings.source, 'todoist')));
  const byKind = new Map<MappingKind, string[]>();
  for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.localId]);
  const alive = new Set<string>();
  const check = async (kind: MappingKind, ids: string[] | undefined) => {
    if (!ids?.length) return;
    for (let i = 0; i < ids.length; i += 5000) {
      const part = ids.slice(i, i + 5000);
      const found =
        kind === 'project'
          ? part.filter((id) => writable.has(id)).map((id) => ({ id }))
          : kind === 'section'
            ? await tx
                .select({ id: sections.id })
                .from(sections)
                .where(and(inArray(sections.id, part), isNull(sections.deletedAt)))
            : kind === 'task'
              ? await tx
                  .select({ id: tasks.id })
                  .from(tasks)
                  .where(and(inArray(tasks.id, part), isNull(tasks.deletedAt)))
              : kind === 'comment'
                ? await tx
                    .select({ id: comments.id })
                    .from(comments)
                    .where(and(inArray(comments.id, part), isNull(comments.deletedAt)))
                : await tx
                    .select({ id: filters.id })
                    .from(filters)
                    .where(
                      and(
                        inArray(filters.id, part),
                        eq(filters.userId, userId),
                        isNull(filters.deletedAt),
                      ),
                    );
      for (const f of found) alive.add(f.id);
    }
  };
  for (const kind of ['project', 'section', 'task', 'comment', 'filter'] as const)
    await check(kind, byKind.get(kind));
  return new Map(
    rows
      .filter((r) => alive.has(r.localId))
      .map((r) => [mappingKey(r.kind, r.externalId), r.localId]),
  );
}

function summary(
  counts: TodoistImportCounts,
  warnings: TodoistImportWarning[],
): TodoistImportPlanSummary {
  return {
    counts,
    warnings: warnings.slice(0, MAX_WARNINGS),
    moreWarnings: Math.max(0, warnings.length - MAX_WARNINGS),
  };
}

function toRun(row: typeof imports.$inferSelect): TodoistImportRun {
  return {
    id: row.id,
    status: row.status,
    done: row.done,
    total: row.total,
    counts: (row.counts as TodoistImportCounts | null) ?? null,
    warnings: (row.warnings as TodoistImportWarning[]) ?? [],
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
