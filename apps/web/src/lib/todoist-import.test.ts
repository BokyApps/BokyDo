import {
  DEFAULT_PREFERENCES,
  type TodoistPreview,
  type TodoistPreviewProject,
  type Project,
} from '@bokydo/shared';
import { emptyState, type SyncState } from '@bokydo/sync-client';
import { describe, expect, it } from 'vitest';
import {
  buildChoicesBody,
  choiceFromValue,
  choiceValue,
  choicesKey,
  collaboratorOptions,
  countRows,
  defaultDraft,
  defaultProjectChoice,
  filterNotes,
  groupWarnings,
  mergeTargets,
  projectRows,
  runErrorMessage,
  teamOptions,
  type ImportDraft,
} from './todoist-import.js';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function tproject(id: string, extra: Partial<TodoistPreviewProject> = {}): TodoistPreviewProject {
  return {
    id,
    name: `Todoist ${id}`,
    parentId: null,
    isInbox: false,
    isArchived: false,
    isShared: false,
    sections: 0,
    tasks: 1,
    comments: 0,
    suggestedMerge: null,
    importedAs: null,
    ...extra,
  };
}

function preview(extra: Partial<TodoistPreview> = {}): TodoistPreview {
  return {
    sessionId: 'session-abcdefghijklmnopqrst',
    expiresAt: '2026-10-08T12:00:00.000Z',
    account: { name: 'Sam', email: 'sam@example.com' },
    projects: [],
    labels: [],
    filters: [],
    people: [],
    totals: { projects: 0, sections: 0, tasks: 0, comments: 0 },
    ...extra,
  };
}

const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({
  id,
  name,
  color: 'blue',
  parentId: null,
  childOrder: id,
  viewStyle: 'list',
  isInbox: false,
  isArchived: false,
  isFavorite: false,
  role: 'owner',
  workspaceId: null,
  folderId: null,
  visibility: 'restricted',
  updatedAt: '',
  ...extra,
});

function state(): SyncState {
  const s = emptyState();
  return {
    ...s,
    user: {
      id: U(1),
      username: 'alice',
      isAdmin: false,
      inboxProjectId: U(10),
      timeZone: 'UTC',
      preferences: DEFAULT_PREFERENCES,
    },
    projects: new Map(
      [
        project(U(10), 'Inbox', { isInbox: true }),
        project(U(11), 'Work'),
        project(U(12), 'Q4', { parentId: U(11) }),
        project(U(13), 'Shared plans', { role: 'viewer' }),
        project(U(14), 'Team board', { role: 'editor' }),
        project(U(15), 'Old', { isArchived: true }),
      ].map((p) => [p.id, p]),
    ),
    workspaces: [
      { id: U(20), name: 'Studio', role: 'member' },
      { id: U(21), name: 'Guests', role: 'guest' },
      { id: U(22), name: 'Admin team', role: 'admin' },
    ],
    collaborators: new Map([
      [U(1), { id: U(1), username: 'alice' }],
      [U(2), { id: U(2), username: 'bob' }],
      [U(3), { id: U(3), username: 'anna' }],
    ]),
  };
}

describe('mergeTargets', () => {
  it('lists writable, non-archived projects with the Inbox first and paths for nested ones', () => {
    expect(mergeTargets(state())).toEqual([
      { id: U(10), label: 'Inbox' },
      { id: U(11), label: 'Work' },
      { id: U(12), label: 'Work / Q4' },
      { id: U(14), label: 'Team board' },
    ]);
  });
});

describe('defaultProjectChoice', () => {
  const targets = new Set([U(11)]);

  it('merges into the suggested BokyDo project when the user can still write to it', () => {
    expect(defaultProjectChoice(tproject('a', { suggestedMerge: U(11) }), targets)).toEqual({
      action: 'merge',
      targetId: U(11),
    });
  });

  it('imports as new when there is no suggestion or it is not writable', () => {
    expect(defaultProjectChoice(tproject('a'), targets)).toEqual({
      action: 'new',
      workspaceId: null,
    });
    expect(defaultProjectChoice(tproject('a', { suggestedMerge: U(13) }), targets)).toEqual({
      action: 'new',
      workspaceId: null,
    });
  });

  it('skips archived Todoist projects, even when one would be suggested', () => {
    expect(
      defaultProjectChoice(tproject('a', { isArchived: true, suggestedMerge: U(11) }), targets),
    ).toEqual({ action: 'skip' });
  });
});

