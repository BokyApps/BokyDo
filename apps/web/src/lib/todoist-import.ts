import type {
  TodoistCompletedWindow,
  TodoistImportChoices,
  TodoistImportCounts,
  TodoistImportWarning,
  TodoistPreview,
  TodoistPreviewFilter,
  TodoistPreviewProject,
  WorkspaceRole,
} from '@bokydo/shared';
import type { SyncState } from '@bokydo/sync-client';
import { flattenTree, projectTree } from './views.js';

/**
 * Pure logic for Settings → Your data → Import from Todoist: what the form starts with, what it
 * posts, and how the preview and the results are grouped for display. The server does the
 * importing; this only decides what to ask for.
 */

/** What to do with one Todoist project. Projects without a choice are skipped. */
export type ProjectChoice =
  | { action: 'skip' }
  | { action: 'new'; workspaceId: string | null }
  | { action: 'merge'; targetId: string };

/** The form's state. Maps are keyed by Todoist ids, which are opaque strings. */
export interface ImportDraft {
  projects: Map<string, ProjectChoice>;
  /** Todoist label ids to import. */
  labels: Set<string>;
  /** Todoist filter ids to import. */
  filters: Set<string>;
  comments: boolean;
  /** Bring the account's completed tasks over, with their real completion dates. */
  completed: boolean;
  /** How far back to look for them: 1 or 3 months (Todoist allows no more). */
  completedWindow: TodoistCompletedWindow;
  /** Todoist collaborator id → BokyDo user id, or null to leave their tasks unassigned. */
  people: Map<string, string | null>;
}

export interface MergeTarget {
  id: string;
  /** "Inbox", or the project's path such as "Work / Q4". */
  label: string;
}

/** Roles that may add tasks to a project (the server decides; this only hides what would fail). */
const WRITABLE_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'editor']);
/** Team roles that may create a project in a team. */
const TEAM_CREATE_ROLES: ReadonlySet<WorkspaceRole> = new Set(['owner', 'admin', 'member']);

/** Writable, non-archived BokyDo projects a Todoist project can be added to. Inbox first. */
export function mergeTargets(state: SyncState): MergeTarget[] {
  const inbox = state.user ? state.projects.get(state.user.inboxProjectId) : undefined;
  const ordered = [
    ...(inbox ? [inbox] : []),
    ...flattenTree(projectTree(state)).map((row) => row.project),
  ];
  return ordered
    .filter((p) => WRITABLE_ROLES.has(p.role) && !p.isArchived)
    .map((p) => ({ id: p.id, label: p.isInbox ? 'Inbox' : pathOf(state, p.id) }));
}

function pathOf(state: SyncState, id: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let p = state.projects.get(id);
  while (p && !seen.has(p.id)) {
    seen.add(p.id);
    names.unshift(p.name);
    p = p.parentId ? state.projects.get(p.parentId) : undefined;
  }
  return names.join(' / ');
}

/** Teams the user can create a top-level project in. Personal is the default (null). */
export function teamOptions(state: SyncState): { id: string; name: string }[] {
  return state.workspaces
    .filter((w) => TEAM_CREATE_ROLES.has(w.role))
    .map((w) => ({ id: w.id, name: w.name }));
}

/** Other people the user shares a project with, for mapping Todoist collaborators. */
export function collaboratorOptions(state: SyncState): { id: string; username: string }[] {
  return [...state.collaborators.values()]
    .filter((c) => c.id !== state.user?.id)
    .sort((a, b) => a.username.localeCompare(b.username));
}

/**
 * Archived Todoist projects are skipped. Otherwise a project goes to the BokyDo project the
 * server suggested (if the user can still write to it), else it is imported as new.
 */
export function defaultProjectChoice(
  p: TodoistPreviewProject,
  targetIds: ReadonlySet<string>,
): ProjectChoice {
  if (p.isArchived) return { action: 'skip' };
  if (p.suggestedMerge && targetIds.has(p.suggestedMerge))
    return { action: 'merge', targetId: p.suggestedMerge };
  return { action: 'new', workspaceId: null };
}

/**
 * The form as it starts: every project by default, all valid labels, all supported filters,
 * comments on, and nobody mapped to a BokyDo user (their tasks stay unassigned).
 */
export function defaultDraft(preview: TodoistPreview, targets: MergeTarget[]): ImportDraft {
  const targetIds = new Set(targets.map((t) => t.id));
  return {
    projects: new Map(preview.projects.map((p) => [p.id, defaultProjectChoice(p, targetIds)])),
    labels: new Set(preview.labels.filter((l) => !l.invalid).map((l) => l.id)),
    filters: new Set(preview.filters.filter((f) => f.supported).map((f) => f.id)),
    comments: true,
    completed: false,
    completedWindow: '3m',
    people: new Map(preview.people.filter((p) => !p.isYou).map((p) => [p.id, null])),
  };
}

/** A project choice as the value of its select. */
export function choiceValue(c: ProjectChoice): string {
  return c.action === 'merge' ? `merge:${c.targetId}` : c.action;
}

/** The choice a select value stands for. Keeps the team when a new project stays new. */
export function choiceFromValue(value: string, previous: ProjectChoice): ProjectChoice {
  if (value.startsWith('merge:'))
    return { action: 'merge', targetId: value.slice('merge:'.length) };
  if (value === 'new')
    return { action: 'new', workspaceId: previous.action === 'new' ? previous.workspaceId : null };
  return { action: 'skip' };
}

export const isImporting = (c: ProjectChoice | undefined) => c !== undefined && c.action !== 'skip';

/**
 * The request body for /plan and /runs. Only projects with a choice are listed; a merge carries
 * its target and nothing else; a team only goes on a new top-level project (absent = personal).
 */
