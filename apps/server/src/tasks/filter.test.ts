import { matcher, parseFilter, resolveFilter } from '@bokydo/filter-query';
import { addDays, localNow } from '@bokydo/nlp';
import type { Due } from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tasks } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { grantProjectAccess } from '../sync/membership.js';
import { runFilter } from './filter-sql.js';

/**
 * The filter language has two engines: SQL on the server (API, MCP) and an in-memory evaluator
 * in clients. This suite seeds a varied task set and checks that random queries give exactly the
 * same tasks from both, that nothing outside the caller's visible projects ever comes back, and
 * that arbitrary input can't break the SQL.
 */
const ZONE = 'Pacific/Kiritimati'; // UTC+14: creation days differ from UTC most of the time
const NOW = new Date();
const LOCAL = localNow(ZONE, NOW);
const TODAY = LOCAL.date;

let t: TestApp;
let alice: SyncUser;
let bob: SyncUser;
let bobSecret: Set<string>;
const P = { work: id(), q4: id(), home: id(), old: id(), bobWork: id(), shared: id() };
const S = { next: id(), later: id(), homeNext: id() };

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

beforeAll(async () => {
  t = await testApp();
  alice = new SyncUser(
    t.app.services.sync,
    await createUser(t.db, { username: 'alice', password: 'x'.repeat(12) }),
  );
  bob = new SyncUser(
    t.app.services.sync,
    await createUser(t.db, { username: 'bob', password: 'x'.repeat(12) }),
  );
  await alice.ok(
    cmd('user_update_preferences', { timezone: ZONE }),
    cmd('project_add', { id: P.work, name: 'Work' }),
    cmd('project_add', { id: P.q4, name: 'Q4', parentId: P.work }),
    cmd('project_add', { id: P.home, name: 'Home' }),
    cmd('project_add', { id: P.old, name: 'Old' }),
    cmd('section_add', { id: S.next, projectId: P.work, name: 'Next up' }),
    cmd('section_add', { id: S.later, projectId: P.work, name: 'Later' }),
    cmd('section_add', { id: S.homeNext, projectId: P.home, name: 'Next up' }),
  );
  await bob.ok(
    cmd('project_add', { id: P.bobWork, name: 'Work' }),
    cmd('project_add', { id: P.shared, name: 'Shared plans' }),
  );

  const random = rng(42);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
  const LABELS = ['errands', 'Errands', 'home-office', 'calls', '50%_off', 'Ünïcode'];
  const randomTask = (projectId: string, sectionIds: (string | null)[]) => {
    const r = random();
    const due: Due | null =
      r < 0.25
        ? null
        : {
            date: addDays(TODAY, Math.floor(random() * 21) - 10),
            time: random() < 0.4 ? pick(['00:00', '08:30', '12:00', '23:59', LOCAL.time]) : null,
            timezone: null,
            string: 'x',
            recurrence:
              random() < 0.2 ? { rrule: 'FREQ=WEEKLY;BYDAY=MO', anchor: 'scheduled' } : null,
          };
    return {
      id: id(),
      projectId,
      sectionId: pick(sectionIds),
      content: pick([
        'Alpha report',
        'alphabet soup',
        'Beta',
        '%_\\ weird',
        'Ünïcode task',
        'plain',
      ]),
      priority: pick([1, 2, 3, 4]),
      due,
      deadline: random() < 0.3 ? addDays(TODAY, Math.floor(random() * 15) - 7) : null,
      labels: LABELS.filter(() => random() < 0.25).filter(
        (l, i, all) => all.findIndex((x) => x.toLowerCase() === l.toLowerCase()) === i,
      ),
    };
  };

  const projectsFor = [
    [alice.inbox, [null]],
    [P.work, [null, S.next, S.later]],
    [P.q4, [null]],
    [P.home, [null, S.homeNext]],
    [P.old, [null]],
  ] as const;
  const added: { id: string; projectId: string }[] = [];
  for (let i = 0; i < 160; i++) {
    const [projectId, sectionIds] = pick(projectsFor);
    const task = randomTask(projectId, [...sectionIds]);
    const parent = random() < 0.2 ? added.find((a) => a.projectId === projectId) : undefined;
    await alice.ok(
      cmd('task_add', parent ? { ...task, sectionId: undefined, parentId: parent.id } : task),
    );
    added.push(task);
    if (random() < 0.1) await alice.ok(cmd('task_complete', { id: task.id }));
  }
  // Guarantee coverage of terms the random sample might miss.
  await alice.ok(
    cmd('task_add', { id: id(), content: 'Due back', deadline: TODAY, labels: ['calls'] }),
  );
  await alice.ok(cmd('project_archive', { id: P.old }));

  // Bob's private project mirrors Alice's names; his shared one is visible to her as a viewer.
  bobSecret = new Set();
  for (let i = 0; i < 40; i++) {
    const task = randomTask(P.bobWork, [null]);
    bobSecret.add(task.id);
    await bob.ok(cmd('task_add', task));
  }
  for (let i = 0; i < 20; i++) await bob.ok(cmd('task_add', randomTask(P.shared, [null])));
  await grantProjectAccess(t.db.db, P.shared, alice.userId, 'viewer');

  // Spread creation times across day boundaries and assign some tasks.
  for (const [i, task] of [...(await t.db.db.select().from(tasks))].entries()) {
    await t.db.db
      .update(tasks)
      .set({
        createdAt: new Date(NOW.getTime() - (i % 7) * 7 * 3600_000),
        ...(task.projectId === P.shared && i % 3 === 0
          ? { assigneeId: i % 2 ? alice.userId : bob.userId, assignedById: bob.userId }
          : {}),
      })
      .where(eq(tasks.id, task.id));
  }
  alice.cursor = null;
  await alice.run();
}, 120_000);
afterAll(async () => t?.close());

