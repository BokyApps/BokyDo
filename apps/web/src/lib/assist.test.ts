import type { Due, Task, TaskAssistSuggestion } from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import {
  appliedText,
  assistCommands,
  defaultChoices,
  matchesText,
  offeredChanges,
  offeredCount,
  pickedCount,
  suggestionsText,
  type OfferedChanges,
} from './assist.js';

const due = (date: string, time: string | null = null): Due => ({
  date,
  time,
  timezone: null,
  string: date,
  recurrence: null,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: 'p1',
  sectionId: null,
  parentId: null,
  content: 'Plan the trip',
  description: '',
  priority: 4,
  due: null,
  deadline: null,
  durationMinutes: null,
  labels: [],
  assigneeId: null,
  assignedById: null,
  childOrder: 'a0',
  isCompleted: false,
  completedAt: null,
  createdById: 'u1',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
});

const suggestion = (over: Partial<TaskAssistSuggestion> = {}): TaskAssistSuggestion => ({
  content: null,
  subtasks: [],
  due: null,
  priority: null,
  why: 'Because.',
  ...over,
});

/** Deterministic ids so the commands can be compared exactly. */
const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

describe('offeredChanges', () => {
  it('offers nothing when the suggestion repeats the task as it is', () => {
    const t = task({ due: due('2026-10-10'), priority: 2 });
    const s = suggestion({ content: 'Plan the trip', due: due('2026-10-10'), priority: 2 });
    expect(offeredChanges(t, s, [])).toEqual({
      title: null,
      due: null,
      priority: null,
      subtasks: [],
    });
  });

  it('offers a title, date and priority that differ', () => {
    const t = task();
    const s = suggestion({ content: 'Book flights', due: due('2026-10-12'), priority: 1 });
    expect(offeredChanges(t, s, [])).toEqual({
      title: 'Book flights',
      due: due('2026-10-12'),
      priority: 1,
      subtasks: [],
    });
  });

  it('treats the same date and time as no change, but a different time as a change', () => {
    const t = task({ due: due('2026-10-12', '09:00') });
    expect(offeredChanges(t, suggestion({ due: due('2026-10-12', '09:00') }), []).due).toBeNull();
    expect(
      offeredChanges(t, suggestion({ due: due('2026-10-12', '10:00') }), []).due,
    ).not.toBeNull();
  });

  it('drops priorities outside 1 to 4 and blank titles', () => {
    const s = suggestion({ content: '   ', priority: 7 });
    expect(offeredChanges(task(), s, [])).toMatchObject({ title: null, priority: null });
  });

  it('flattens titles and sub-tasks to one line', () => {
    const s = suggestion({
      content: '  Book\n\nflights  ',
      subtasks: [{ content: 'Check\tdates', due: null }],
    });
    expect(offeredChanges(task(), s, [])).toMatchObject({
      title: 'Book flights',
      subtasks: [{ content: 'Check dates', due: null }],
    });
  });

  it('drops sub-tasks that exist already, ignoring case, and repeats within the suggestion', () => {
    const s = suggestion({
      subtasks: [
        { content: 'Book flights', due: null },
        { content: 'book  FLIGHTS', due: null },
        { content: 'Pick hotel', due: null },
        { content: 'Pick hotel', due: null },
        { content: '  ', due: null },
      ],
    });
    expect(offeredChanges(task(), s, ['Book flights']).subtasks).toEqual([
      { content: 'Pick hotel', due: null },
    ]);
  });
});