describe('defaultDraft', () => {
  const p = preview({
    projects: [
      tproject('p1', { suggestedMerge: U(10), parentId: null }),
      tproject('p2', { isArchived: true }),
    ],
    labels: [
      { id: 'l1', name: 'home', tasks: 2, exists: false, invalid: false },
      { id: 'l2', name: 'two words', tasks: 1, exists: false, invalid: true },
    ],
    filters: [
      {
        id: 'f1',
        name: 'Today',
        query: 'today',
        supported: true,
        projects: [],
        labels: [],
        importedAs: null,
      },
      {
        id: 'f2',
        name: 'Odd',
        query: 'bogus(',
        supported: false,
        projects: [],
        labels: [],
        importedAs: null,
      },
    ],
    people: [
      { id: 'me', name: 'Sam', email: 'sam@example.com', isYou: true },
      { id: 'bob', name: 'Bob', email: 'bob@example.com', isYou: false },
    ],
  });

  it('starts with every project, every valid label and supported filter, comments on, and nobody mapped', () => {
    const draft = defaultDraft(p, mergeTargets(state()));
    expect(draft.projects.get('p1')).toEqual({ action: 'merge', targetId: U(10) });
    expect(draft.projects.get('p2')).toEqual({ action: 'skip' });
    expect([...draft.labels]).toEqual(['l1']);
    expect([...draft.filters]).toEqual(['f1']);
    expect(draft.comments).toBe(true);
    expect([...draft.people]).toEqual([['bob', null]]);
  });
});

function draftFor(p: TodoistPreview, overrides: Partial<ImportDraft> = {}): ImportDraft {
  return { ...defaultDraft(p, mergeTargets(state())), ...overrides };
}

describe('buildChoicesBody', () => {
  const p = preview({
    projects: [
      tproject('top'),
      tproject('child', { parentId: 'top' }),
      tproject('gone', { isArchived: true }),
      tproject('merged'),
    ],
    labels: [
      { id: 'l1', name: 'home', tasks: 1, exists: false, invalid: false },
      { id: 'l2', name: 'bad label', tasks: 1, exists: false, invalid: true },
    ],
    filters: [
      {
        id: 'f1',
        name: 'Today',
        query: 'today',
        supported: true,
        projects: [],
        labels: [],
        importedAs: null,
      },
    ],
    people: [
      { id: 'me', name: 'Sam', email: 'sam@example.com', isYou: true },
      { id: 'bob', name: 'Bob', email: 'bob@example.com', isYou: false },
    ],
  });

  it('lists only projects with a choice, a merge carries its target, a team only on new top-level projects', () => {
    const draft = draftFor(p, {
      projects: new Map([
        ['top', { action: 'new', workspaceId: U(20) }],
        ['child', { action: 'new', workspaceId: U(20) }],
        ['gone', { action: 'skip' }],
        ['merged', { action: 'merge', targetId: U(11) }],
      ]),
    });
    const body = buildChoicesBody(p, draft);
    expect(body.projects).toEqual([
      { id: 'top', action: 'new', workspaceId: U(20) },
      { id: 'child', action: 'new' },
      { id: 'merged', action: 'merge', targetId: U(11) },
    ]);
    expect(body.projects.find((x) => x.id === 'merged')).not.toHaveProperty('workspaceId');
  });

  it('omits the team for a personal new project', () => {
    const draft = draftFor(p, {
      projects: new Map([['top', { action: 'new', workspaceId: null }]]),
    });
    expect(buildChoicesBody(p, draft).projects).toEqual([{ id: 'top', action: 'new' }]);
  });

  it('sends only selected, importable labels and filters, the comments flag, and every non-you person', () => {
    const draft = draftFor(p, {
      labels: new Set(['l1', 'l2']),
      filters: new Set(['f1']),
      comments: false,
      people: new Map([['bob', U(2)]]),
    });
    const body = buildChoicesBody(p, draft);
    expect(body.labels).toEqual(['l1']);
    expect(body.filters).toEqual(['f1']);
    expect(body.comments).toBe(false);
    expect(body.people).toEqual([{ id: 'bob', userId: U(2) }]);
    expect(body.sessionId).toBe(p.sessionId);
  });

  it('changes its key when any choice changes', () => {
    const before = choicesKey(buildChoicesBody(p, draftFor(p)));
    const after = choicesKey(buildChoicesBody(p, draftFor(p, { comments: false })));
    expect(after).not.toBe(before);
    expect(choicesKey(buildChoicesBody(p, draftFor(p)))).toBe(before);
  });
});