/** The client's answer: the shared evaluator over the user's synced state. */
function clientIds(query: string): string[][] {
  const parsed = parseFilter(query, { now: LOCAL, weekStart: 'monday', dateOrder: 'dmy' });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const { queries } = resolveFilter(parsed.queries, {
    projects: [...alice.projects.values()],
    sections: [...alice.sections.values()],
  });
  const live = [...alice.tasks.values()].filter(
    (x) => !x.isCompleted && !alice.projects.get(x.projectId)?.isArchived,
  );
  return queries.map((q) => {
    const match = matcher(q.node, { now: LOCAL, userId: alice.userId, timeZone: ZONE });
    return live
      .filter(match)
      .map((x) => x.id)
      .sort();
  });
}

async function serverIds(query: string): Promise<string[][] | string> {
  const result = await t.db.db.transaction((tx) =>
    runFilter(tx, alice.userId, query, { limit: 500, defaultTimeZone: 'UTC', now: NOW }),
  );
  if (!result.ok) return result.error.message;
  return result.lists.map((l) => l.tasks.map((x) => x.id).sort());
}

const TERMS = [
  'today',
  'tomorrow',
  'yesterday',
  'overdue',
  'no date',
  'no time',
  'recurring',
  'no deadline',
  '7 days',
  '-3 days',
  'next week',
  'this month',
  'due before: today',
  'due after: tomorrow',
  'deadline: today',
  'deadline before: next week',
  'deadline after: yesterday',
  'created: today',
  'created before: today',
  'created: yesterday',
  'p1',
  'p2',
  'p3',
  'p4',
  '#Work',
  '##Work',
  '#Q4',
  '#Home',
  '#Inbox',
  '#Old',
  '#Shared plans',
  '#W*',
  '#*',
  '/Next up',
  '/Later',
  '/*',
  '/Nope',
  '@errands',
  '@*',
  '@home*',
  '@50%_off',
  '@ünïcode',
  'no labels',
  'subtask',
  'search: alpha',
  'search: %_\\\\',
  'search: ünï',
  'assigned',
  'unassigned',
  'assigned to: me',
  'assigned to: others',
  'assigned by: me',
  'assigned by: others',
  'all',
];

const queryArb: fc.Arbitrary<string> = fc.letrec<{ expr: string }>((tie) => ({
  expr: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom(...TERMS),
    fc
      .tuple(tie('expr'), fc.constantFrom(' & ', ' | '), tie('expr'))
      .map(([a, op, b]) => `${a}${op}${b}`),
    tie('expr').map((e) => `!(${e})`),
    tie('expr').map((e) => `(${e})`),
  ),
})).expr;

