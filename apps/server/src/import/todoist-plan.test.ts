import { localNow } from '@bokydo/nlp';
import { describe, expect, it } from 'vitest';
import { todoistFixture } from '../test/todoist.js';
import { normalise, TodoistError } from './todoist-client.js';
import { filterReferences, mappingKey, planImport, type PlanInput } from './todoist-plan.js';

const ME = '0190a000-0000-7000-8000-000000000001';
const BEN = '0190a000-0000-7000-8000-000000000002';
const EXISTING = '0190a000-0000-7000-8000-0000000000aa';

function input(overrides: Partial<PlanInput> = {}, choices: Partial<PlanInput['choices']> = {}) {
  return {
    snapshot: normalise(todoistFixture()),
    choices: {
      projects: [
        { id: 'p-work', action: 'new' as const },
        { id: 'p-clients', action: 'new' as const },
        { id: 'p-home', action: 'new' as const },
      ],
      labels: ['l1', 'l2'],
      filters: ['f1', 'f2', 'f3'],
      comments: true,
      people: [{ id: 'u2', userId: BEN }],
      ...choices,
    },
    userId: ME,
    imported: new Map<string, string>(),
    labelNames: new Set<string>(),
    members: new Map<string, Set<string>>(),
    dates: {
      now: localNow('UTC', new Date('2026-10-08T08:00:00Z')),
      weekStart: 'monday',
      dateOrder: 'dmy',
    },
    ...overrides,
  } satisfies PlanInput;
}

const argsOf = (plan: ReturnType<typeof planImport>, type: string) =>
  plan.steps.filter((s) => s.type === type).map((s) => s.args);

describe('reading a Todoist answer', () => {
  it('keeps live, open items only and normalises dates', () => {
    const s = normalise(todoistFixture());
    expect(s.projects.map((p) => p.id)).not.toContain('p-gone');
    expect(s.tasks.map((t) => t.id)).not.toContain('t-done');
    expect(s.tasks.map((t) => t.id)).not.toContain('t-del');
    const due = (id: string) => s.tasks.find((t) => t.id === id)?.due;
    // Floating local time.
    expect(due('t-report')).toMatchObject({ date: '2026-10-12', time: '09:30', timezone: null });
    // A UTC instant with a zone: shown in that zone (07:00Z is 09:00 in Johannesburg).
    expect(due('t-standup')).toMatchObject({
      date: '2026-10-09',
      time: '09:00',
      timezone: 'Africa/Johannesburg',
      isRecurring: true,
    });
    expect(due('t-odd')).toMatchObject({ date: '2026-10-10', time: null, timezone: null });
    expect(s.people.find((p) => p.id === 'u1')?.name).toBe('Ana Import');
  });

  it('refuses answers that are not Todoist data, or too big', () => {
    expect(() => normalise({ projects: 'nope' })).toThrow(TodoistError);
    expect(() => normalise({ user: { id: 'u' }, items: [{ id: 1 }] })).toThrow(TodoistError);
    const huge = todoistFixture() as unknown as { labels: unknown[] };
    huge.labels = Array.from({ length: 2001 }, (_, i) => ({ id: `l${i}`, name: `l${i}` }));
    try {
      normalise(huge);
      expect.unreachable();
    } catch (err) {
      expect((err as TodoistError).reason).toBe('too_large');
    }
  });
});