describe('project choice values', () => {
  it('round-trips merge, new and skip through a select value', () => {
    const merge = { action: 'merge' as const, targetId: U(11) };
    expect(choiceFromValue(choiceValue(merge), { action: 'skip' })).toEqual(merge);
    expect(choiceFromValue('skip', merge)).toEqual({ action: 'skip' });
    expect(choiceFromValue('new', { action: 'skip' })).toEqual({
      action: 'new',
      workspaceId: null,
    });
  });

  it('keeps the team when a new project stays new', () => {
    expect(choiceFromValue('new', { action: 'new', workspaceId: U(20) })).toEqual({
      action: 'new',
      workspaceId: U(20),
    });
  });
});

describe('projectRows', () => {
  it('orders children under their parent, indented', () => {
    const rows = projectRows([
      tproject('a'),
      tproject('a1', { parentId: 'a' }),
      tproject('a1x', { parentId: 'a1' }),
      tproject('b'),
    ]);
    expect(rows.map((r) => [r.project.id, r.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['a1x', 2],
      ['b', 0],
    ]);
  });

  it('shows a project whose parent is missing at the top, and each member of a cycle once', () => {
    const rows = projectRows([
      tproject('orphan', { parentId: 'nope' }),
      tproject('x', { parentId: 'y' }),
      tproject('y', { parentId: 'x' }),
    ]);
    expect(rows.map((r) => r.project.id).sort()).toEqual(['orphan', 'x', 'y']);
    expect(new Set(rows.map((r) => r.project.id)).size).toBe(3);
  });
});

describe('groupWarnings', () => {
  it('groups by kind in a fixed order and leaves out empty kinds', () => {
    const groups = groupWarnings([
      { kind: 'timezone', message: 'tz 1' },
      { kind: 'recurrence', message: 'rec 1' },
      { kind: 'timezone', message: 'tz 2' },
    ]);
    expect(groups).toEqual([
      { kind: 'recurrence', label: 'Repeating dates', messages: ['rec 1'] },
      { kind: 'timezone', label: 'Time zones', messages: ['tz 1', 'tz 2'] },
    ]);
  });

  it('returns nothing for no warnings', () => {
    expect(groupWarnings([])).toEqual([]);
  });
});

describe('filterNotes', () => {
  const p = preview({
    projects: [tproject('work', { name: 'Work' }), tproject('home', { name: 'Home' })],
    labels: [{ id: 'l1', name: 'urgent', tasks: 1, exists: false, invalid: false }],
  });
  const f = (over: Partial<(typeof p.filters)[number]>) => ({
    id: 'f',
    name: 'F',
    query: 'q',
    supported: true,
    projects: [],
    labels: [],
    importedAs: null,
    ...over,
  });

  it('explains an unsupported query and an imported-before filter', () => {
    const draft = draftFor(p, { labels: new Set(['l1']) });
    expect(filterNotes(f({ supported: false, importedAs: 'x' }), p, draft)).toEqual([
      "BokyDo's filter language doesn't understand this query yet.",
      'Imported before.',
    ]);
  });

  it('flags projects and labels it mentions that are not being imported', () => {
    const draft = draftFor(p, {
      projects: new Map([
        ['work', { action: 'new', workspaceId: null }],
        ['home', { action: 'skip' }],
      ]),
      labels: new Set(),
    });
    expect(filterNotes(f({ projects: ['Work', 'Home'], labels: ['urgent'] }), p, draft)).toEqual([
      "Mentions Home, which you aren't importing.",
      "Mentions label urgent, which isn't selected.",
    ]);
  });
});

describe('teamOptions and collaboratorOptions', () => {
  it('offers teams the user can create in, and other collaborators only', () => {
    expect(teamOptions(state())).toEqual([
      { id: U(20), name: 'Studio' },
      { id: U(22), name: 'Admin team' },
    ]);
    expect(collaboratorOptions(state())).toEqual([
      { id: U(3), username: 'anna' },
      { id: U(2), username: 'bob' },
    ]);
  });
});

describe('countRows and runErrorMessage', () => {
  it('labels every count once, in order', () => {
    const rows = countRows({
      projects: 1,
      merged: 2,
      sections: 3,
      tasks: 4,
      comments: 5,
      labels: 6,
      filters: 7,
      alreadyImported: 8,
    });
    expect(rows.map((r) => r.value)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length);
  });

  it('gives a sentence for each known run error and a fallback otherwise', () => {
    expect(runErrorMessage('interrupted')).toMatch(/restarted/);
    expect(runErrorMessage('internal')).toMatch(/Something went wrong/);
    expect(runErrorMessage(null)).toMatch(/stopped unexpectedly/);
  });
});
