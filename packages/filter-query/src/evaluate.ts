import type { LocalNow } from '@bokydo/nlp';
import { globMatch, hasWildcard } from './glob.js';
import type { FilterNode, FilterQuery, Term } from './parse.js';

/**
 * Name-based terms resolved to IDs against the projects and sections the user can see. Both the
 * in-memory evaluator and the server's SQL compiler run on this resolved tree, so `#Work` can
 * only ever mean projects already in the caller's visible set.
 */
export type ResolvedTerm =
  | Exclude<
      Term,
      | { t: 'project' }
      | { t: 'section' }
      | { t: 'shared' }
      | { t: 'assignedToName' }
      | { t: 'assignedByName' }
    >
  | { t: 'assigneeIds'; ids: ReadonlySet<string> }
  | { t: 'assignerIds'; ids: ReadonlySet<string> }
  | { t: 'projectIds'; ids: ReadonlySet<string> }
  | { t: 'sectionIds'; ids: ReadonlySet<string> }
  | { t: 'anySection' };

export type ResolvedNode =
  | { op: 'and' | 'or'; left: ResolvedNode; right: ResolvedNode }
  | { op: 'not'; child: ResolvedNode }
  | { op: 'term'; term: ResolvedTerm };

export interface ResolvedQuery {
  text: string;
  node: ResolvedNode;
}

export interface Catalog {
  projects: readonly { id: string; name: string; parentId: string | null }[];
  sections: readonly { id: string; name: string; projectId: string }[];
  /** People the user shares projects with (for `assigned to: name`). */
  users?: readonly { id: string; username: string }[];
  /** Projects with more than one member (for `shared`). */
  sharedProjectIds?: ReadonlySet<string>;
}

export interface Resolution {
  queries: ResolvedQuery[];
  /** Names that matched nothing ("No project named Wrok"): shown, but not an error. */
  warnings: string[];
}

export function resolveFilter(queries: readonly FilterQuery[], catalog: Catalog): Resolution {
  const warnings = new Set<string>();
  const children = new Map<string, string[]>();
  for (const p of catalog.projects) {
    if (!p.parentId) continue;
    const list = children.get(p.parentId) ?? [];
    list.push(p.id);
    children.set(p.parentId, list);
  }
  const withDescendants = (ids: Set<string>) => {
    const queue = [...ids];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      for (const child of children.get(id) ?? []) {
        if (ids.has(child)) continue;
        ids.add(child);
        queue.push(child);
      }
    }
    return ids;
  };

  const resolveTerm = (term: Term): ResolvedTerm => {
    if (term.t === 'project') {
      const ids = new Set(
        catalog.projects.filter((p) => globMatch(term.pattern, p.name)).map((p) => p.id),
      );
      if (ids.size === 0 && !hasWildcard(term.pattern))
        warnings.add(`No project named “${term.pattern}”`);
      return { t: 'projectIds', ids: term.sub ? withDescendants(ids) : ids };
    }
    if (term.t === 'section') {
      if (term.pattern === '*') return { t: 'anySection' };
      const ids = new Set(
        catalog.sections.filter((s) => globMatch(term.pattern, s.name)).map((s) => s.id),
      );
      if (ids.size === 0 && !hasWildcard(term.pattern))
        warnings.add(`No section named “${term.pattern}”`);
      return { t: 'sectionIds', ids };
    }
    if (term.t === 'shared')
      return { t: 'projectIds', ids: new Set(catalog.sharedProjectIds ?? []) };
    if (term.t === 'assignedToName' || term.t === 'assignedByName') {
      const ids = new Set(
        (catalog.users ?? []).filter((u) => globMatch(term.pattern, u.username)).map((u) => u.id),
      );
      if (ids.size === 0 && !hasWildcard(term.pattern))
        warnings.add(`Nobody named “${term.pattern}” shares a project with you`);
      return { t: term.t === 'assignedToName' ? 'assigneeIds' : 'assignerIds', ids };
    }
    return term;
  };
  const resolve = (node: FilterNode): ResolvedNode => {
    if (node.op === 'term') return { op: 'term', term: resolveTerm(node.term) };
    if (node.op === 'not') return { op: 'not', child: resolve(node.child) };
    return { op: node.op, left: resolve(node.left), right: resolve(node.right) };
  };
  return {
    queries: queries.map((q) => ({ text: q.text, node: resolve(q.node) })),
    warnings: [...warnings],
  };
}