describe.skipIf(!TEST_DATABASE_URL)('filters: SQL vs in-memory evaluator', () => {
  it.each(TERMS)('%s', async (query) => {
    expect(await serverIds(query)).toEqual(clientIds(query));
  });

  it('agree on random queries', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(queryArb, { minLength: 1, maxLength: 3 }), async (lists) => {
        const query = lists.join(', ');
        expect(await serverIds(query)).toEqual(clientIds(query));
      }),
      { numRuns: 150 },
    );
  });

  it('the sample covers every kind of term', async () => {
    const counts = await Promise.all(
      TERMS.map(async (q) => ((await serverIds(q)) as string[][])[0]!.length),
    );
    const empty = TERMS.filter((_, i) => counts[i] === 0);
    // These match nothing by construction; everything else must exercise real rows.
    expect(empty.sort()).toEqual(['#Old', '/Nope', 'assigned by: me'].sort());
  });
});

describe.skipIf(!TEST_DATABASE_URL)('filters: isolation and injection (security gate)', () => {
  const visibleToAlice = () =>
    new Set(
      [...alice.tasks.values()]
        .filter((x) => !alice.projects.get(x.projectId)?.isArchived)
        .map((x) => x.id),
    );

  it('never returns tasks outside the caller’s visible projects', async () => {
    const lists = await serverIds('all, #Work, ##W*, #*, @*, search: a');
    if (typeof lists === 'string') throw new Error(lists);
    const visible = visibleToAlice();
    for (const list of lists) for (const x of list) expect(visible.has(x)).toBe(true);
    for (const list of lists) for (const x of list) expect(bobSecret.has(x)).toBe(false);
    // `#Work` resolved only to Alice's project, not Bob's identically named one.
    expect(lists[1]!.length).toBeGreaterThan(0);
  });

  it('excludes archived projects, completed and deleted tasks', async () => {
    const lists = (await serverIds('all')) as string[][];
    const rows = await t.db.db.select().from(tasks);
    const bad = new Set(
      rows.filter((r) => r.isCompleted || r.deletedAt || r.projectId === P.old).map((r) => r.id),
    );
    expect(lists[0]!.some((x) => bad.has(x))).toBe(false);
  });

  it('treats arbitrary input as data', async () => {
    const payloads = [
      "search: ' or 1=1 --",
      'search: "); drop table tasks; --',
      "#' or ''='",
      "@x' union select * from users --",
      'due: 2026-01-01; select pg_sleep(5)',
      'search: \\\\x00',
      `search: ${'%'.repeat(199)}`,
      "/'||(select password_hash from users limit 1)||'",
    ];
    for (const q of payloads) {
      const r = await serverIds(q);
      if (typeof r !== 'string') for (const list of r) expect(list).toEqual(clientIds(q)[0]);
    }
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 120 }), async (q) => {
        const r = await serverIds(q);
        const visible = visibleToAlice();
        if (typeof r !== 'string')
          for (const list of r) for (const x of list) expect(visible.has(x)).toBe(true);
      }),
      { numRuns: 200 },
    );
    expect((await t.db.db.select().from(tasks)).length).toBeGreaterThan(0);
  });

  it('refuses to save filters that do not parse', async () => {
    expect(
      await alice.result(cmd('filter_add', { id: id(), name: 'Broken', query: 'today | bogus' })),
    ).toMatchObject({ ok: false, error: 'invalid', message: expect.stringMatching(/bogus/) });
    await alice.ok(cmd('filter_add', { id: id(), name: 'Fine', query: '#Nowhere & p1' }));
  });

  it('serves the endpoint with errors positioned for the editor', async () => {
    const client = new Client(t.app);
    const { token, session } = await t.app.services.sessions.create(
      { id: alice.userId, username: 'alice', isAdmin: false, mustChangePassword: false },
      { ip: null, userAgent: null, authMethod: 'password' },
    );
    client.cookies.set('bokydo_session', token);
    client.csrfToken = session.csrfToken;
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    const ok = await client.request({
      method: 'GET',
      url: `/api/v1/tasks/filter?query=${encodeURIComponent('#Work & p1, #Nope')}`,
    });
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.body) as { lists: { query: string }[]; warnings: string[] };
    expect(body.lists.map((l) => l.query)).toEqual(['#Work & p1', '#Nope']);
    expect(body.warnings).toEqual(['No project named “Nope”']);
    const bad = await client.request({
      method: 'GET',
      url: `/api/v1/tasks/filter?query=${encodeURIComponent('today | bogus')}`,
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ error: 'invalid_filter', start: 8, end: 13 });
  });
});
