import { TODOIST_IMPORT_LIMITS, type TodoistImportRun, type TodoistPreview } from '@bokydo/shared';
import { eq, isNull, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  comments,
  filters,
  importMappings,
  imports,
  projects,
  sections,
  tasks,
} from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { completedPage, fakeTodoist, todoistFixture } from '../test/todoist.js';
import { TODOIST_COMPLETED_URL, TODOIST_SYNC_URL } from './todoist-client.js';

const TOKEN = '0123456789abcdef0123456789abcdef01234567';
let t: TestApp;
let logs: string[];

/** A fixed "now" so completed-task fixtures don't age: the importer takes its clock from here. */
const NOW = new Date('2026-10-09T12:00:00Z');

async function setup(
  answer: () => unknown = todoistFixture,
  status = 200,
  completed: (projectId: string | null) => unknown = () => completedPage(),
) {
  const todoist = fakeTodoist(answer, status, completed);
  logs = [];
  t = await testApp({
    importFetch: todoist.fetch,
    importNow: () => NOW,
    logger: {
      level: 'trace',
      stream: { write: (line: string) => void logs.push(line) },
    },
  });
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  const person = async (name: string) => {
    const userId = await createUser(t.db, { username: name, password: 'x'.repeat(12) });
    const http = new Client(t.app);
    const { token, session } = await t.app.services.sessions.create(
      { id: userId, username: name, isAdmin: false, mustChangePassword: false },
      { ip: null, userAgent: null, authMethod: 'password' },
    );
    http.cookies.set('bokydo_session', token);
    http.csrfToken = session.csrfToken;
    const sync = new SyncUser(t.app.services.sync, userId);
    await sync.run();
    return { id: userId, http, sync };
  };
  return { todoist, alice: await person('alice'), bob: await person('bob') };
}

type Person = Awaited<ReturnType<typeof setup>>['alice'];

const connect = async (who: Person) => {
  const res = await who.http.post('/api/v1/import/todoist/connect', { token: TOKEN });
  expect(res.statusCode).toBe(200);
  return res.json() as TodoistPreview;
};

const everything = (preview: TodoistPreview, overrides: Record<string, unknown> = {}) => ({
  sessionId: preview.sessionId,
  projects: preview.projects.map((p) => ({ id: p.id, action: 'new' })),
  labels: preview.labels.map((l) => l.id),
  filters: preview.filters.map((f) => f.id),
  comments: true,
  completed: false,
  completedWindow: '3m',
  people: [],
  ...overrides,
});

async function run(who: Person, choices: Record<string, unknown>): Promise<TodoistImportRun> {
  const res = await who.http.post('/api/v1/import/todoist/runs', choices);
  expect(res.statusCode).toBe(202);
  const { id: runId } = res.json() as { id: string };
  await t.app.services.importer.idle(who.id);
  const status = await who.http.get(`/api/v1/import/todoist/runs/${runId}`);
  return (status.json() as { run: TodoistImportRun }).run;
}

