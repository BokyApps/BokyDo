import { localNow, parseDate } from '@bokydo/nlp';
import {
  commandArgs,
  DEFAULT_PREFERENCES,
  MAX_TEMPLATE_DEPTH,
  parseTemplateCsv,
  serializeTemplateCsv,
  type CommandType,
  type Template,
  type TemplateTask,
} from '@bokydo/shared';
import { emptyState, type SyncState } from '@bokydo/sync-client';
import { describe, expect, it } from 'vitest';
import { storeWith } from '../test-store.js';
import { exportDate, projectToTemplate } from './export-project.js';
import { GALLERY } from './gallery.js';
import { planImport, type ImportTarget, type PlannedCommand } from './import-plan.js';

// A Monday, 05:00 UTC.
const NOW = new Date('2030-03-04T05:00:00Z');
const TZ = 'Europe/London';
const prefs = {
  weekStart: DEFAULT_PREFERENCES.weekStart,
  dateFormat: DEFAULT_PREFERENCES.dateFormat,
  timeFormat: DEFAULT_PREFERENCES.timeFormat,
};

let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

const task = (content: string, over: Partial<TemplateTask> = {}): TemplateTask => ({
  content,
  description: '',
  priority: 4,
  depth: 0,
  date: null,
  timezone: null,
  durationMinutes: null,
  deadline: null,
  comments: [],
  ...over,
});

function plan(
  template: Template,
  state: SyncState,
  target: ImportTarget = { kind: 'new', name: template.name },
  extra: { includeComments?: boolean } = {},
) {
  return planImport({ template, target, state, prefs, timeZone: TZ, now: NOW, newId, ...extra });
}
const empty = () => emptyState();
const byType = <T extends CommandType>(commands: PlannedCommand[], type: T) =>
  commands.filter((c): c is Extract<PlannedCommand, { type: T }> => c.type === type);

