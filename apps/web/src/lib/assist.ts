import type { CommandArgs, Due, Task, TaskAssistSuggestion } from '@bokydo/shared';

/** Priority 4 is "no priority": the default, shown without a label. */
export const NO_PRIORITY = 4;

/** Task names are one line of at most this many characters (the server's limit). */
const NAME_MAX = 1000;

/** The parts of a suggestion that would really change something, with what is already true dropped. */
export interface OfferedChanges {
  title: string | null;
  due: Due | null;
  priority: number | null;
  subtasks: { content: string; due: Due | null }[];
}

/** The user's ticks. `subtasks` lines up with `OfferedChanges.subtasks`. */
export interface TaskAssistChoices {
  title: boolean;
  due: boolean;
  priority: boolean;
  subtasks: boolean[];
}

export type AssistCommand =
  | { type: 'task_update'; args: CommandArgs<'task_update'> }
  | { type: 'task_add'; args: CommandArgs<'task_add'> };

/** Collapse whitespace to one line and bound it. Model text is never trusted to be tidy. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
}

const nameKey = (text: string) => oneLine(text).toLowerCase();

function sameDue(a: Due | null, b: Due | null): boolean {
  if (a === null || b === null) return a === b;
  return a.date === b.date && a.time === b.time && a.recurrence?.rrule === b.recurrence?.rrule;
}

const isPriority = (n: number) => Number.isInteger(n) && n >= 1 && n <= 4;

/**
 * What the suggestion would change on this task. A title, date or priority already set to the
 * same value is dropped, and so are sub-tasks that exist already or repeat within the suggestion.
 */
export function offeredChanges(
  task: Task,
  suggestion: TaskAssistSuggestion,
  existingNames: readonly string[],
): OfferedChanges {
  const title = suggestion.content === null ? '' : oneLine(suggestion.content);
  const seen = new Set(existingNames.map(nameKey));
  const subtasks: OfferedChanges['subtasks'] = [];
  for (const sub of suggestion.subtasks) {
    const content = oneLine(sub.content);
    const key = content.toLowerCase();
    if (!content || seen.has(key)) continue;
    seen.add(key);
    subtasks.push({ content, due: sub.due });
  }
  const priority = suggestion.priority;
  return {
    title: title !== '' && title !== task.content ? title : null,
    due: suggestion.due !== null && !sameDue(task.due, suggestion.due) ? suggestion.due : null,
    priority:
      priority !== null && isPriority(priority) && priority !== task.priority ? priority : null,
    subtasks,
  };
}

/**
 * Ticks before the user touches anything: sub-tasks on. A date or priority only when the task has
 * none yet. A new title only when asked, since it replaces the user's own words.
 */
export function defaultChoices(task: Task, offered: OfferedChanges): TaskAssistChoices {
  return {
    title: false,
    due: offered.due !== null && task.due === null,
    priority: offered.priority !== null && task.priority === NO_PRIORITY,
    subtasks: offered.subtasks.map(() => true),
  };
}

/** How many offered parts are ticked. Zero disables Apply. */
export function pickedCount(offered: OfferedChanges, choices: TaskAssistChoices): number {
  let n = 0;
  if (offered.title !== null && choices.title) n += 1;
  if (offered.due !== null && choices.due) n += 1;
  if (offered.priority !== null && choices.priority) n += 1;
  offered.subtasks.forEach((_, i) => {
    if (choices.subtasks[i]) n += 1;
  });
  return n;
}

/** How many parts the suggestion offers at all (ticked or not). */
export function offeredCount(offered: OfferedChanges): number {
  return (
    (offered.title !== null ? 1 : 0) +
    (offered.due !== null ? 1 : 0) +
    (offered.priority !== null ? 1 : 0) +
    offered.subtasks.length
  );
}

/**
 * The sync commands for the ticked parts: one task_update for the task's own fields, then one
 * task_add per sub-task (parented to the task, so it lands in the same project).
 */
export function assistCommands(
  task: Task,
  offered: OfferedChanges,
  choices: TaskAssistChoices,
  newId: () => string,
): AssistCommand[] {
  const patch: Omit<CommandArgs<'task_update'>, 'id'> = {};
  if (offered.title !== null && choices.title) patch.content = offered.title;
  if (offered.due !== null && choices.due) patch.due = offered.due;
  if (offered.priority !== null && choices.priority) patch.priority = offered.priority;

  const commands: AssistCommand[] = [];
  if (Object.keys(patch).length > 0)
    commands.push({ type: 'task_update', args: { id: task.id, ...patch } });
  offered.subtasks.forEach((sub, i) => {
    if (!choices.subtasks[i]) return;
    commands.push({
      type: 'task_add',
      args: {
        id: newId(),
        parentId: task.id,
        content: sub.content,
        ...(sub.due ? { due: sub.due } : {}),
      },
    });
  });
  return commands;
}

/** The confirmation after Apply, in the words the app uses elsewhere. */
export function appliedText(commands: AssistCommand[]): string {
  const updated = commands.some((c) => c.type === 'task_update');
  const added = commands.length - (updated ? 1 : 0);
  const subtasks = `${added} sub-task${added === 1 ? '' : 's'}`;
  if (updated && added) return `Task updated and ${subtasks} added`;
  if (updated) return 'Task updated';
  if (added) return `Added ${subtasks}`;
  return '';
}

/** The live status after a suggestion: "3 suggestions", "1 suggestion", "No suggestions". */
export function suggestionsText(n: number): string {
  if (n === 0) return 'No suggestions';
  return n === 1 ? '1 suggestion' : `${n} suggestions`;
}

/** The Filter Assist sanity check: "Matches 1 open task now", "Matches 4 open tasks now". */
export function matchesText(n: number): string {
  return `Matches ${n} open task${n === 1 ? '' : 's'} now`;
}
