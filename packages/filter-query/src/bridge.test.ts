import { describe, expect, it } from 'vitest';
import { filterJson, runFilter, type FilterInput } from './bridge.js';

const now = { date: '2026-10-07', time: '10:00' };

const task = (id: string, over: Partial<FilterInput['tasks'][number]> = {}) => ({
  id,
  projectId: 'p-inbox',
  sectionId: null,
  parentId: null,
  content: `Task ${id}`,
  priority: 4,
  due: null,
  deadline: null,
  labels: [],
  assigneeId: null,
  assignedById: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  ...over,
});

const input = (query: string, over: Partial<FilterInput> = {}): FilterInput => ({
  query,
  now,
  tasks: [
    task('today', { due: { date: '2026-10-07', time: null, recurrence: null } }),
    task('late', { due: { date: '2026-10-05', time: null, recurrence: null } }),
    task('later', { due: { date: '2026-10-20', time: null, recurrence: null } }),
    task('work', { projectId: 'p-work', labels: ['errands'], priority: 1 }),
  ],
  projects: [
    { id: 'p-inbox', name: 'Inbox', parentId: null },
    { id: 'p-work', name: 'Work', parentId: null },
  ],
  sections: [],
  users: [],
  ...over,
});

describe('filterJson (the Android bridge)', () => {
  it('returns the tasks that match, one list per comma', () => {
    const out = JSON.parse(filterJson(JSON.stringify(input('today, overdue'))));
    expect(out.ok).toBe(true);
    expect(out.lists).toEqual([
      { query: 'today', taskIds: ['today'] },
      { query: 'overdue', taskIds: ['late'] },
    ]);
    // "|" is an or inside one list; a comma makes separate lists.
    const or = JSON.parse(filterJson(JSON.stringify(input('today | overdue'))));
    expect(or.lists).toEqual([{ query: 'today | overdue', taskIds: ['today', 'late'] }]);
  });

  it('matches labels, projects and priorities', () => {
    const out = JSON.parse(filterJson(JSON.stringify(input('#Work & p1'))));
    expect(out.lists[0].taskIds).toEqual(['work']);
    const byLabel = JSON.parse(filterJson(JSON.stringify(input('@errands'))));
    expect(byLabel.lists[0].taskIds).toEqual(['work']);
  });

  it('warns about a name that matches nothing', () => {
    const out = JSON.parse(filterJson(JSON.stringify(input('#Nope'))));
    expect(out.ok).toBe(true);
    expect(out.warnings).toEqual(['No project named “Nope”']);
    expect(out.lists[0].taskIds).toEqual([]);
  });

  it('reports a filter that does not parse', () => {
    const out = JSON.parse(filterJson(JSON.stringify(input('nonsense term'))));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('nonsense term');
  });

  it('never throws on broken input', () => {
    expect(JSON.parse(filterJson('not json')).ok).toBe(false);
    expect(JSON.parse(filterJson(JSON.stringify({ query: 'all' }))).ok).toBe(false);
  });

  it('is the same as running the filter directly', () => {
    expect(runFilter(input('today'))).toEqual(
      JSON.parse(filterJson(JSON.stringify(input('today')))),
    );
  });
});
