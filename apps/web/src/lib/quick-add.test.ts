import { parseQuickAdd } from '@bokydo/nlp';
import { DEFAULT_PREFERENCES, type Project, type Section } from '@bokydo/shared';
import { emptyState, type SyncState } from '@bokydo/sync-client';
import { describe, expect, it } from 'vitest';
import { quickAddCandidates, toTaskDue } from './quick-add.js';

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
const section = (id: string, projectId: string, name: string): Section => ({
  id,
  projectId,
  name,
  sectionOrder: id,
  isArchived: false,
  updatedAt: '',
});

function state(): SyncState {
  const s = emptyState();
  return {
    ...s,
    user: {
      id: 'u',
      username: 'alice',
      isAdmin: false,
      inboxProjectId: 'inbox',
      preferences: DEFAULT_PREFERENCES,
    },
    projects: new Map(
      [
        project('inbox', 'Inbox', { isInbox: true }),
        project('work', 'Work'),
        project('q4', 'Q4', { parentId: 'work' }),
        project('viewer', 'Shared plans', { role: 'viewer' }),
        project('commenter', 'Comments only', { role: 'commenter' }),
        project('editor', 'Team', { role: 'editor' }),
        project('old', 'Archived', { isArchived: true }),
      ].map((p) => [p.id, p]),
    ),
    sections: new Map(
      [section('s1', 'work', 'Next up'), section('s2', 'viewer', 'Hidden')].map((s) => [s.id, s]),
    ),
  };
}

describe('quick add candidates (security gate: parser never grants access)', () => {
  const c = quickAddCandidates(state());

  it('offers only live projects the user can add tasks to', () => {
    expect(new Set(c.projects.map((p) => p.id))).toEqual(
      new Set(['inbox', 'work', 'q4', 'editor']),
    );
  });

  it('adds parent/child paths for sub-projects', () => {
    expect(c.projects).toContainEqual({ id: 'q4', name: 'Work/Q4' });
  });

  it('offers sections of those projects only', () => {
    expect(c.sections.map((s) => s.id)).toEqual(['s1']);
  });

  it('leaves #names of read-only projects as plain text', () => {
    const r = parseQuickAdd('Plan #Shared plans tomorrow', {
      now: { date: '2026-10-05', time: '10:00' },
      ...c,
    });
    expect(r.projectId).toBeNull();
    expect(r.content).toBe('Plan #Shared plans');
  });
});

describe('toTaskDue', () => {
  const prefs = { timeFormat: '24h', dateFormat: 'dmy' } as const;
  it('keeps recurring phrases and normalises one-off dates', () => {
    const recurring = {
      date: '2026-10-12',
      time: null,
      timezone: null,
      string: 'every mon',
      recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=MO', anchor: 'scheduled' as const },
    };
    expect(toTaskDue(recurring, '2026-10-05', prefs)).toBe(recurring);
    const once = toTaskDue(
      { ...recurring, string: 'tomorrow', recurrence: null },
      '2026-10-05',
      prefs,
    );
    expect(once.string).not.toBe('tomorrow');
    expect(once.string).toMatch(/^12 /);
  });
});
