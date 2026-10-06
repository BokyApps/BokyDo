import { DEFAULT_PREFERENCES, type Project, type Task } from '@bokydo/shared';
import { emptyState } from '@bokydo/sync-client';
import { describe, expect, it } from 'vitest';
import { runFilterLocally } from './filters.js';

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
const task = (id: string, projectId: string, extra: Partial<Task> = {}): Task => ({
  id,
  projectId,
  sectionId: null,
  parentId: null,
  content: id,
  description: '',
  priority: 4,
  due: null,
  deadline: null,
  durationMinutes: null,
  labels: [],
  assigneeId: null,
  assignedById: null,
  childOrder: id,
  isCompleted: false,
  completedAt: null,
  createdById: 'u',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '',
  ...extra,
});

describe('runFilterLocally', () => {
  const state = {
    ...emptyState(),
    user: {
      id: 'u',
      username: 'a',
      isAdmin: false,
      inboxProjectId: 'in',
      preferences: DEFAULT_PREFERENCES,
    },
    projects: new Map([
      ['in', project('in', 'Inbox', { isInbox: true })],
      ['w', project('w', 'Work')],
      ['old', project('old', 'Work', { isArchived: true })],
    ]),
    tasks: new Map(
      [
        task('open', 'w', { priority: 1 }),
        task('done', 'w', { priority: 1, isCompleted: true }),
        task('archived', 'old', { priority: 1 }),
        task('inbox', 'in'),
      ].map((t) => [t.id, t]),
    ),
  };
  const run = (q: string) =>
    runFilterLocally(state, q, {
      timeZone: 'UTC',
      prefs: DEFAULT_PREFERENCES,
      now: new Date('2026-10-05T10:00:00Z'),
    });

  it('only returns open tasks in live projects', () => {
    const r = run('p1, #Work, all');
    expect(r.ok && r.lists.map((l) => l.tasks.map((t) => t.id))).toEqual([
      ['open'],
      ['open'],
      ['open', 'inbox'],
    ]);
  });

  it('passes parse errors through with positions', () => {
    expect(run('p1 & nonsense')).toMatchObject({ ok: false, error: { start: 5, end: 13 } });
  });
});