// Every test starts a fresh database (drop the schema, migrate), so the default 5s is too
// short for the ones that build more than one app.
describe.skipIf(!TEST_DATABASE_URL)('Todoist import', { timeout: 30_000 }, () => {
  afterEach(async () => t.close());

  it('reads the account once with the token in the header only, and never keeps or logs it', async () => {
    const { todoist, alice } = await setup();
    const preview = await connect(alice);
    // The account, then one completed series per project (Todoist's endpoint answers one
    // project at a time) — every read with the same token, in the header only (W11a-c1).
    expect(todoist.calls).toHaveLength(1 + preview.projects.length);
    expect(todoist.calls[0]?.url).toBe(TODOIST_SYNC_URL);
    expect(todoist.calls[1]?.url).toContain(TODOIST_COMPLETED_URL);
    expect(todoist.calls[1]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(todoist.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(todoist.calls[0]?.body).not.toContain(TOKEN);
    expect(JSON.parse(todoist.calls[0]?.body ?? '{}')).toMatchObject({ sync_token: '*' });
    // Every project's history is asked for, one project per request.
    expect(
      todoist.calls.slice(1).map((c) => new URL(c.url).searchParams.get('project_id')),
    ).toEqual(preview.projects.map((p) => p.id));
    expect(JSON.stringify(preview)).not.toContain(TOKEN);
    expect(preview.account).toEqual({ name: 'Ana Import', email: 'ana@example.com' });
    const work = preview.projects.find((p) => p.name === 'Work');
    expect(work).toMatchObject({ sections: 2, tasks: 3, comments: 3, isShared: true });
    // The Todoist Inbox is offered to go into your own Inbox.
    expect(preview.projects.find((p) => p.isInbox)?.suggestedMerge).toBe(alice.sync.inbox);
    expect(preview.labels.find((l) => l.name === 'two words')?.invalid).toBe(true);
    expect(preview.filters.find((f) => f.name === 'Odd')?.supported).toBe(false);
    expect(preview.people.find((p) => p.isYou)?.id).toBe('u1');

    await run(alice, everything(preview));
    expect(logs.join('\n')).not.toContain(TOKEN);
    const dump = JSON.stringify(await t.db.db.select().from(imports));
    expect(dump).not.toContain(TOKEN);
  });

  it('imports the chosen items through sync commands, with a dry run that matches', async () => {
    const { alice } = await setup();
    const preview = await connect(alice);
    const choices = everything(preview, {
      projects: preview.projects
        .filter((p) => p.name !== 'Home')
        .map((p) =>
          p.isInbox
            ? { id: p.id, action: 'merge', targetId: alice.sync.inbox }
            : { id: p.id, action: 'new' },
        ),
    });
    const dry = await alice.http.post('/api/v1/import/todoist/plan', choices);
    expect(dry.statusCode).toBe(200);
    expect(dry.json().counts).toMatchObject({ projects: 2, merged: 1, sections: 2, tasks: 4 });
    // A dry run writes nothing.
    expect(await t.db.db.select().from(tasks)).toHaveLength(0);

    const result = await run(alice, choices);
    expect(result).toMatchObject({
      status: 'done',
      counts: { projects: 2, tasks: 4, comments: 3 },
    });
    expect(result.done).toBe(result.total);

    await alice.sync.run();
    const byName = (n: string) => [...alice.sync.projects.values()].find((p) => p.name === n);
    const work = byName('Work');
    const clients = byName('Clients');
    expect(clients?.parentId).toBe(work?.id);
    expect(byName('Home')).toBeUndefined();
    const all = [...alice.sync.tasks.values()];
    const report = all.find((x) => x.content === 'Write report');
    const outline = all.find((x) => x.content === 'Outline');
    expect(report).toMatchObject({ projectId: work?.id, priority: 1, labels: ['deep-work'] });
    expect(report?.sectionId).toBe(
      [...alice.sync.sections.values()].find((s) => s.name === 'To do')?.id,
    );
    expect(outline).toMatchObject({ parentId: report?.id, assigneeId: alice.id });
    expect(all.find((x) => x.content === 'Call the bank')?.projectId).toBe(alice.sync.inbox);
    const notes = [...alice.sync.comments.values()].map((c) => c.content);
    expect(notes).toEqual(
      expect.arrayContaining([expect.stringContaining('**Ben Colleague**'), 'Team rules']),
    );
    expect([...alice.sync.labels.values()].map((l) => l.name)).toEqual(['deep-work']);
    expect([...alice.sync.filters.values()].map((f) => f.name).sort()).toEqual([
      'Focus',
      'Home stuff',
    ]);
  });

  it('can be run again without duplicating anything, and picks up what was skipped', async () => {
    const { alice } = await setup();
    const preview = await connect(alice);
    const onlyWork = everything(preview, {
      projects: [{ id: 'p-work', action: 'new' }],
      comments: false,
    });
    await run(alice, onlyWork);
    const count = async () => ({
      projects: (await t.db.db.select().from(projects).where(isNull(projects.deletedAt))).length,
      tasks: (await t.db.db.select().from(tasks)).length,
      sections: (await t.db.db.select().from(sections)).length,
      filters: (await t.db.db.select().from(filters)).length,
      comments: (await t.db.db.select().from(comments)).length,
    });
    const first = await count();

    const again = await run(alice, onlyWork);
    expect(again.counts).toMatchObject({ projects: 0, tasks: 0, sections: 0, filters: 0 });
    expect(await count()).toEqual(first);

    // Now with comments and Home: only those are added.
    const more = await run(
      alice,
      everything(preview, {
        projects: [
          { id: 'p-work', action: 'new' },
          { id: 'p-home', action: 'new' },
        ],
      }),
    );
    expect(more.counts).toMatchObject({ projects: 1, tasks: 1, comments: 3, sections: 0 });
    const after = await count();
    expect(after.tasks).toBe(first.tasks + 1);

    // A task deleted since comes back on the next run (only live items count as imported).
    const [report] = await t.db.db
      .select({ id: importMappings.localId })
      .from(importMappings)
      .where(eq(importMappings.externalId, 't-outline'));
    await alice.sync.ok(cmd('task_delete', { id: report!.id }));
    const restored = await run(alice, onlyWork);
    expect(restored.counts?.tasks).toBe(1);
  });

  it('reports items it could not write and carries on with the rest', async () => {
    const { alice, bob } = await setup();
    // A merge target alice may only view: every write into it is refused by the sync engine.
    const shared = id();
    await bob.sync.ok(cmd('project_add', { id: shared, name: 'Bob shared' }));
    const preview = await connect(alice);
    const bad = await alice.http.post(
      '/api/v1/import/todoist/plan',
      everything(preview, { projects: [{ id: 'p-work', action: 'merge', targetId: shared }] }),
    );
    expect(bad.statusCode).toBe(400); // not a project alice can write to

    // A team alice isn't in: that project is refused, so is its task; Work still comes over.
    const result = await run(
      alice,
      everything(preview, {
        projects: [
          { id: 'p-home', action: 'new', workspaceId: id() },
          { id: 'p-work', action: 'new' },
        ],
        comments: false,
      }),
    );
    expect(result.status).toBe('done');
    expect(result.counts).toMatchObject({ projects: 1, tasks: 3 });
    const failed = result.warnings.filter((w) => w.kind === 'failed').map((w) => w.message);
    expect(failed).toEqual([
      expect.stringContaining('“Home”'),
      expect.stringContaining('“Water plants in the garden”'),
    ]);
    // Nothing of the refused project was half-written, and a re-run tries it again.
    const homeMapped = await t.db.db
      .select()
      .from(importMappings)
      .where(eq(importMappings.externalId, 'p-home'));
    expect(homeMapped).toHaveLength(0);
  });

  it('keeps sessions to their owner and refuses a bad token or an unreachable Todoist', async () => {
    const { alice, bob } = await setup();
    const preview = await connect(alice);
    const theirs = await bob.http.post('/api/v1/import/todoist/plan', everything(preview));
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json()).toEqual({ error: 'session_expired' });
    expect(
      (await alice.http.post('/api/v1/import/todoist/connect', { token: 'short' })).statusCode,
    ).toBe(400);
    await alice.http.post('/api/v1/import/todoist/disconnect', { sessionId: preview.sessionId });
    expect(
      (await alice.http.post('/api/v1/import/todoist/plan', everything(preview))).statusCode,
    ).toBe(404);
    await t.close();

    const denied = await setup(() => ({ error: 'Unauthorized' }), 401);
    const res = await denied.alice.http.post('/api/v1/import/todoist/connect', { token: TOKEN });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'todoist_unauthorized' });
    await t.close();

    const garbage = await setup(() => ({ user: { id: 'u' }, items: [{ nope: true }] }));
    const bad = await garbage.alice.http.post('/api/v1/import/todoist/connect', { token: TOKEN });
    expect(bad.statusCode).toBe(502);
    expect(bad.json()).toEqual({ error: 'todoist_invalid_response' });
  });

  // ---- completed tasks (W11a-c1) ----

  /** An RFC 3339 timestamp `days` before the injected NOW, for the completed-item fixtures. */
  const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

  const completedItems = [
    {
      id: 'c-report',
      project_id: 'p-work',
      section_id: 's-todo',
      parent_id: null,
      content: 'Write report',
      description: 'Quarterly numbers',
      priority: 4,
      labels: ['deep-work'],
      child_order: 0,
      completed_at: iso(-23 * 86_400_000),
      completed_by_uid: 'u2',
      responsible_uid: 'u2',
    },
    {
      id: 'c-outline',
      project_id: 'p-work',
      parent_id: 'c-report',
      content: 'Outline',
      priority: 1,
      labels: [],
      child_order: 0,
      completed_at: iso(-24 * 86_400_000),
      completed_by_uid: null,
    },
    {
      // Older than a month, but inside the three-month window: only a 3-month window brings it
      // over.
      id: 'c-old',
      project_id: 'p-work',
      content: 'Old task',
      priority: 4,
      labels: [],
      child_order: 0,
      completed_at: iso(-60 * 86_400_000),
    },
    {
      // In a project the user skipped: not brought over at all.
      id: 'c-skipped',
      project_id: 'p-home',
      content: 'Skipped',
      priority: 4,
      labels: [],
      child_order: 0,
      completed_at: iso(-38 * 86_400_000),
    },
  ];

  const withCompleted = (items: unknown[] = completedItems) =>
    setup(todoistFixture, 200, () => completedPage(items));

  it('counts the completed tasks it read, without a second connect', async () => {
    const { todoist, alice } = await withCompleted();
    const preview = await connect(alice);
    expect(preview.totals.completed).toBe(4);
    // The read happened at connect; the choice is only applied later.
    expect(todoist.calls).toHaveLength(1 + preview.projects.length);
  });

  it('brings completed tasks over with their real completion time and completer', async () => {
    const { alice } = await withCompleted();
    const preview = await connect(alice);
    const choices = everything(preview, {
      projects: preview.projects
        .filter((p) => p.name !== 'Home')
        .map((p) =>
          p.isInbox
            ? { id: p.id, action: 'merge', targetId: alice.sync.inbox }
            : { id: p.id, action: 'new' },
        ),
      completed: true,
      completedWindow: '3m',
      people: preview.people.map((p) => ({ id: p.id, userId: p.isYou ? alice.id : null })),
    });
    const summary = (await alice.http.post('/api/v1/import/todoist/plan', choices)).json();
    expect(summary.counts.completedTasks).toBe(3); // the skipped project's task is left out

    const status = await run(alice, choices);
    expect(status.counts?.completedTasks).toBe(3);

    const rows = await t.db.db.select().from(tasks);
    // The account has an open task with the same name as the completed one (last month's
    // report): the completed row is the one to check.
    const report = rows.find((r) => r.content === 'Write report' && r.isCompleted)!;
    expect(report.isCompleted).toBe(true);
    // The real completion time, not the moment of the import.
    expect(report.completedAt?.toISOString()).toBe(iso(-23 * 86_400_000));
    // The original completer, mapped through the people choice.
    expect(report.completedById).toBe(null); // Ben is not a BokyDo user here
    expect(report.priority).toBe(1); // 4 in Todoist is p1 in BokyDo
    expect(report.labels).toEqual(['deep-work']);
    const outline = rows.find((r) => r.content === 'Outline' && r.isCompleted)!;
    expect(outline.parentId).toBe(report.id); // completed sub-tasks under their completed parent
    expect(outline.completedAt?.toISOString()).toBe(iso(-24 * 86_400_000));
    expect(rows.some((r) => r.content === 'Skipped')).toBe(false);
    // The older task is inside the three-month window, so it comes over with its own date.
    const old = rows.find((r) => r.content === 'Old task')!;
    expect(old.completedAt?.toISOString()).toBe(iso(-60 * 86_400_000));

    // An import is not a completion: nothing in the activity log says a task was completed.
    const activity = JSON.stringify(await t.db.db.execute(sql`select type from activity`));
    expect(activity).not.toContain('task_completed');
  });

  it('a month window leaves older completed tasks alone', async () => {
    const { alice } = await withCompleted([
      {
        id: 'new',
        project_id: 'p-work',
        content: 'Fresh',
        priority: 4,
        labels: [],
        child_order: 0,
        completed_at: iso(-5 * 86_400_000),
      },
      {
        id: 'old',
        project_id: 'p-work',
        content: 'Stale',
        priority: 4,
        labels: [],
        child_order: 0,
        completed_at: iso(-281 * 86_400_000),
      },
    ]);
    const preview = await connect(alice);
    const base = everything(preview, { completed: true });
    const status = await run(alice, { ...base, completedWindow: '1m' });
    expect(status.counts?.completedTasks).toBe(1);
    const rows = await t.db.db.select().from(tasks);
    expect(rows.map((r) => r.content)).not.toContain('Stale');
  });

  it('says nothing was imported when the choice is off', async () => {
    const { alice } = await withCompleted();
    const preview = await connect(alice);
    const status = await run(alice, everything(preview));
    expect(status.counts?.tasks).toBeGreaterThan(0);
    expect(status.counts?.completedTasks).toBe(0);
    const rows = await t.db.db.select().from(tasks);
    expect(rows.every((r) => !r.isCompleted)).toBe(true);
  });

  it('a re-run adds each completed task once', async () => {
    const { alice } = await withCompleted();
    const preview = await connect(alice);
    const choices = everything(preview, { completed: true });
    const first = await run(alice, choices);
    // Every project's history comes over here: three in Work, one in Home.
    expect(first.counts?.completedTasks).toBe(4);
    const again = await run(alice, choices);
    expect(again.counts?.completedTasks).toBe(0);
    expect(again.counts?.completedAlreadyImported).toBe(4);
    const rows = await t.db.db.select().from(tasks);
    // The open task with the same name is a different Todoist task: only the completed one
    // may be there, and only once.
    expect(rows.filter((r) => r.content === 'Write report' && r.isCompleted)).toHaveLength(1);
  });

  it('is happy with an account that has no completed tasks', async () => {
    const { alice } = await withCompleted([]);
    const preview = await connect(alice);
    expect(preview.totals.completed).toBe(0);
    const status = await run(alice, everything(preview, { completed: true }));
    expect(status.counts?.completedTasks).toBe(0);
  });

  it('says which projects kept no history when the account has more projects than one read', async () => {
    // Todoist's endpoint answers one project at a time, so one connect reads a bounded number of
    // projects: the ones past the cap keep no completed history, and the plan says so.
    const base = todoistFixture();
    const extra = Array.from({ length: TODOIST_IMPORT_LIMITS.completedProjects }, (_, i) => ({
      id: `p-extra-${i}`,
      name: `Extra ${i}`,
      parent_id: null,
      child_order: 10 + i,
      is_deleted: false,
    }));
    const { alice } = await setup(() => ({ ...base, projects: [...base.projects, ...extra] }));
    const preview = await connect(alice);
    const missed = preview.projects.length - TODOIST_IMPORT_LIMITS.completedProjects;
    expect(missed).toBeGreaterThan(0);
    const plan = await alice.http.post(
      '/api/v1/import/todoist/plan',
      everything(preview, { completed: true }),
    );
    expect(plan.statusCode).toBe(200);
    expect(plan.json().warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'completed',
          message: expect.stringContaining(`${missed} of the chosen projects`),
        }),
      ]),
    );
  });

  it('never lets the request name who completed a task', async () => {
    // A stranger's user id in the people map must not become completed_by: the completer has to
    // be a BokyDo user who may see the project the task lands in.
    const items = completedItems.map((c) =>
      c.id === 'c-report' ? { ...c, completed_by_uid: 'u-stranger' } : c,
    );
    const { alice } = await withCompleted(items);
    const preview = await connect(alice);
    const stranger = id();
    const choices = everything(preview, {
      completed: true,
      people: [
        ...preview.people.map((p) => ({ id: p.id, userId: p.isYou ? alice.id : null })),
        { id: 'u-stranger', userId: stranger },
      ],
      projects: preview.projects
        .filter((p) => p.name !== 'Home')
        .map((p) => ({ id: p.id, action: 'new' })),
    });
    const status = await run(alice, choices);
    expect(status.counts?.completedTasks).toBe(3);
    const rows = await t.db.db.select().from(tasks);
    const report = rows.find((r) => r.content === 'Write report' && r.isCompleted)!;
    expect(report.completedById).toBeNull();
    // ...and an import is never a completion event.
    const activity = JSON.stringify(await t.db.db.execute(sql`select type from activity`));
    expect(activity).not.toContain('task_completed');
  });

  it('keeps the account readable when the completed-items read fails', async () => {
    // A 400/422 or a schema mismatch on that endpoint is Todoist's problem, not the user's.
    const broken = fakeTodoist(todoistFixture, 200, () => ({ nope: true }));
    const app = await testApp({
      importFetch: broken.fetch,
      importNow: () => NOW,
      logger: { level: 'trace', stream: { write: () => {} } },
    });
    await app.app.services.settings.markSetupComplete({ userId: null, ip: null });
    const userId = await createUser(app.db, { username: 'carol', password: 'x'.repeat(12) });
    const http = new Client(app.app);
    const { token, session } = await app.app.services.sessions.create(
      { id: userId, username: 'carol', isAdmin: false, mustChangePassword: false },
      { ip: null, userAgent: null, authMethod: 'password' },
    );
    http.cookies.set('bokydo_session', token);
    http.csrfToken = session.csrfToken;
    const res = await http.post('/api/v1/import/todoist/connect', { token: TOKEN });
    expect(res.statusCode).toBe(200);
    const preview = res.json() as TodoistPreview;
    // The snapshot still arrived, so the account opens; the count is just zero.
    expect(preview.totals.completed).toBe(0);
    // Asking for completed tasks is refused instead of silently importing none.
    const bad = await http.post(
      '/api/v1/import/todoist/runs',
      everything(preview, { completed: true }),
    );
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('runs one import at a time per user', async () => {
    const { alice } = await setup();
    const preview = await connect(alice);
    const first = await alice.http.post('/api/v1/import/todoist/runs', everything(preview));
    const second = await alice.http.post('/api/v1/import/todoist/runs', everything(preview));
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    await t.app.services.importer.idle(alice.id);
    const latest = await alice.http.get('/api/v1/import/todoist/runs/latest');
    expect(latest.json().run).toMatchObject({ id: first.json().id, status: 'done' });
  });
});
