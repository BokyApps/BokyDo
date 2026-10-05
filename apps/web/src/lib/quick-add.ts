import type { NamedRef, ParsedDue, QuickAddOptions } from '@bokydo/nlp';
import type { Due, Preferences, Project } from '@bokydo/shared';
import type { SyncState } from '@bokydo/sync-client';
import { makeDue } from './dates.js';
import { allLabelNames, flattenTree, projectTree } from './views.js';

const WRITABLE: ReadonlySet<Project['role']> = new Set(['owner', 'admin', 'editor']);

export type Candidates = Required<Pick<QuickAddOptions, 'projects' | 'sections' | 'labels'>>;

/**
 * What `#project` and `/section` may resolve to: only live projects the user can add tasks to.
 * This only decides what quick add highlights — the server checks every ID it receives.
 */
export function quickAddCandidates(state: SyncState): Candidates {
  const projects: NamedRef[] = [];
  const inbox = state.user ? state.projects.get(state.user.inboxProjectId) : undefined;
  if (inbox) projects.push({ id: inbox.id, name: inbox.name });
  const path = (p: Project): string => {
    const parent = p.parentId ? state.projects.get(p.parentId) : undefined;
    return parent ? `${path(parent)}/${p.name}` : p.name;
  };
  for (const { project } of flattenTree(projectTree(state))) {
    if (!WRITABLE.has(project.role)) continue;
    projects.push({ id: project.id, name: project.name });
    const full = path(project);
    if (full !== project.name) projects.push({ id: project.id, name: full });
  }
  const ids = new Set(projects.map((p) => p.id));
  const sections = [...state.sections.values()]
    .filter((s) => !s.isArchived && ids.has(s.projectId))
    .map((s) => ({ id: s.id, name: s.name, projectId: s.projectId }));
  return { projects, sections, labels: allLabelNames(state) };
}

/** Recurring dues keep the phrase as typed; one-off dates get the same form as the date picker. */
export function toTaskDue(
  parsed: ParsedDue,
  today: string,
  prefs: Pick<Preferences, 'timeFormat' | 'dateFormat'>,
): Due {
  return parsed.recurrence ? parsed : makeDue(parsed.date, parsed.time, today, prefs);
}