describe('gallery', () => {
  it('has unique ids and something in every template', () => {
    expect(new Set(GALLERY.map((g) => g.id)).size).toBe(GALLERY.length);
    for (const g of GALLERY) {
      expect(g.title.length).toBeGreaterThan(3);
      expect(g.summary.length).toBeGreaterThan(10);
      expect(g.template.tasks.length + g.template.sections.length).toBeGreaterThan(0);
    }
  });

  it.each(GALLERY)('$id: every date phrase is understood', ({ template }) => {
    const all = [...template.tasks, ...template.sections.flatMap((s) => s.tasks)];
    const now = localNow(TZ, NOW);
    for (const t of all.filter((x) => x.date))
      expect(parseDate(t.date ?? '', { now }), t.date ?? '').not.toBeNull();
  });

  it.each(GALLERY)('$id: plans into commands the server accepts', ({ template }) => {
    const { commands, warnings } = plan(template, empty());
    expect(warnings).toEqual([]);
    expect(commands.length).toBeLessThan(1000);
    for (const c of commands) {
      const parsed = commandArgs[c.type].safeParse(c.args);
      expect(parsed.success, `${c.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it.each(GALLERY)('$id: matches what CSV export and import would produce', ({ template }) => {
    const { template: back, warnings } = parseTemplateCsv(
      serializeTemplateCsv(template),
      template.name,
    );
    expect(warnings).toEqual([]);
    expect(back).toEqual(template);
  });
});

describe('planImport', () => {
  const template: Template = {
    name: 'Sample',
    tasks: [task('Loose task', { priority: 2 })],
    sections: [
      {
        name: 'First',
        tasks: [
          task('Parent', { comments: ['note one', 'note two'] }),
          task('Child', { depth: 1 }),
          task('Grandchild', { depth: 2 }),
          task('Second child', { depth: 1 }),
          task('Next parent'),
        ],
      },
      { name: 'Second', tasks: [task('In second')] },
    ],
  };

  it('creates a project, then sections, then tasks in file order', () => {
    const p = plan(template, empty());
    expect(p.commands.map((c) => c.type)).toEqual([
      'project_add',
      'task_add',
      'section_add',
      'task_add',
      'comment_add',
      'comment_add',
      'task_add',
      'task_add',
      'task_add',
      'task_add',
      'section_add',
      'task_add',
    ]);
    expect(p.counts).toEqual({ sections: 2, tasks: 7, comments: 2 });
    expect(p.taskIds).toHaveLength(7);
    expect(byType(p.commands, 'project_add')[0]?.args.name).toBe('Sample');
  });

  it('nests sub-tasks under the right parent, in their parent’s section', () => {
    const p = plan(template, empty());
    const tasks = byType(p.commands, 'task_add').map((c) => c.args);
    const id = (content: string) => tasks.find((t) => t.content === content)?.id;
    const section = byType(p.commands, 'section_add').map((c) => c.args.id);
    const parentOf = (content: string) => tasks.find((t) => t.content === content)?.parentId;
    expect(parentOf('Child')).toBe(id('Parent'));
    expect(parentOf('Grandchild')).toBe(id('Child'));
    expect(parentOf('Second child')).toBe(id('Parent'));
    expect(parentOf('Next parent')).toBeUndefined();
    expect(tasks.find((t) => t.content === 'Parent')?.sectionId).toBe(section[0]);
    expect(tasks.find((t) => t.content === 'Child')?.sectionId).toBeUndefined();
    expect(tasks.find((t) => t.content === 'In second')?.sectionId).toBe(section[1]);
    expect(tasks.find((t) => t.content === 'Loose task')?.sectionId).toBeUndefined();
  });

  it('keeps file order with ascending order keys among siblings', () => {
    const p = plan(template, empty());
    const tasks = byType(p.commands, 'task_add').map((c) => c.args);
    const keys = (names: string[]) =>
      names.map((n) => tasks.find((t) => t.content === n)?.childOrder ?? '');
    const ascending = (list: string[]) => list.every((k, i) => i === 0 || (list[i - 1] ?? '') < k);
    expect(ascending(keys(['Parent', 'Next parent']))).toBe(true);
    expect(ascending(keys(['Child', 'Second child']))).toBe(true);
    const sections = byType(p.commands, 'section_add').map((c) => c.args.sectionOrder ?? '');
    expect(ascending(sections)).toBe(true);
  });

  it('can leave comments out', () => {
    const p = plan(template, empty(), undefined, { includeComments: false });
    expect(byType(p.commands, 'comment_add')).toHaveLength(0);
    expect(p.counts.comments).toBe(0);
  });

  it('adds to an existing project after what it already holds', async () => {
    const existing = plan(
      {
        name: 'Existing',
        tasks: [task('Old one'), task('Old two')],
        sections: [{ name: 'Old section', tasks: [] }],
      },
      empty(),
    );
    const state = await storeWith(existing.commands);
    const added = plan(
      { name: 'Ignored', tasks: [task('New one')], sections: [{ name: 'New section', tasks: [] }] },
      state,
      { kind: 'existing', projectId: existing.projectId },
    );
    expect(byType(added.commands, 'project_add')).toHaveLength(0);
    const merged = await storeWith(added.commands, existing.commands);
    const names = projectToTemplate(merged, existing.projectId);
    expect(names.tasks.map((t) => t.content)).toEqual(['Old one', 'Old two', 'New one']);
    expect(names.sections.map((s) => s.name)).toEqual(['Old section', 'New section']);
  });

  it('reads dates the way quick add does, relative to the importing user', () => {
    const p = plan(
      {
        name: 'Dates',
        tasks: [
          task('Tomorrow', { date: 'tomorrow' }),
          task('Fixed', { date: '2030-03-01 09:30', timezone: 'Europe/Berlin' }),
          task('Odd zone', { date: '2030-03-01 09:30', timezone: 'Mars/Olympus' }),
          task('Repeats', { date: 'every monday at 9am' }),
          task('Garbage', { date: 'whenever the moon is full' }),
          task('Deadline', { deadline: '2030-05-01' }),
          task('Bad deadline', { deadline: 'soonish' }),
        ],
        sections: [],
      },
      empty(),
    );
    const tasks = new Map(byType(p.commands, 'task_add').map((c) => [c.args.content, c.args]));
    expect(tasks.get('Tomorrow')?.due).toMatchObject({ date: '2030-03-05', time: null });
    expect(tasks.get('Fixed')?.due).toMatchObject({
      date: '2030-03-01',
      time: '09:30',
      timezone: 'Europe/Berlin',
    });
    expect(tasks.get('Odd zone')?.due).toMatchObject({ time: '09:30', timezone: null });
    expect(tasks.get('Repeats')?.due?.recurrence?.rrule).toContain('FREQ=WEEKLY');
    expect(tasks.get('Garbage')?.due).toBeNull();
    expect(tasks.get('Deadline')?.deadline).toBe('2030-05-01');
    expect(tasks.get('Bad deadline')?.deadline).toBeNull();
    expect(p.warnings.map((w) => w.message).join('\n')).toMatch(
      /Odd zone.*Mars\/Olympus[\s\S]*Garbage.*whenever the moon[\s\S]*Bad deadline.*soonish/,
    );
  });

  it('turns hostile text into plain task text and nothing else', () => {
    const csv = [
      'TYPE,CONTENT,DESCRIPTION',
      'task,=HYPERLINK("http://evil.example"),"<img src=x onerror=alert(1)>"',
      'task,"[x](javascript:alert(1))",@everyone',
    ].join('\n');
    const { template: parsed } = parseTemplateCsv(csv, 'Hostile');
    const p = plan(parsed, empty());
    for (const c of p.commands)
      expect(commandArgs[c.type].safeParse(c.args).success, JSON.stringify(c)).toBe(true);
    const types = new Set(p.commands.map((c) => c.type));
    expect([...types].sort()).toEqual(['project_add', 'task_add']);
  });
});

describe('export and import together', () => {
  const original: Template = {
    name: 'Round trip',
    tasks: [
      task('Loose', { priority: 3 }),
      task('Parent', {
        description: 'Two\nlines',
        priority: 1,
        date: '2030-03-01 09:30',
        timezone: 'Europe/Berlin',
        durationMinutes: 45,
        deadline: '2030-05-01',
        comments: ['first', 'second'],
      }),
      task('Child', { depth: 1, date: '2030-03-02' }),
      task('Grandchild', { depth: 2 }),
    ],
    sections: [
      {
        name: 'Section A',
        tasks: [task('Repeating', { date: 'every monday at 9am' }), task('Plain')],
      },
      { name: 'Section B', tasks: [task('B task', { priority: 2 })] },
    ],
  };

  it('gives back the same template', async () => {
    const p = plan(original, empty());
    const state = await storeWith(p.commands);
    expect(projectToTemplate(state, p.projectId)).toEqual(original);
  });

  it('survives the CSV file in between', async () => {
    const p = plan(original, empty());
    const exported = serializeTemplateCsv(
      projectToTemplate(await storeWith(p.commands), p.projectId),
    );
    const { template, warnings } = parseTemplateCsv(exported, 'Round trip');
    expect(warnings).toEqual([]);
    const again = plan(template, empty());
    expect(projectToTemplate(await storeWith(again.commands), again.projectId)).toEqual(original);
  });

  it('writes every cell safe to open in a spreadsheet', async () => {
    const risky: Template = {
      name: 'Risky',
      tasks: [task('=cmd|calc', { description: '+1 and @x', comments: ['-2'] })],
      sections: [{ name: '@Section', tasks: [] }],
    };
    const p = plan(risky, empty());
    const csv = serializeTemplateCsv(projectToTemplate(await storeWith(p.commands), p.projectId));
    for (const line of csv.split('\r\n').slice(1))
      for (const cell of line.split(',')) expect(cell).not.toMatch(/^"?[=+\-@]/);
    expect(parseTemplateCsv(csv, 'x').template).toEqual({ ...risky, name: 'x' });
  });
});

describe('projectToTemplate', () => {
  it('leaves out completed tasks, archived sections and anything nested deeper than Todoist allows', async () => {
    const levels = 6;
    const ids = Array.from({ length: levels }, () => newId());
    const project = newId();
    const done = newId();
    const archived = newId();
    const archivedTask = newId();
    const cmds: PlannedCommand[] = [
      { type: 'project_add', args: { id: project, name: 'P' } },
      ...ids.map((id, i): PlannedCommand => ({
        type: 'task_add',
        args: {
          id,
          projectId: project,
          content: `Level ${i}`,
          childOrder: 'a0',
          ...(i > 0 ? { parentId: ids[i - 1] ?? null } : {}),
        },
      })),
      {
        type: 'task_add',
        args: { id: done, projectId: project, content: 'Done', childOrder: 'a1' },
      },
      { type: 'task_complete', args: { id: done } },
      { type: 'section_add', args: { id: archived, projectId: project, name: 'Gone' } },
      {
        type: 'task_add',
        args: {
          id: archivedTask,
          projectId: project,
          content: 'Hidden',
          sectionId: archived,
          childOrder: 'a0',
        },
      },
      { type: 'section_archive', args: { id: archived } },
    ];
    const t = projectToTemplate(await storeWith(cmds), project);
    expect(t.sections).toEqual([]);
    expect(t.tasks.map((x) => x.content)).not.toContain('Done');
    expect(t.tasks.map((x) => x.content)).not.toContain('Hidden');
    expect(t.tasks.map((x) => x.depth)).toEqual([0, 1, 2, 3, 3, 3]);
  });

  it('writes dates as ISO or as the repeating phrase, never a locale-dependent label', () => {
    const base = { date: '2030-03-01', string: 'Mar 1', recurrence: null, timezone: null };
    expect(exportDate({ ...base, time: null })).toBe('2030-03-01');
    expect(exportDate({ ...base, time: '09:30' })).toBe('2030-03-01 09:30');
    expect(
      exportDate({
        ...base,
        string: 'every monday',
        time: null,
        recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=MO', anchor: 'scheduled' },
      }),
    ).toBe('every monday');
  });

  it('exports nothing about people', async () => {
    const p = plan(
      { name: 'P', tasks: [task('T', { comments: ['hello'] })], sections: [] },
      empty(),
    );
    const csv = serializeTemplateCsv(projectToTemplate(await storeWith(p.commands), p.projectId));
    const rows = csv.split('\r\n').map((line) => line.split(','));
    const header = rows[0] ?? [];
    for (const row of rows.slice(1).filter((r) => r.length > 1))
      for (const name of ['AUTHOR', 'RESPONSIBLE']) expect(row[header.indexOf(name)]).toBe('');
    expect(MAX_TEMPLATE_DEPTH).toBe(3);
  });
});
