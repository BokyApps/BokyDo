import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  globMatch,
  globToLike,
  matcher,
  parseFilter,
  resolveFilter,
  type Catalog,
  type FilterNode,
  type FilterTask,
  type Term,
} from './index.js';

const NOW = { date: '2026-10-05', time: '10:00' }; // Monday
const CTX = { now: NOW, weekStart: 'monday' as const };

function term(input: string): Term | string {
  const r = parseFilter(input, CTX);
  if (!r.ok) return r.error.message;
  const node = r.queries[0]!.node;
  return node.op === 'term' ? node.term : 'not a single term';
}

const shape = (n: FilterNode): string =>
  n.op === 'term'
    ? n.text
    : n.op === 'not'
      ? `!(${shape(n.child)})`
      : `(${shape(n.left)} ${n.op === 'and' ? '&' : '|'} ${shape(n.right)})`;

describe('terms', () => {
  it.each<[string, Term]>([
    ['today', { t: 'date', field: 'due', from: '2026-10-05', to: '2026-10-05' }],
    ['Tomorrow', { t: 'date', field: 'due', from: '2026-10-06', to: '2026-10-06' }],
    ['yesterday', { t: 'date', field: 'due', from: '2026-10-04', to: '2026-10-04' }],
    ['overdue', { t: 'overdue' }],
    ['od', { t: 'overdue' }],
    ['no date', { t: 'noDate' }],
    ['no  time', { t: 'noTime' }],
    ['recurring', { t: 'recurring' }],
    ['no deadline', { t: 'noDeadline' }],
    ['7 days', { t: 'date', field: 'due', from: '2026-10-05', to: '2026-10-11' }],
    ['next 7 days', { t: 'date', field: 'due', from: '2026-10-05', to: '2026-10-11' }],
    ['-3 days', { t: 'date', field: 'due', from: '2026-10-02', to: '2026-10-04' }],
    ['2 weeks', { t: 'date', field: 'due', from: '2026-10-05', to: '2026-10-18' }],
    ['this week', { t: 'date', field: 'due', from: '2026-10-05', to: '2026-10-11' }],
    ['next week', { t: 'date', field: 'due', from: '2026-10-12', to: '2026-10-18' }],
    ['this month', { t: 'date', field: 'due', from: '2026-10-01', to: '2026-10-31' }],
    ['next month', { t: 'date', field: 'due', from: '2026-11-01', to: '2026-11-30' }],
    ['friday', { t: 'date', field: 'due', from: '2026-10-09', to: '2026-10-09' }],
    ['jan 3', { t: 'date', field: 'due', from: '2027-01-03', to: '2027-01-03' }],
    ['due: 27/10', { t: 'date', field: 'due', from: '2026-10-27', to: '2026-10-27' }],
    ['date: next fri', { t: 'date', field: 'due', from: '2026-10-16', to: '2026-10-16' }],
    ['due before: friday', { t: 'date', field: 'due', from: null, to: '2026-10-08' }],
    ['due after: friday', { t: 'date', field: 'due', from: '2026-10-10', to: null }],
    ['due before: next week', { t: 'date', field: 'due', from: null, to: '2026-10-11' }],
    ['deadline: today', { t: 'date', field: 'deadline', from: '2026-10-05', to: '2026-10-05' }],
    ['deadline before: tomorrow', { t: 'date', field: 'deadline', from: null, to: '2026-10-05' }],
    ['created: today', { t: 'date', field: 'created', from: '2026-10-05', to: '2026-10-05' }],
    ['created before: -7 days', { t: 'date', field: 'created', from: null, to: '2026-09-27' }],
    ['created after: yesterday', { t: 'date', field: 'created', from: '2026-10-05', to: null }],
    ['p1', { t: 'priority', p: 1 }],
    ['P4', { t: 'priority', p: 4 }],
    ['no priority', { t: 'priority', p: 4 }],
    ['#Work', { t: 'project', pattern: 'Work', sub: false }],
    ['##Work', { t: 'project', pattern: 'Work', sub: true }],
    ['#Home Reno', { t: 'project', pattern: 'Home Reno', sub: false }],
    ['#Work*', { t: 'project', pattern: 'Work*', sub: false }],
    ['/Next up', { t: 'section', pattern: 'Next up' }],
    ['/*', { t: 'section', pattern: '*' }],
    ['@errands', { t: 'label', pattern: 'errands' }],
    ['@home*', { t: 'label', pattern: 'home*' }],
    ['no labels', { t: 'noLabels' }],
    ['assigned to: me', { t: 'assignedTo', who: 'me' }],
    ['assigned to: others', { t: 'assignedTo', who: 'others' }],
    ['assigned', { t: 'assignedTo', who: 'anyone' }],
    ['unassigned', { t: 'assignedTo', who: 'nobody' }],
    ['assigned by: me', { t: 'assignedBy', who: 'me' }],
    ['search: Meeting notes', { t: 'search', text: 'Meeting notes' }],
    ['subtask', { t: 'subtask' }],
    ['all', { t: 'all' }],
    ['view all', { t: 'all' }],
    ['search: a\\&b', { t: 'search', text: 'a&b' }],
    ['#Q4 \\(Launch\\)', { t: 'project', pattern: 'Q4 (Launch)', sub: false }],
  ])('%s', (input, expected) => {
    expect(term(input)).toEqual(expected);
  });

  it.each([
    ['foo', /Unknown filter term “foo”.*search: foo/],
    ['p5', /Unknown filter term/],
    ['due: someday', /isn't a date/],
    ['due: every mon', /isn't a date/],
    ['search:', /Add something to search for/],
    ['#', /Add a project name/],
    ['@', /Add a label name/],
    ['assigned to: Sam', /W5/],
    ['shared', /W5/],
    ['workspace: Team', /W5/],
    ['constructor', /Unknown filter term/],
    ['__proto__', /Unknown filter term/],
    [`search: ${'x'.repeat(201)}`, /at most 200/],
  ])('rejects %s', (input, message) => {
    expect(term(input)).toMatch(message);
  });
});

describe('structure', () => {
  const parse = (q: string) => {
    const r = parseFilter(q, CTX);
    if (!r.ok) throw new Error(r.error.message);
    return r.queries.map((x) => shape(x.node));
  };

  it('gives & precedence over |', () => {
    expect(parse('today | overdue & p1')).toEqual(['(today | (overdue & p1))']);
    expect(parse('(today | overdue) & p1')).toEqual(['((today | overdue) & p1)']);
  });

  it('negates terms and groups', () => {
    expect(parse('!@waiting & !(p1 | p2)')).toEqual(['(!(@waiting) & !((p1 | p2)))']);
    expect(parse('!!today')).toEqual(['!(!(today))']);
  });

  it('splits comma lists', () => {
    const r = parseFilter('today, overdue & #Work ,  no date', CTX);
    expect(r.ok && r.queries.map((q) => q.text)).toEqual(['today', 'overdue & #Work', 'no date']);
  });

  it('keeps "!" inside a term literal', () => {
    expect(parse('search: wow!')).toEqual(['search: wow!']);
  });

  it.each([
    ['', 0, 0, /Type a filter/],
    ['today &', 7, 7, /ends too early/],
    ['& today', 0, 1, /Expected a filter term/],
    ['(today', 6, 6, /Missing “\)”/],
    ['today)', 5, 6, /Unexpected “\)”/],
    ['today | foo', 8, 11, /Unknown filter term/],
    ['today,', 6, 6, /ends too early/],
  ])('reports %j at %i–%i', (input, start, end, message) => {
    const r = parseFilter(input, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(message);
      expect([r.error.start, r.error.end]).toEqual([start, end]);
    }
  });

  it('enforces limits', () => {
    const fail = (q: string) => {
      const r = parseFilter(q, CTX);
      return r.ok ? null : r.error.message;
    };
    expect(fail('p1 | '.repeat(64) + 'p2')).toMatch(/At most 64 terms/);
    expect(fail(`${'('.repeat(20)}p1${')'.repeat(20)}`)).toMatch(/nested/);
    expect(fail(`${'!'.repeat(20)}p1`)).toMatch(/nested/);
    expect(fail(Array(11).fill('p1').join(','))).toMatch(/10 comma/);
    expect(fail(`search: ${'a'.repeat(1100)}`)).toMatch(/1024/);
  });
});

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