export function buildChoicesBody(
  preview: TodoistPreview,
  draft: ImportDraft,
): TodoistImportChoices {
  const projects = preview.projects.flatMap((p): TodoistImportChoices['projects'] => {
    const c = draft.projects.get(p.id);
    if (!c || c.action === 'skip') return [];
    if (c.action === 'merge') return [{ id: p.id, action: 'merge', targetId: c.targetId }];
    const team = !p.parentId && c.workspaceId ? { workspaceId: c.workspaceId } : {};
    return [{ id: p.id, action: 'new', ...team }];
  });
  return {
    sessionId: preview.sessionId,
    projects,
    labels: preview.labels.filter((l) => !l.invalid && draft.labels.has(l.id)).map((l) => l.id),
    filters: preview.filters.filter((f) => f.supported && draft.filters.has(f.id)).map((f) => f.id),
    comments: draft.comments,
    completed: draft.completed,
    completedWindow: draft.completedWindow,
    people: preview.people
      .filter((p) => !p.isYou)
      .map((p) => ({ id: p.id, userId: draft.people.get(p.id) ?? null })),
  };
}

/** Identifies one set of choices, so a dry run is only trusted for the choices it was made for. */
export const choicesKey = (body: TodoistImportChoices): string => JSON.stringify(body);

export interface ProjectRow {
  project: TodoistPreviewProject;
  depth: number;
}

/**
 * Todoist projects as an indented list, parents before their children. A project whose parent is
 * missing from the preview is shown at the top; members of a parent cycle are shown once.
 */
export function projectRows(projects: TodoistPreviewProject[]): ProjectRow[] {
  const ids = new Set(projects.map((p) => p.id));
  const children = new Map<string, TodoistPreviewProject[]>();
  const roots: TodoistPreviewProject[] = [];
  for (const p of projects) {
    if (p.parentId && p.parentId !== p.id && ids.has(p.parentId)) {
      const list = children.get(p.parentId) ?? [];
      list.push(p);
      children.set(p.parentId, list);
    } else roots.push(p);
  }
  const rows: ProjectRow[] = [];
  const seen = new Set<string>();
  const visit = (project: TodoistPreviewProject, depth: number) => {
    if (seen.has(project.id)) return;
    seen.add(project.id);
    rows.push({ project, depth });
    for (const child of children.get(project.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const p of projects) visit(p, 0); // only parent cycles are left over
  return rows;
}

/** A filter's notes for its row: why it is disabled, and what it mentions that is not selected. */
export function filterNotes(
  f: TodoistPreviewFilter,
  preview: TodoistPreview,
  draft: ImportDraft,
): string[] {
  const notes: string[] = [];
  if (!f.supported) notes.push("BokyDo's filter language doesn't understand this query yet.");
  if (f.importedAs) notes.push('Imported before.');
  const chosenProjects = new Set(
    preview.projects
      .filter((p) => isImporting(draft.projects.get(p.id)))
      .map((p) => p.name.toLowerCase()),
  );
  const missingProjects = f.projects.filter((n) => !chosenProjects.has(n.toLowerCase()));
  if (missingProjects.length)
    notes.push(`Mentions ${missingProjects.join(', ')}, which you aren't importing.`);
  const chosenLabels = new Set(
    preview.labels.filter((l) => draft.labels.has(l.id)).map((l) => l.name.toLowerCase()),
  );
  const missingLabels = f.labels.filter((n) => !chosenLabels.has(n.toLowerCase()));
  if (missingLabels.length)
    notes.push(`Mentions label ${missingLabels.join(', ')}, which isn't selected.`);
  return notes;
}

export const WARNING_KIND_LABEL: Record<TodoistImportWarning['kind'], string> = {
  recurrence: 'Repeating dates',
  timezone: 'Time zones',
  assignee: 'Assignees',
  label: 'Labels',
  filter: 'Filters',
  truncated: 'Shortened text',
  duration: 'Durations',
  nesting: 'Nesting',
  completed: 'Completed tasks',
  failed: 'Not imported',
};

export interface WarningGroup {
  kind: TodoistImportWarning['kind'];
  label: string;
  messages: string[];
}

/** Warnings grouped by kind, in the order of WARNING_KIND_LABEL. Empty kinds are left out. */
export function groupWarnings(warnings: TodoistImportWarning[]): WarningGroup[] {
  return (Object.keys(WARNING_KIND_LABEL) as TodoistImportWarning['kind'][])
    .map((kind) => ({
      kind,
      label: WARNING_KIND_LABEL[kind],
      messages: warnings.filter((w) => w.kind === kind).map((w) => w.message),
    }))
    .filter((g) => g.messages.length > 0);
}

/** The counts of a dry run or a finished import, as labelled rows. */
export function countRows(c: TodoistImportCounts): { label: string; value: number }[] {
  return [
    { label: 'New projects', value: c.projects },
    { label: 'Projects added to', value: c.merged },
    { label: 'Sections', value: c.sections },
    { label: 'Tasks', value: c.tasks },
    { label: 'Comments', value: c.comments },
    { label: 'Labels', value: c.labels },
    { label: 'Filters', value: c.filters },
    { label: 'Already imported (skipped)', value: c.alreadyImported },
  ];
}

/** Human text for a finished or failed run's error code. */
export function runErrorMessage(error: string | null): string {
  switch (error) {
    case 'interrupted':
      return 'The server restarted during the import. Start the import again to finish it.';
    case 'internal':
      return 'Something went wrong on the server during the import. Start it again to finish.';
    default:
      return 'The import stopped unexpectedly. Start it again to finish.';
  }
}
