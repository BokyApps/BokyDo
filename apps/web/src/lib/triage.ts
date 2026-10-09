import {
  TRIAGE_LIMITS,
  type CommandArgs,
  type Project,
  type ProjectMember,
  type Task,
  type TriageSuggestion,
} from '@bokydo/shared';

/*
 * Inbox triage on the client: which tasks are sent, what each suggestion would change, and what
 * "Apply" and "Apply all likely" do with it. Pure, so the rules can be tested without a browser.
 * The server only suggests; nothing here changes a task until the user applies it.
 */

/** A suggestion at or above this confidence is "likely" (and eligible for Apply all likely). */
export const LIKELY_AT = 0.75;
/** At or above this it is "maybe"; below it, "unsure". */
export const MAYBE_AT = 0.4;

/** Confidence in words, never only a colour. */
export function confidenceText(confidence: number): 'Likely' | 'Maybe' | 'Unsure' {
  if (confidence >= LIKELY_AT) return 'Likely';
  if (confidence >= MAYBE_AT) return 'Maybe';
  return 'Unsure';
}

/** The open top-level tasks to send, in list order: the first `limit`, no duplicates. */
export function chooseTriageTasks(
  tasks: readonly Task[],
  limit: number = TRIAGE_LIMITS.tasks,
): string[] {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.size >= limit) break;
    if (t.isCompleted || t.parentId) continue;
    ids.add(t.id);
  }
  return [...ids];
}

/** The parts of sync state a plan needs. */
export interface TriageContext {
  projects: ReadonlyMap<string, Project>;
  members: readonly ProjectMember[];
  userId: string | null;
}

/** How many other people a project is shared with. The user is not counted. */
export function sharedWith(projectId: string, ctx: TriageContext): number {
  return ctx.members.filter((m) => m.projectId === projectId && m.userId !== ctx.userId).length;
}

/** "Shared with 1 person — they will see this task", or the plural. */
export function sharedWarning(n: number): string {
  return `Shared with ${n} ${n === 1 ? 'person' : 'people'} — they will see this task`;
}

const lowerName = (name: string) => name.trim().toLowerCase();
const isPriority = (n: number) => Number.isInteger(n) && n >= 1 && n <= 4;

/** What applying one suggestion would change. Only real changes are in it. */
export interface TriagePlan {
  /** The project to move the task to; null: it stays where it is. */
  projectId: string | null;
  projectName: string | null;
  /** Other people the target project is shared with (0 when private or no move). */
  sharedWith: number;
  /** Names of the user's labels to add: not on the task already, no repeats. */
  labels: string[];
  /** The new priority (1 to 4); null: no change. */
  priority: number | null;
}

/**
 * The changes a suggestion would make to this task, checked against the current state: a project
 * that is unknown, archived or the task's own is dropped; labels the task has are dropped; a
 * priority the task already has is dropped.
 */
export function planSuggestion(
  task: Task,
  suggestion: TriageSuggestion,
  ctx: TriageContext,
): TriagePlan {
  const target = suggestion.projectId !== null ? ctx.projects.get(suggestion.projectId) : undefined;
  const usable = target !== undefined && !target.isArchived && target.id !== task.projectId;
  const projectId = usable ? target.id : null;

  const seen = new Set(task.labels.map(lowerName));
  const labels: string[] = [];
  for (const raw of suggestion.labels) {
    const name = raw.trim();
    const key = lowerName(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    labels.push(name);
  }

  const priority =
    suggestion.priority !== null &&
    isPriority(suggestion.priority) &&
    suggestion.priority !== task.priority
      ? suggestion.priority
      : null;

  return {
    projectId,
    projectName: usable ? target.name : null,
    sharedWith: projectId !== null ? sharedWith(projectId, ctx) : 0,
    labels,
    priority,
  };
}

/** True when applying the plan changes nothing: the row shows "Leave it here" and only Skip. */
export function isNoChange(plan: TriagePlan): boolean {
  return plan.projectId === null && plan.labels.length === 0 && plan.priority === null;
}

/** The changes in plain words, e.g. ["Move to Work", "Add labels home, errand", "Set priority p1"]. */
export function planPhrases(plan: TriagePlan): string[] {
  const out: string[] = [];
  if (plan.projectId !== null && plan.projectName !== null) out.push(`Move to ${plan.projectName}`);
  if (plan.labels.length > 0)
    out.push(`${plan.labels.length === 1 ? 'Add label' : 'Add labels'} ${plan.labels.join(', ')}`);
  if (plan.priority !== null) out.push(`Set priority p${plan.priority}`);
  return out;
}

export type TriageCommand =
  | { type: 'task_move'; args: CommandArgs<'task_move'> }
  | { type: 'task_update'; args: CommandArgs<'task_update'> };

/**
 * The sync commands for a plan: a move to the project (into no section, so it lands at the
 * project's top level), then one update for labels and priority. Labels are sent whole, so the
 * task's own labels are kept.
 */
export function triageCommands(task: Task, plan: TriagePlan): TriageCommand[] {
  const commands: TriageCommand[] = [];
  if (plan.projectId !== null)
    commands.push({
      type: 'task_move',
      args: { id: task.id, projectId: plan.projectId, sectionId: null },
    });
  const patch: Omit<CommandArgs<'task_update'>, 'id'> = {};
  if (plan.labels.length > 0) patch.labels = [...task.labels, ...plan.labels];
  if (plan.priority !== null) patch.priority = plan.priority;
  if (Object.keys(patch).length > 0)
    commands.push({ type: 'task_update', args: { id: task.id, ...patch } });
  return commands;
}

/** A suggestion whose task is still open in the Inbox, with its plan worked out now. */
export interface TriageRow {
  task: Task;
  suggestion: TriageSuggestion;
  plan: TriagePlan;
}

/**
 * One row per suggestion whose task is in `openTasks` (the Inbox's open top-level tasks). A task
 * that has gone since the suggestions came back gets no row.
 */
export function buildRows(
  suggestions: readonly TriageSuggestion[],
  openTasks: ReadonlyMap<string, Task>,
  ctx: TriageContext,
): TriageRow[] {
  return suggestions.flatMap((suggestion) => {
    const task = openTasks.get(suggestion.taskId);
    return task ? [{ task, suggestion, plan: planSuggestion(task, suggestion, ctx) }] : [];
  });
}

/**
 * The rows "Apply all likely" takes: likely (at least LIKELY_AT), with a project to move to, and
 * a project nobody else shares. Shared projects are applied one row at a time, on purpose.
 */
export function likelyRows(rows: readonly TriageRow[]): TriageRow[] {
  return rows.filter(
    (r) =>
      r.suggestion.confidence >= LIKELY_AT && r.plan.projectId !== null && r.plan.sharedWith === 0,
  );
}