/** The fields a filter reads (a subset of the wire `Task`). */
export interface FilterTask {
  projectId: string;
  sectionId: string | null;
  parentId: string | null;
  content: string;
  priority: number;
  due: { date: string; time: string | null; recurrence: unknown } | null;
  deadline: string | null;
  labels: readonly string[];
  assigneeId: string | null;
  assignedById: string | null;
  /** ISO timestamp. */
  createdAt: string;
}

export interface EvalContext {
  /** The user's local date and time. */
  now: LocalNow;
  userId: string;
  /** For `created:` terms: which calendar day a creation timestamp falls on. */
  timeZone: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localDate(iso: string, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f.format(new Date(iso));
}

const inRange = (d: string | null, from: string | null, to: string | null) =>
  d !== null && (from === null || d >= from) && (to === null || d <= to);

/** Compile once, run per task. Glob results are cached per label name. */
export function matcher(node: ResolvedNode, ctx: EvalContext): (task: FilterTask) => boolean {
  const labelCache = new Map<string, Map<string, boolean>>();
  const labelMatches = (pattern: string, label: string) => {
    let cache = labelCache.get(pattern);
    if (!cache) labelCache.set(pattern, (cache = new Map()));
    const key = label.toLowerCase();
    let hit = cache.get(key);
    if (hit === undefined) cache.set(key, (hit = globMatch(pattern, label)));
    return hit;
  };
  const today = ctx.now.date;

  const term = (x: ResolvedTerm, task: FilterTask): boolean => {
    switch (x.t) {
      case 'all':
        return true;
      case 'date': {
        const value =
          x.field === 'due'
            ? (task.due?.date ?? null)
            : x.field === 'deadline'
              ? task.deadline
              : localDate(task.createdAt, ctx.timeZone);
        return inRange(value, x.from, x.to);
      }
      case 'overdue':
        return (
          task.due !== null &&
          (task.due.date < today ||
            (task.due.date === today && task.due.time !== null && task.due.time < ctx.now.time))
        );
      case 'noDate':
        return task.due === null;
      case 'noTime':
        return task.due !== null && task.due.time === null;
      case 'recurring':
        return (
          task.due !== null && task.due.recurrence !== null && task.due.recurrence !== undefined
        );
      case 'noDeadline':
        return task.deadline === null;
      case 'priority':
        return task.priority === x.p;
      case 'projectIds':
        return x.ids.has(task.projectId);
      case 'sectionIds':
        return task.sectionId !== null && x.ids.has(task.sectionId);
      case 'anySection':
        return task.sectionId !== null;
      case 'label':
        return task.labels.some((l) => labelMatches(x.pattern, l));
      case 'noLabels':
        return task.labels.length === 0;
      case 'assignedTo':
        if (x.who === 'nobody') return task.assigneeId === null;
        if (x.who === 'anyone') return task.assigneeId !== null;
        if (x.who === 'me') return task.assigneeId === ctx.userId;
        return task.assigneeId !== null && task.assigneeId !== ctx.userId;
      case 'assignedBy':
        if (x.who === 'me') return task.assignedById === ctx.userId;
        return task.assignedById !== null && task.assignedById !== ctx.userId;
      case 'assigneeIds':
        return task.assigneeId !== null && x.ids.has(task.assigneeId);
      case 'assignerIds':
        return task.assignedById !== null && x.ids.has(task.assignedById);
      case 'search':
        return task.content.toLowerCase().includes(x.text.toLowerCase());
      case 'subtask':
        return task.parentId !== null;
    }
  };
  const run = (n: ResolvedNode, task: FilterTask): boolean => {
    switch (n.op) {
      case 'term':
        return term(n.term, task);
      case 'not':
        return !run(n.child, task);
      case 'and':
        return run(n.left, task) && run(n.right, task);
      case 'or':
        return run(n.left, task) || run(n.right, task);
    }
  };
  return (task) => run(node, task);
}