const CATALOG: Catalog = {
  projects: [
    { id: 'inbox', name: 'Inbox', parentId: null },
    { id: 'work', name: 'Work', parentId: null },
    { id: 'q4', name: 'Q4', parentId: 'work' },
    { id: 'q4a', name: 'Q4 Ads', parentId: 'q4' },
    { id: 'home', name: 'Home', parentId: null },
  ],
  sections: [
    { id: 'w-next', name: 'Next up', projectId: 'work' },
    { id: 'h-next', name: 'Next up', projectId: 'home' },
    { id: 'h-later', name: 'Later', projectId: 'home' },
  ],
};

const task = (id: string, extra: Partial<FilterTask> = {}): FilterTask & { id: string } => ({
  id,
  projectId: 'inbox',
  sectionId: null,
  parentId: null,
  content: id,
  priority: 4,
  due: null,
  deadline: null,
  labels: [],
  assigneeId: null,
  assignedById: null,
  createdAt: '2026-10-01T08:00:00Z',
  ...extra,
});
const due = (date: string, time: string | null = null, recurrence: unknown = null) => ({
  date,
  time,
  recurrence,
});

const TASKS = [
  task('today-early', { due: due('2026-10-05', '09:00') }),
  task('today-late', { due: due('2026-10-05', '18:00'), priority: 1 }),
  task('today-allday', { due: due('2026-10-05') }),
  task('yesterday', { due: due('2026-10-04'), labels: ['Errands'] }),
  task('next-week', { due: due('2026-10-14'), projectId: 'work', sectionId: 'w-next' }),
  task('daily', { due: due('2026-10-06', null, { rrule: 'FREQ=DAILY' }), projectId: 'q4' }),
  task('nodate', { projectId: 'q4a', labels: ['home-office', 'calls'] }),
  task('deadline', { deadline: '2026-10-09', projectId: 'home', sectionId: 'h-later' }),
  task('sub', { parentId: 'nodate', projectId: 'home', sectionId: 'h-next' }),
  task('mine', { assigneeId: 'me', assignedById: 'sam' }),
  task('theirs', { assigneeId: 'sam', assignedById: 'me', content: 'Prepare Meeting notes' }),
  task('new', { createdAt: '2026-10-04T23:30:00Z' }), // 5 Oct in Bangkok, 4 Oct in UTC
];