describe('planning an import', () => {
  it('creates parents before children, in Todoist order', () => {
    const plan = planImport(input());
    const order = plan.steps.map((s) => `${s.type}:${s.label}`);
    const at = (x: string) => order.indexOf(x);
    expect(at('project_add:Work')).toBeLessThan(at('project_add:Clients'));
    expect(at('section_add:To do')).toBeLessThan(at('section_add:Doing'));
    expect(at('task_add:Write report')).toBeLessThan(at('task_add:Outline'));
    expect(at('task_add:Outline')).toBeLessThan(at('comment_add:a comment'));
    const projects = argsOf(plan, 'project_add');
    const work = projects.find((p) => p.name === 'Work');
    const clients = projects.find((p) => p.name === 'Clients');
    expect(clients).toMatchObject({ parentId: work?.id, name: 'Clients' });
    expect(clients).not.toHaveProperty('color'); // unknown colour dropped
    expect(work).toMatchObject({ color: 'blue', viewStyle: 'board', isFavorite: true });
    expect(plan.counts).toMatchObject({ projects: 3, sections: 2, tasks: 4, comments: 3 });
  });

  it('maps priorities, dates, durations, labels and sub-tasks', () => {
    const plan = planImport(input());
    const tasks = argsOf(plan, 'task_add');
    const report = tasks.find((t) => t.content === 'Write report');
    expect(report).toMatchObject({
      priority: 1, // Todoist API 4 = p1
      description: 'Quarterly numbers',
      deadline: '2026-10-20',
      durationMinutes: 45,
      labels: ['deep-work'],
      due: { date: '2026-10-12', time: '09:30', timezone: null, recurrence: null },
    });
    const outline = tasks.find((t) => t.content === 'Outline');
    expect(outline).toMatchObject({ parentId: report?.id, priority: 4 });
    expect(outline).not.toHaveProperty('sectionId'); // sub-tasks follow their parent
    const standup = tasks.find((t) => t.content === 'Stand-up');
    expect(standup?.due).toMatchObject({
      date: '2026-10-09',
      time: '09:00',
      timezone: 'Africa/Johannesburg',
      string: 'every weekday 9am',
      recurrence: { anchor: 'scheduled' },
    });
    // A repeat BokyDo can't read comes over as a one-off, with a warning; newlines flattened.
    const odd = tasks.find((t) => String(t.content).startsWith('Water plants'));
    expect(odd).toMatchObject({ content: 'Water plants in the garden', due: { recurrence: null } });
    expect(plan.warnings.map((w) => w.kind)).toEqual(
      expect.arrayContaining(['recurrence', 'label', 'assignee', 'filter']),
    );
  });

  it('assigns only people who will be members, and never invites', () => {
    const tasks = argsOf(planImport(input()), 'task_add');
    // Ben is not a member of a project this import creates; Ana (the account) is you.
    expect(tasks.find((t) => t.content === 'Write report')).not.toHaveProperty('assigneeId');
    expect(tasks.find((t) => t.content === 'Outline')).toMatchObject({ assigneeId: ME });
    // Merged into a project Ben is in: he keeps the task.
    const merged = planImport(
      input(
        { members: new Map([[EXISTING, new Set([ME, BEN])]]) },
        { projects: [{ id: 'p-work', action: 'merge', targetId: EXISTING }] },
      ),
    );
    const report = argsOf(merged, 'task_add').find((t) => t.content === 'Write report');
    expect(report).toMatchObject({ projectId: EXISTING, assigneeId: BEN });
    expect(argsOf(merged, 'project_add')).toHaveLength(0);
    expect(merged.steps.find((s) => s.type === null)).toMatchObject({
      type: null,
      mapping: { kind: 'project', externalId: 'p-work', localId: EXISTING },
    });
    expect(merged.counts.merged).toBe(1);
  });

  it('skips what an earlier import brought over, and adds the rest', () => {
    const first = planImport(input());
    const imported = new Map(
      first.steps.flatMap((s) =>
        s.mapping && s.label !== 'Outline'
          ? [[mappingKey(s.mapping.kind, s.mapping.externalId), s.mapping.localId] as const]
          : [],
      ),
    );
    const again = planImport(input({ imported }));
    const tasks = argsOf(again, 'task_add');
    expect(tasks.map((t) => t.content)).toEqual(['Outline']);
    const report = first.steps.find((s) => s.label === 'Write report');
    expect(tasks[0]?.parentId).toBe(report?.mapping?.localId);
    expect(argsOf(again, 'project_add')).toHaveLength(0);
    expect(again.counts.alreadyImported).toBeGreaterThan(5);
  });

  it('leaves out unselected projects, invalid labels and filters BokyDo cannot run', () => {
    const plan = planImport(
      input(
        { labelNames: new Set(['deep-work']) },
        { projects: [{ id: 'p-home', action: 'new' }] },
      ),
    );
    expect(argsOf(plan, 'project_add').map((p) => p.name)).toEqual(['Home']);
    // deep-work exists already (merged), "two words" is not a valid name.
    expect(argsOf(plan, 'label_add')).toHaveLength(0);
    const filters = argsOf(plan, 'filter_add').map((f) => f.name);
    expect(filters).toContain('Focus');
    expect(filters).not.toContain('Odd');
    // #Garage isn't coming over: imported, but flagged.
    expect(filters).toContain('Home stuff');
    expect(plan.warnings.some((w) => w.message.includes('#Garage'))).toBe(true);
    expect(plan.counts.comments).toBe(0);
  });

  it('reads project and label names out of filter queries', () => {
    expect(filterReferences('#Work & @deep-work | ##My\\ Project & !@later')).toEqual({
      projects: ['Work', 'My Project'],
      labels: ['deep-work', 'later'],
    });
  });
});