describe('defaultChoices', () => {
  const offered: OfferedChanges = {
    title: 'Book flights',
    due: due('2026-10-12'),
    priority: 1,
    subtasks: [
      { content: 'A', due: null },
      { content: 'B', due: due('2026-10-13') },
    ],
  };

  it('ticks sub-tasks, and ticks a date or priority only when the task has none', () => {
    expect(defaultChoices(task(), offered)).toEqual({
      title: false,
      due: true,
      priority: true,
      subtasks: [true, true],
    });
  });

  it('leaves a date and priority unticked when the task already has them', () => {
    expect(defaultChoices(task({ due: due('2026-10-01'), priority: 2 }), offered)).toMatchObject({
      due: false,
      priority: false,
    });
  });

  it('never ticks a new title by default', () => {
    expect(defaultChoices(task(), offered).title).toBe(false);
  });
});

describe('assistCommands', () => {
  const offered: OfferedChanges = {
    title: 'Book flights',
    due: due('2026-10-12'),
    priority: 1,
    subtasks: [
      { content: 'Check dates', due: null },
      { content: 'Pick hotel', due: due('2026-10-13') },
    ],
  };

  it('sends one task_update for the ticked fields, then a task_add per ticked sub-task', () => {
    const choices = { title: true, due: true, priority: false, subtasks: [false, true] };
    expect(assistCommands(task(), offered, choices, ids())).toEqual([
      {
        type: 'task_update',
        args: { id: 't1', content: 'Book flights', due: due('2026-10-12') },
      },
      {
        type: 'task_add',
        args: { id: 'new-1', parentId: 't1', content: 'Pick hotel', due: due('2026-10-13') },
      },
    ]);
  });

  it('omits due on a sub-task that has none, and sends no update when no field is ticked', () => {
    const choices = { title: false, due: false, priority: false, subtasks: [true, false] };
    expect(assistCommands(task(), offered, choices, ids())).toEqual([
      { type: 'task_add', args: { id: 'new-1', parentId: 't1', content: 'Check dates' } },
    ]);
  });

  it('returns nothing when nothing is ticked', () => {
    const choices = { title: false, due: false, priority: false, subtasks: [false, false] };
    expect(assistCommands(task(), offered, choices, ids())).toEqual([]);
  });

  it('sends the priority with the update', () => {
    const choices = { title: false, due: false, priority: true, subtasks: [false, false] };
    expect(assistCommands(task(), offered, choices, ids())).toEqual([
      { type: 'task_update', args: { id: 't1', priority: 1 } },
    ]);
  });
});

describe('pickedCount and offeredCount', () => {
  const offered: OfferedChanges = {
    title: 'X',
    due: due('2026-10-12'),
    priority: null,
    subtasks: [
      { content: 'A', due: null },
      { content: 'B', due: null },
    ],
  };

  it('counts what is offered and what is ticked', () => {
    expect(offeredCount(offered)).toBe(4);
    expect(
      pickedCount(offered, { title: true, due: false, priority: false, subtasks: [true, false] }),
    ).toBe(2);
    expect(
      pickedCount(offered, { title: false, due: false, priority: false, subtasks: [false, false] }),
    ).toBe(0);
  });
});

describe('status and confirmation text', () => {
  it('says how many suggestions there are', () => {
    expect(suggestionsText(0)).toBe('No suggestions');
    expect(suggestionsText(1)).toBe('1 suggestion');
    expect(suggestionsText(3)).toBe('3 suggestions');
  });

  it('says what was applied', () => {
    const update = { type: 'task_update' as const, args: { id: 't1', priority: 1 } };
    const add = { type: 'task_add' as const, args: { id: 'a', parentId: 't1', content: 'x' } };
    expect(appliedText([update])).toBe('Task updated');
    expect(appliedText([add])).toBe('Added 1 sub-task');
    expect(appliedText([update, add, { ...add, args: { ...add.args, id: 'b' } }])).toBe(
      'Task updated and 2 sub-tasks added',
    );
    expect(appliedText([])).toBe('');
  });

  it('phrases the Filter Assist match count', () => {
    expect(matchesText(0)).toBe('Matches 0 open tasks now');
    expect(matchesText(1)).toBe('Matches 1 open task now');
    expect(matchesText(12)).toBe('Matches 12 open tasks now');
  });
});
