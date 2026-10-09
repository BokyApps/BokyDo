import type { Project, ProjectMember, Task, TriageSuggestion } from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import {
  buildRows,
  chooseTriageTasks,
  confidenceText,
  isNoChange,
  likelyRows,
  planPhrases,
  planSuggestion,
  sharedWarning,
  sharedWith,
  triageCommands,
  type TriageContext,
  type TriagePlan,
} from './triage.js';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: 'inbox',
  sectionId: null,
  parentId: null,
  content: 'Call the plumber',
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
  createdAt: '',
  updatedAt: '',
  ...over,
});

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

const member = (projectId: string, userId: string): ProjectMember => ({
  projectId,
  userId,
  role: 'editor',
});

const suggestion = (over: Partial<TriageSuggestion> = {}): TriageSuggestion => ({
  taskId: 't1',
  projectId: 'home',
  labels: [],
  priority: null,
  confidence: 0.9,
  why: 'Plumbing is a home job.',
  ...over,
});

/** A context with a private project "home", a shared project "team" (two others), and "old" archived. */
const ctx: TriageContext = {
  projects: new Map([
    ['inbox', project('inbox', 'Inbox', { isInbox: true })],
    ['home', project('home', 'Home')],
    ['team', project('team', 'Team')],
    ['old', project('old', 'Old', { isArchived: true })],
  ]),
  members: [
    member('team', 'me'),
    member('team', 'ana'),
    member('team', 'ben'),
    member('home', 'me'),
  ],
  userId: 'me',
};

describe('confidenceText', () => {
  it('uses words at the thresholds', () => {
    expect(confidenceText(1)).toBe('Likely');
    expect(confidenceText(0.75)).toBe('Likely');
    expect(confidenceText(0.74)).toBe('Maybe');
    expect(confidenceText(0.4)).toBe('Maybe');
    expect(confidenceText(0.39)).toBe('Unsure');
    expect(confidenceText(0)).toBe('Unsure');
  });
});

describe('chooseTriageTasks', () => {
  it('keeps open top-level tasks in list order', () => {
    const tasks = [
      task({ id: 'a' }),
      task({ id: 'b', isCompleted: true }),
      task({ id: 'c', parentId: 'a' }),
      task({ id: 'd' }),
    ];
    expect(chooseTriageTasks(tasks)).toEqual(['a', 'd']);
  });

  it('sends at most the limit, and never a task twice', () => {
    const tasks = Array.from({ length: 25 }, (_, i) => task({ id: `t${i}` }));
    const ids = chooseTriageTasks(tasks);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('t0');
    expect(ids.at(-1)).toBe('t19');
    expect(chooseTriageTasks([task({ id: 'x' }), task({ id: 'x' })], 5)).toEqual(['x']);
  });

  it('returns nothing for an empty inbox', () => {
    expect(chooseTriageTasks([])).toEqual([]);
  });
});

describe('sharedWith and sharedWarning', () => {
  it('counts the other members, not the user', () => {
    expect(sharedWith('team', ctx)).toBe(2);
    expect(sharedWith('home', ctx)).toBe(0);
    expect(sharedWith('unknown', ctx)).toBe(0);
  });

  it('says how many people will see the task', () => {
    expect(sharedWarning(1)).toBe('Shared with 1 person — they will see this task');
    expect(sharedWarning(3)).toBe('Shared with 3 people — they will see this task');
  });
});

describe('planSuggestion', () => {
  it('plans a move to a usable project, with its share count', () => {
    const plan = planSuggestion(task(), suggestion({ projectId: 'team' }), ctx);
    expect(plan).toMatchObject({ projectId: 'team', projectName: 'Team', sharedWith: 2 });
  });

  it('drops a project that is unknown, archived or the task’s own', () => {
    expect(planSuggestion(task(), suggestion({ projectId: 'gone' }), ctx).projectId).toBeNull();
    expect(planSuggestion(task(), suggestion({ projectId: 'old' }), ctx).projectId).toBeNull();
    expect(planSuggestion(task(), suggestion({ projectId: 'inbox' }), ctx).projectId).toBeNull();
    expect(planSuggestion(task(), suggestion({ projectId: null }), ctx).projectName).toBeNull();
  });

  it('keeps only labels the task does not have yet, once each, ignoring case', () => {
    const plan = planSuggestion(
      task({ labels: ['Home'] }),
      suggestion({ labels: ['home', 'Errands', ' errands ', 'Money', ''] }),
      ctx,
    );
    expect(plan.labels).toEqual(['Errands', 'Money']);
  });

  it('drops a priority the task already has, and any outside 1 to 4', () => {
    expect(planSuggestion(task({ priority: 2 }), suggestion({ priority: 2 }), ctx).priority).toBe(
      null,
    );
    expect(planSuggestion(task(), suggestion({ priority: 1 }), ctx).priority).toBe(1);
    expect(planSuggestion(task(), suggestion({ priority: 7 }), ctx).priority).toBe(null);
  });

  it('is a no-change plan when nothing is left to do', () => {
    const plan = planSuggestion(task(), suggestion({ projectId: null, labels: [] }), ctx);
    expect(isNoChange(plan)).toBe(true);
    expect(planPhrases(plan)).toEqual([]);
  });
});

