import type {
  Collaborator,
  Comment,
  Filter,
  Label,
  PendingInvite,
  Project,
  ProjectMember,
  Section,
  SyncResponse,
  SyncUser,
  Task,
} from '@bokydo/shared';

export interface SyncState {
  user: SyncUser | null;
  /** Server-authoritative and replaced whole on every sync. */
  collaborators: ReadonlyMap<string, Collaborator>;
  members: readonly ProjectMember[];
  invitations: readonly PendingInvite[];
  projects: ReadonlyMap<string, Project>;
  sections: ReadonlyMap<string, Section>;
  tasks: ReadonlyMap<string, Task>;
  labels: ReadonlyMap<string, Label>;
  filters: ReadonlyMap<string, Filter>;
  comments: ReadonlyMap<string, Comment>;
}

/** Mutable working copy used while applying a server response or replaying commands. */
export interface Draft {
  user: SyncUser | null;
  collaborators: ReadonlyMap<string, Collaborator>;
  members: ProjectMember[];
  invitations: readonly PendingInvite[];
  projects: Map<string, Project>;
  sections: Map<string, Section>;
  tasks: Map<string, Task>;
  labels: Map<string, Label>;
  filters: Map<string, Filter>;
  comments: Map<string, Comment>;
}

export const emptyState = (): SyncState => ({
  user: null,
  collaborators: new Map(),
  members: [],
  invitations: [],
  projects: new Map(),
  sections: new Map(),
  tasks: new Map(),
  labels: new Map(),
  filters: new Map(),
  comments: new Map(),
});

export function draftOf(state: SyncState): Draft {
  return {
    user: state.user,
    collaborators: state.collaborators,
    members: [...state.members],
    invitations: state.invitations,
    projects: new Map(state.projects),
    sections: new Map(state.sections),
    tasks: new Map(state.tasks),
    labels: new Map(state.labels),
    filters: new Map(state.filters),
    comments: new Map(state.comments),
  };
}

/** Merge a server response into confirmed state. */
export function applyServerResponse(state: SyncState, res: SyncResponse): SyncState {
  const d = res.fullSync ? draftOf(emptyState()) : draftOf(state);
  d.user = res.user;
  d.collaborators = new Map(res.collaborators.map((c) => [c.id, c]));
  d.members = res.members;
  d.invitations = res.invitations;
  for (const p of res.projects) d.projects.set(p.id, p);
  for (const s of res.sections) d.sections.set(s.id, s);
  for (const t of res.tasks) d.tasks.set(t.id, t);
  for (const l of res.labels) d.labels.set(l.id, l);
  for (const f of res.filters) d.filters.set(f.id, f);
  for (const c of res.comments) d.comments.set(c.id, c);
  for (const id of res.removed.projects) d.projects.delete(id);
  for (const id of res.removed.sections) d.sections.delete(id);
  for (const id of res.removed.tasks) d.tasks.delete(id);
  for (const id of res.removed.labels) d.labels.delete(id);
  for (const id of res.removed.filters) d.filters.delete(id);
  for (const id of res.removed.comments) d.comments.delete(id);
  dropOrphans(d);
  return d;
}

/** A project that disappeared takes its sections and tasks with it (the server sends only the project). */
export function dropOrphans(d: Draft): void {
  for (const [id, s] of d.sections) if (!d.projects.has(s.projectId)) d.sections.delete(id);
  for (const [id, t] of d.tasks) {
    if (!d.projects.has(t.projectId) || (t.sectionId && !d.sections.has(t.sectionId)))
      d.tasks.delete(id);
  }
  // Sub-tasks whose parent vanished (deleted elsewhere) go too.
  let removed = true;
  while (removed) {
    removed = false;
    for (const [id, t] of d.tasks) {
      if (t.parentId && !d.tasks.has(t.parentId)) {
        d.tasks.delete(id);
        removed = true;
      }
    }
  }
  // Comments go with their task or project.
  for (const [id, c] of d.comments)
    if (!d.projects.has(c.projectId) || (c.taskId && !d.tasks.has(c.taskId))) d.comments.delete(id);
}