function run(query: string, timeZone = 'Asia/Bangkok') {
  const r = parseFilter(query, CTX);
  if (!r.ok) throw new Error(r.error.message);
  const { queries, warnings } = resolveFilter(r.queries, CATALOG);
  const lists = queries.map((q) => {
    const match = matcher(q.node, { now: NOW, userId: 'me', timeZone });
    return TASKS.filter(match).map((t) => t.id);
  });
  return { lists, warnings };
}
const ids = (query: string, timeZone?: string) => run(query, timeZone).lists[0];

describe('evaluation', () => {
  it.each<[string, string[]]>([
    ['today', ['today-early', 'today-late', 'today-allday']],
    ['overdue', ['today-early', 'yesterday']],
    ['today & !overdue', ['today-late', 'today-allday']],
    ['no date', ['nodate', 'deadline', 'sub', 'mine', 'theirs', 'new']],
    ['no time', ['today-allday', 'yesterday', 'next-week', 'daily']],
    ['recurring', ['daily']],
    ['7 days', ['today-early', 'today-late', 'today-allday', 'daily']],
    ['due before: today', ['yesterday']],
    ['due after: next week', []],
    ['deadline: friday', ['deadline']],
    ['!no deadline', ['deadline']],
    ['p1', ['today-late']],
    ['#Work', ['next-week']],
    ['##Work', ['next-week', 'daily', 'nodate']],
    ['#Q4*', ['daily', 'nodate']],
    ['#work & /next up', ['next-week']],
    ['/Next up', ['next-week', 'sub']],
    ['/*', ['next-week', 'deadline', 'sub']],
    [
      '!/*',
      [
        'today-early',
        'today-late',
        'today-allday',
        'yesterday',
        'daily',
        'nodate',
        'mine',
        'theirs',
        'new',
      ],
    ],
    ['@errands', ['yesterday']],
    ['@home*', ['nodate']],
    ['@*', ['yesterday', 'nodate']],
    ['no labels & #Home', ['deadline', 'sub']],
    ['assigned to: me', ['mine']],
    ['assigned to: others', ['theirs']],
    ['assigned by: me', ['theirs']],
    ['assigned', ['mine', 'theirs']],
    ['search: meeting', ['theirs']],
    ['subtask', ['sub']],
    ['created: today', ['new']],
    ['(today | overdue) & p1', ['today-late']],
  ])('%s', (query, expected) => {
    expect(ids(query)).toEqual(expected);
  });

  it('uses the user’s zone for creation days', () => {
    expect(ids('created: today', 'UTC')).toEqual([]);
    expect(ids('created: yesterday', 'UTC')).toContain('new');
  });

  it('runs comma lists separately', () => {
    expect(run('today, @errands').lists).toEqual([
      ['today-early', 'today-late', 'today-allday'],
      ['yesterday'],
    ]);
  });

  it('warns about names that match nothing, without failing', () => {
    expect(run('#Wrok | /Nowhere')).toEqual({
      lists: [[]],
      warnings: ['No project named “Wrok”', 'No section named “Nowhere”'],
    });
    expect(run('#Zz*').warnings).toEqual([]);
  });

  it('only resolves names against the catalog it was given', () => {
    const r = parseFilter('#Secret | ##Secret', CTX);
    if (!r.ok) throw new Error();
    const { queries } = resolveFilter(r.queries, { projects: [], sections: [] });
    expect(
      TASKS.filter(matcher(queries[0]!.node, { now: NOW, userId: 'me', timeZone: 'UTC' })),
    ).toEqual([]);
  });

  it('agrees with De Morgan for every pair of sample terms', () => {
    const terms = [
      'today',
      'overdue',
      'p1',
      '#Work',
      '/*',
      '@*',
      'no date',
      'subtask',
      'recurring',
    ];
    for (const a of terms)
      for (const b of terms) expect(ids(`!(${a} | ${b})`)).toEqual(ids(`!${a} & !${b}`));
  });
});

describe('glob', () => {
  it.each([
    ['work', 'Work', true],
    ['wo*', 'Work', true],
    ['*rk', 'Work', true],
    ['w*r*k', 'Work', true],
    ['*', '', true],
    ['w?rk', 'Work', false],
    ['work', 'Workshop', false],
    ['***a***', 'banana', true],
  ])('%s ~ %s', (p, s, ok) => {
    expect(globMatch(p, s)).toBe(ok);
  });

  it('escapes LIKE metacharacters', () => {
    expect(globToLike('50%_off\\*')).toBe('50\\%\\_off\\\\%');
  });

  it('agrees with a reference implementation', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[ab*]{0,8}$/), fc.stringMatching(/^[ab]{0,10}$/), (p, s) => {
        const reference = (pi: number, si: number): boolean =>
          pi === p.length
            ? si === s.length
            : p[pi] === '*'
              ? reference(pi + 1, si) || (si < s.length && reference(pi, si + 1))
              : si < s.length && p[pi] === s[si] && reference(pi + 1, si + 1);
        expect(globMatch(p, s)).toBe(reference(0, 0));
      }),
    );
  });
});
