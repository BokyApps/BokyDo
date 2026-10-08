import {
  globToLike,
  parseFilter,
  resolveFilter,
  type FilterError,
  type ResolvedNode,
  type ResolvedTerm,
} from '@bokydo/filter-query';
import { localNow, type LocalNow } from '@bokydo/nlp';
import { resolvePreferences, type Task } from '@bokydo/shared';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../sync/context.js';
import {
  projectMembers,
  projects,
  sections,
  tasks,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import { visibleProjects, type ProjectScope } from '../sync/policy.js';
import { taskToWire } from '../sync/serialize.js';

/**
 * Filter queries as SQL. The query text never reaches SQL: it is parsed into a tree, names are
 * resolved to IDs among the caller's visible projects, and every value is a bound parameter.
 * The result is always intersected with the caller's live (visible, unarchived) projects.
 */

interface SqlContext {
  now: LocalNow;
  userId: string;
  timeZone: string;
}

const date = (d: string) => sql`${d}::date`;

function termSql(x: ResolvedTerm, ctx: SqlContext): SQL {
  switch (x.t) {
    case 'all':
      return sql`true`;
    case 'date': {
      const column =
        x.field === 'due'
          ? sql`${tasks.dueDate}`
          : x.field === 'deadline'
            ? sql`${tasks.deadline}`
            : sql`(timezone(${ctx.timeZone}, ${tasks.createdAt}))::date`;
      const parts = [sql`${column} is not null`];
      if (x.from !== null) parts.push(sql`${column} >= ${date(x.from)}`);
      if (x.to !== null) parts.push(sql`${column} <= ${date(x.to)}`);
      return sql.join(parts, sql` and `);
    }
    case 'overdue':
      return sql`(${tasks.dueDate} < ${date(ctx.now.date)} or (${tasks.dueDate} = ${date(ctx.now.date)} and (${tasks.due}->>'time') < ${ctx.now.time}))`;
    case 'noDate':
      return sql`${tasks.dueDate} is null`;
    case 'noTime':
      return sql`${tasks.dueDate} is not null and (${tasks.due}->>'time') is null`;
    case 'recurring':
      return sql`jsonb_typeof(${tasks.due}->'recurrence') = 'object'`;
    case 'noDeadline':
      return sql`${tasks.deadline} is null`;
    case 'priority':
      return sql`${tasks.priority} = ${x.p}`;
    case 'projectIds':
      return x.ids.size ? sql`${inArray(tasks.projectId, [...x.ids])}` : sql`false`;
    case 'sectionIds':
      return x.ids.size ? sql`${inArray(tasks.sectionId, [...x.ids])}` : sql`false`;
    case 'anySection':
      return sql`${tasks.sectionId} is not null`;
    case 'label':
      // Explicitly qualified (F-018): Drizzle renders bare column names inside subqueries.
      return sql`exists (select 1 from unnest("tasks"."labels") as l(name) where lower(l.name) like ${globToLike(x.pattern)} escape '\\')`;
    case 'noLabels':
      return sql`cardinality(${tasks.labels}) = 0`;
    case 'assignedTo':
      if (x.who === 'nobody') return sql`${tasks.assigneeId} is null`;
      if (x.who === 'anyone') return sql`${tasks.assigneeId} is not null`;
      if (x.who === 'me') return sql`${tasks.assigneeId} = ${ctx.userId}::uuid`;
      return sql`${tasks.assigneeId} is not null and ${tasks.assigneeId} <> ${ctx.userId}::uuid`;
    case 'assignedBy':
      if (x.who === 'me') return sql`${tasks.assignedById} = ${ctx.userId}::uuid`;
      return sql`${tasks.assignedById} is not null and ${tasks.assignedById} <> ${ctx.userId}::uuid`;
    case 'assigneeIds':
      return x.ids.size ? sql`${inArray(tasks.assigneeId, [...x.ids])}` : sql`false`;
    case 'assignerIds':
      return x.ids.size ? sql`${inArray(tasks.assignedById, [...x.ids])}` : sql`false`;
    case 'search':
      return sql`strpos(lower(${tasks.content}), ${x.text.toLowerCase()}) > 0`;
    case 'subtask':
      return sql`${tasks.parentId} is not null`;
  }
}

/** Two-valued logic throughout: every term is coalesced, so NOT of a NULL is never NULL. */
export function filterSql(node: ResolvedNode, ctx: SqlContext): SQL {
  switch (node.op) {
    case 'term':
      return sql`coalesce((${termSql(node.term, ctx)}), false)`;
    case 'not':
      return sql`(not ${filterSql(node.child, ctx)})`;
    case 'and':
      return sql`(${filterSql(node.left, ctx)} and ${filterSql(node.right, ctx)})`;
    case 'or':
      return sql`(${filterSql(node.left, ctx)} or ${filterSql(node.right, ctx)})`;
  }
}

export type FilterRun =
  | { ok: true; lists: { query: string; tasks: Task[] }[]; warnings: string[] }
  | { ok: false; error: FilterError };

/** Run a filter for a user against their open tasks, in their time zone. */
export async function runFilter(
  tx: Tx,
  userId: string,
  query: string,
  opts: { limit: number; defaultTimeZone: string; now?: Date; scope?: ProjectScope },
): Promise<FilterRun> {
  const [user] = await tx
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, userId));
  const prefs = resolvePreferences(user?.preferences);
  const timeZone = prefs.timezone ?? opts.defaultTimeZone;
  const now = localNow(timeZone, opts.now);
  const parsed = parseFilter(query, {
    now,
    weekStart: prefs.weekStart,
    dateOrder: prefs.dateFormat,
  });
  if (!parsed.ok) return parsed;

  const visible = [...(await visibleProjects(tx, userId, opts.scope ?? null)).keys()];
  const projectRows = visible.length
    ? await tx
        .select({
          id: projects.id,
          name: projects.name,
          parentId: projects.parentId,
          workspaceId: projects.workspaceId,
          isArchived: projects.isArchived,
        })
        .from(projects)
        .where(and(inArray(projects.id, visible), isNull(projects.deletedAt)))
    : [];
  const live = projectRows.filter((p) => !p.isArchived).map((p) => p.id);
  const sectionRows = projectRows.length
    ? await tx
        .select({ id: sections.id, name: sections.name, projectId: sections.projectId })
        .from(sections)
        .where(
          and(
            inArray(
              sections.projectId,
              projectRows.map((p) => p.id),
            ),
            isNull(sections.deletedAt),
          ),
        )
    : [];
  const memberRows = projectRows.length
    ? await tx
        .select({
          projectId: projectMembers.projectId,
          userId: projectMembers.userId,
          username: users.username,
        })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(
          inArray(
            projectMembers.projectId,
            projectRows.map((p) => p.id),
          ),
        )
    : [];
  const perProject = new Map<string, number>();
  for (const m of memberRows) perProject.set(m.projectId, (perProject.get(m.projectId) ?? 0) + 1);
  const { queries, warnings } = resolveFilter(parsed.queries, {
    projects: projectRows,
    sections: sectionRows,
    users: [
      ...new Map(
        memberRows.map((m) => [m.userId, { id: m.userId, username: m.username }]),
      ).values(),
    ],
    sharedProjectIds: new Set([...perProject].filter(([, n]) => n > 1).map(([id]) => id)),
    workspaces: await tx
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt))),
  });

  const lists = [];
  for (const q of queries) {
    const rows = live.length
      ? await tx
          .select()
          .from(tasks)
          .where(
            and(
              inArray(tasks.projectId, live),
              isNull(tasks.deletedAt),
              eq(tasks.isCompleted, false),
              filterSql(q.node, { now, userId, timeZone }),
            ),
          )
          .orderBy(
            sql`${tasks.dueDate} asc nulls last`,
            sql`(${tasks.due}->>'time') asc nulls last`,
            asc(tasks.priority),
            asc(tasks.childOrder),
            asc(tasks.id),
          )
          .limit(opts.limit)
      : [];
    lists.push({ query: q.text, tasks: rows.map(taskToWire) });
  }
  return { ok: true, lists, warnings };
}