describe('planPhrases', () => {
  it('describes each change in words', () => {
    const plan: TriagePlan = {
      projectId: 'home',
      projectName: 'Home',
      sharedWith: 0,
      labels: ['Errands', 'Money'],
      priority: 1,
    };
    expect(planPhrases(plan)).toEqual([
      'Move to Home',
      'Add labels Errands, Money',
      'Set priority p1',
    ]);
    expect(planPhrases({ ...plan, labels: ['Money'], projectId: null, projectName: null })).toEqual(
      ['Add label Money', 'Set priority p1'],
    );
  });
});

describe('triageCommands', () => {
  it('moves into no section, then updates labels and priority in one command', () => {
    const plan: TriagePlan = {
      projectId: 'home',
      projectName: 'Home',
      sharedWith: 0,
      labels: ['Money'],
      priority: 2,
    };
    expect(triageCommands(task({ labels: ['Urgent'] }), plan)).toEqual([
      { type: 'task_move', args: { id: 't1', projectId: 'home', sectionId: null } },
      { type: 'task_update', args: { id: 't1', labels: ['Urgent', 'Money'], priority: 2 } },
    ]);
  });

  it('sends only the parts that change', () => {
    const labelsOnly: TriagePlan = {
      projectId: null,
      projectName: null,
      sharedWith: 0,
      labels: ['Money'],
      priority: null,
    };
    expect(triageCommands(task(), labelsOnly)).toEqual([
      { type: 'task_update', args: { id: 't1', labels: ['Money'] } },
    ]);
    const moveOnly: TriagePlan = {
      ...labelsOnly,
      projectId: 'home',
      projectName: 'Home',
      labels: [],
    };
    expect(triageCommands(task(), moveOnly)).toEqual([
      { type: 'task_move', args: { id: 't1', projectId: 'home', sectionId: null } },
    ]);
  });

  it('sends nothing for a no-change plan', () => {
    const none: TriagePlan = {
      projectId: null,
      projectName: null,
      sharedWith: 0,
      labels: [],
      priority: null,
    };
    expect(triageCommands(task(), none)).toEqual([]);
  });
});

describe('buildRows and likelyRows', () => {
  const open = new Map([
    ['t1', task({ id: 't1', content: 'Call the plumber' })],
    ['t2', task({ id: 't2', content: 'Buy stamps' })],
    ['t3', task({ id: 't3', content: 'Plan the trip' })],
    ['t4', task({ id: 't4', content: 'Water the plants' })],
    ['t5', task({ id: 't5', content: 'Sort receipts' })],
  ]);

  it('drops suggestions for tasks no longer open in the inbox', () => {
    const rows = buildRows(
      [suggestion({ taskId: 'gone' }), suggestion({ taskId: 't2' })],
      open,
      ctx,
    );
    expect(rows.map((r) => r.task.id)).toEqual(['t2']);
  });

  it('takes only likely rows with a project nobody else shares', () => {
    const rows = buildRows(
      [
        // likely, private project: taken
        suggestion({ taskId: 't1', projectId: 'home', confidence: 0.75 }),
        // likely but shared: left out
        suggestion({ taskId: 't2', projectId: 'team', confidence: 0.95 }),
        // maybe: left out
        suggestion({ taskId: 't3', projectId: 'home', confidence: 0.74 }),
        // likely but no project (labels only): left out
        suggestion({ taskId: 't4', projectId: null, labels: ['Home'], confidence: 0.99 }),
        // likely but the project is unknown to the client: left out
        suggestion({ taskId: 't5', projectId: 'gone', confidence: 0.99 }),
      ],
      open,
      ctx,
    );
    expect(likelyRows(rows).map((r) => r.task.id)).toEqual(['t1']);
  });
});
