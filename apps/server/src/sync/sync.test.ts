import { generateKeyBetween } from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../db/schema.js';
import { createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { grantProjectAccess, revokeProjectAccess } from './membership.js';

let t: TestApp;
let alice: SyncUser;
let bob: SyncUser;

beforeEach(async () => {
  t = await testApp();
  const a = await createUser(t.db, { username: 'alice', password: 'x'.repeat(12) });
  const b = await createUser(t.db, { username: 'bob', password: 'x'.repeat(12) });
  alice = new SyncUser(t.app.services.sync, a);
  bob = new SyncUser(t.app.services.sync, b);
  await alice.run();
  await bob.run();
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('sync basics', () => {
  it('starts with a full sync and an inbox', () => {
    expect(alice.last.fullSync).toBe(true);
    expect(alice.projects.get(alice.inbox)).toMatchObject({
      name: 'Inbox',
      isInbox: true,
      role: 'owner',
    });
    expect(alice.cursor).toMatch(/^\d+$/);
  });

  it('creates projects, sections, tasks and sub-tasks in order', async () => {
    const p = id();
    const s = id();
    const [t1, t2, sub] = [id(), id(), id()];
    await alice.ok(
      cmd('project_add', { id: p, name: 'Lisbon trip', color: 'teal' }),
      cmd('section_add', { id: s, projectId: p, name: 'Bookings' }),
      cmd('task_add', { id: t1, projectId: p, sectionId: s, content: 'Flights', priority: 1 }),
      cmd('task_add', { id: t2, projectId: p, sectionId: s, content: 'Hotel' }),
      cmd('task_add', { id: sub, parentId: t1, content: 'Compare prices' }),
    );
    expect(alice.last.fullSync).toBe(false);
    expect(alice.projects.get(p)).toMatchObject({
      name: 'Lisbon trip',
      color: 'teal',
      role: 'owner',
    });
    const [a, b, c] = [alice.tasks.get(t1)!, alice.tasks.get(t2)!, alice.tasks.get(sub)!];
    expect(a.childOrder < b.childOrder).toBe(true);
    expect(c).toMatchObject({ parentId: t1, projectId: p, sectionId: s, priority: 4 });
    expect(a.priority).toBe(1);
  });

  it('puts tasks without a project in the inbox', async () => {
    const task = id();
    await alice.ok(cmd('task_add', { id: task, content: 'Buy milk' }));
    expect(alice.tasks.get(task)!.projectId).toBe(alice.inbox);
  });

  it('only sends what changed since the cursor', async () => {
    const [x, y] = [id(), id()];
    await alice.ok(cmd('task_add', { id: x, content: 'x' }));
    await alice.ok(cmd('task_add', { id: y, content: 'y' }));
    expect(alice.last.tasks.map((t) => t.id)).toEqual([y]);
    await alice.ok(cmd('task_delete', { id: x }));
    expect(alice.last.removed.tasks).toEqual([x]);
    expect(alice.tasks.has(x)).toBe(false);
  });

  it('completes sub-tasks with their parent and reopens ancestors with a child', async () => {
    const [parent, child] = [id(), id()];
    await alice.ok(
      cmd('task_add', { id: parent, content: 'p' }),
      cmd('task_add', { id: child, parentId: parent, content: 'c' }),
    );
    await alice.ok(cmd('task_complete', { id: parent }));
    expect(alice.tasks.get(child)!.isCompleted).toBe(true);
    await alice.ok(cmd('task_uncomplete', { id: child }));
    expect(alice.tasks.get(parent)!.isCompleted).toBe(false);
    expect(alice.tasks.get(child)!.isCompleted).toBe(false);
  });

  it('deleting a section deletes its tasks', async () => {
    const [p, s, task] = [id(), id(), id()];
    await alice.ok(
      cmd('project_add', { id: p, name: 'P' }),
      cmd('section_add', { id: s, projectId: p, name: 'S' }),
      cmd('task_add', { id: task, projectId: p, sectionId: s, content: 't' }),
    );
    await alice.ok(cmd('section_delete', { id: s }));
    expect(alice.sections.has(s)).toBe(false);
    expect(alice.tasks.has(task)).toBe(false);
  });

  it('moves a task with its sub-tasks and refuses cycles', async () => {
    const [p2, parent, child, grandchild] = [id(), id(), id(), id()];
    await alice.ok(
      cmd('project_add', { id: p2, name: 'Other' }),
      cmd('task_add', { id: parent, content: 'p' }),
      cmd('task_add', { id: child, parentId: parent, content: 'c' }),
      cmd('task_add', { id: grandchild, parentId: child, content: 'g' }),
    );
    await alice.ok(cmd('task_move', { id: parent, projectId: p2 }));
    expect([parent, child, grandchild].map((x) => alice.tasks.get(x)!.projectId)).toEqual([
      p2,
      p2,
      p2,
    ]);
    expect(
      await alice.result(cmd('task_move', { id: parent, parentId: grandchild })),
    ).toMatchObject({ ok: false, error: 'invalid' });
    expect(await alice.result(cmd('task_move', { id: parent, parentId: parent }))).toMatchObject({
      ok: false,
      error: 'invalid',
    });
  });

  it('limits sub-task depth', async () => {
    let parent = id();
    await alice.ok(cmd('task_add', { id: parent, content: '0' }));
    for (let depth = 1; depth <= 4; depth++) {
      const next = id();
      await alice.ok(cmd('task_add', { id: next, parentId: parent, content: String(depth) }));
      parent = next;
    }
    expect(
      await alice.result(cmd('task_add', { id: id(), parentId: parent, content: '5' })),
    ).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('removes deleted projects (with sub-projects) and hides their contents', async () => {
    const [p, child, task] = [id(), id(), id()];
    await alice.ok(
      cmd('project_add', { id: p, name: 'P' }),
      cmd('project_add', { id: child, name: 'C', parentId: p }),
      cmd('task_add', { id: task, projectId: child, content: 't' }),
    );
    await alice.ok(cmd('project_delete', { id: p }));
    expect(alice.last.removed.projects.sort()).toEqual([p, child].sort());
    expect(alice.tasks.has(task)).toBe(false);
    alice.cursor = null;
    await alice.run();
    expect(alice.projects.has(p) || alice.tasks.has(task)).toBe(false);
  });

  it('protects the inbox', async () => {
    for (const c of [
      cmd('project_delete', { id: alice.inbox }),
      cmd('project_archive', { id: alice.inbox }),
      cmd('project_update', { id: alice.inbox, name: 'Not inbox' }),
      cmd('project_move', { id: alice.inbox, parentId: null }),
    ]) {
      expect(await alice.result(c)).toMatchObject({ ok: false, error: 'invalid' });
    }
  });

  it('treats archived projects as read-only', async () => {
    const [p, task] = [id(), id()];
    await alice.ok(
      cmd('project_add', { id: p, name: 'P' }),
      cmd('task_add', { id: task, projectId: p, content: 't' }),
    );
    await alice.ok(cmd('project_archive', { id: p }));
    expect(await alice.result(cmd('task_update', { id: task, content: 'x' }))).toMatchObject({
      ok: false,
      error: 'invalid',
    });
    expect(
      await alice.result(cmd('task_add', { id: id(), projectId: p, content: 'x' })),
    ).toMatchObject({ ok: false });
    await alice.ok(cmd('project_unarchive', { id: p }));
    await alice.ok(cmd('task_update', { id: task, content: 'x' }));
  });

  it('renames and removes labels on tasks, with case-insensitive unique names', async () => {
    const [label, task] = [id(), id()];
    await alice.ok(
      cmd('label_add', { id: label, name: 'errands' }),
      cmd('task_add', { id: task, content: 't', labels: ['errands', 'home', 'Errands'] }),
    );
    expect(alice.tasks.get(task)!.labels).toEqual(['errands', 'home']);
    expect(await alice.result(cmd('label_add', { id: id(), name: 'ERRANDS' }))).toMatchObject({
      ok: false,
      error: 'conflict',
    });
    await alice.ok(cmd('label_update', { id: label, name: 'shopping' }));
    expect(alice.tasks.get(task)!.labels).toEqual(['shopping', 'home']);
    await alice.ok(cmd('label_delete', { id: label }));
    expect(alice.tasks.get(task)!.labels).toEqual(['home']);
    expect(alice.labels.has(label)).toBe(false);
  });

  it('keeps per-user favorites and order keys', async () => {
    const p = id();
    await alice.ok(
      cmd('project_add', {
        id: p,
        name: 'P',
        isFavorite: true,
        childOrder: generateKeyBetween(null, null),
      }),
    );
    expect(alice.projects.get(p)).toMatchObject({ isFavorite: true, childOrder: 'a0' });
    expect(
      await alice.result(cmd('project_add', { id: id(), name: 'Bad', childOrder: 'a0;--' })),
    ).toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('idempotency', () => {
  it('applies a command UUID once and replays its result', async () => {
    const c = cmd('task_add', { id: id(), content: 'once' });
    const first = await alice.result(c);
    const again = await alice.result(c);
    expect(first).toEqual({ ok: true });
    expect(again).toEqual(first);
    expect(await t.db.db.select().from(tasks).where(eq(tasks.content, 'once'))).toHaveLength(1);
  });

  it('replays failures too, even after the cause is fixed', async () => {
    const p = id();
    const c = cmd('task_add', { id: id(), projectId: p, content: 'x' });
    expect(await alice.result(c)).toMatchObject({ ok: false, error: 'not_found' });
    await alice.ok(cmd('project_add', { id: p, name: 'P' }));
    expect(await alice.result(c)).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('never lets a client-chosen id overwrite someone else’s row', async () => {
    const task = id();
    await alice.ok(cmd('task_add', { id: task, content: 'alice’s' }));
    expect(await bob.result(cmd('task_add', { id: task, content: 'bob’s' }))).toMatchObject({
      ok: false,
      error: 'conflict',
    });
    expect((await t.db.db.select().from(tasks).where(eq(tasks.id, task)))[0]!.content).toBe(
      'alice’s',
    );
    expect(await bob.result(cmd('project_add', { id: alice.inbox, name: 'mine' }))).toMatchObject({
      ok: false,
      error: 'conflict',
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('isolation between users', () => {
  let p: string, s: string, task: string, label: string, filter: string;
  beforeEach(async () => {
    [p, s, task, label, filter] = [id(), id(), id(), id(), id()];
    await alice.ok(
      cmd('project_add', { id: p, name: 'Secret project' }),
      cmd('section_add', { id: s, projectId: p, name: 'Secret section' }),
      cmd('task_add', { id: task, projectId: p, sectionId: s, content: 'Secret task' }),
      cmd('label_add', { id: label, name: 'secretlabel' }),
      cmd('filter_add', { id: filter, name: 'Secret filter', query: 'today' }),
    );
  });

  it('every command on another user’s data is not_found and changes nothing', async () => {
    const attacks = [
      cmd('project_update', { id: p, name: 'pwned' }),
      cmd('project_update', { id: p, isFavorite: true }),
      cmd('project_move', { id: p, parentId: null }),
      cmd('project_archive', { id: p }),
      cmd('project_unarchive', { id: p }),
      cmd('project_delete', { id: p }),
      cmd('project_add', { id: id(), name: 'child', parentId: p }),
      cmd('section_add', { id: id(), projectId: p, name: 'x' }),
      cmd('section_update', { id: s, name: 'pwned' }),
      cmd('section_move', { id: s, projectId: bob.inbox }),
      cmd('section_archive', { id: s }),
      cmd('section_delete', { id: s }),
      cmd('task_add', { id: id(), projectId: p, content: 'x' }),
      cmd('task_add', { id: id(), parentId: task, content: 'x' }),
      cmd('task_update', { id: task, content: 'pwned' }),
      cmd('task_move', { id: task, projectId: bob.inbox }),
      cmd('task_complete', { id: task }),
      cmd('task_uncomplete', { id: task }),
      cmd('task_delete', { id: task }),
      cmd('label_update', { id: label, name: 'pwned' }),
      cmd('label_delete', { id: label }),
      cmd('filter_update', { id: filter, name: 'pwned' }),
      cmd('filter_delete', { id: filter }),
    ];
    for (const attack of attacks) {
      expect(await bob.result(attack), attack.type).toMatchObject({
        ok: false,
        error: 'not_found',
      });
    }
    // Moving Bob's own task *into* Alice's project is refused too.
    const own = id();
    await bob.ok(cmd('task_add', { id: own, content: 'mine' }));
    expect(await bob.result(cmd('task_move', { id: own, projectId: p }))).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    expect(await bob.result(cmd('task_move', { id: own, parentId: task }))).toMatchObject({
      ok: false,
      error: 'not_found',
    });

    alice.cursor = null;
    await alice.run();
    expect(alice.projects.get(p)!.name).toBe('Secret project');
    expect(alice.tasks.get(task)!.content).toBe('Secret task');
    expect(alice.labels.get(label)!.name).toBe('secretlabel');
  });

  it('never syncs another user’s data, whatever the cursor', async () => {
    const leaks = (json: string) => /Secret|secretlabel/.test(json);
    for (const cursor of [null, '0', '1', '999999999999', '9223372036854775807']) {
      const res = await t.app.services.sync.sync(bob.userId, { cursor });
      expect(leaks(JSON.stringify(res)), `cursor ${cursor}`).toBe(false);
    }
    await alice.ok(cmd('task_update', { id: task, content: 'Secret edit' }));
    const res = await t.app.services.sync.sync(bob.userId, { cursor: bob.cursor });
    expect(leaks(JSON.stringify(res))).toBe(false);
    expect(res.removed.tasks).not.toContain(task);
  });

  it('rejects mass assignment of server-controlled fields', async () => {
    for (const args of [
      { id: id(), content: 'x', createdById: alice.userId },
      { id: id(), content: 'x', isCompleted: true },
      { id: id(), content: 'x', deletedAt: null },
      { id: id(), content: 'x', ownerId: bob.userId },
    ]) {
      expect(await bob.result(cmd('task_add', args))).toMatchObject({
        ok: false,
        error: 'invalid',
      });
    }
    expect(
      await bob.result(cmd('project_add', { id: id(), name: 'x', ownerId: alice.userId })),
    ).toMatchObject({ ok: false, error: 'invalid' });
    expect(await bob.result(cmd('project_update', { id: bob.inbox, role: 'owner' }))).toMatchObject(
      { ok: false, error: 'invalid' },
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)('shared projects and roles', () => {
  let p: string, task: string;
  beforeEach(async () => {
    [p, task] = [id(), id()];
    await alice.ok(
      cmd('project_add', { id: p, name: 'Team' }),
      cmd('task_add', { id: task, projectId: p, content: 'Existing' }),
    );
  });

  it('a grant brings the whole project, a revoke removes it', async () => {
    await grantProjectAccess(t.db.db, p, bob.userId, 'editor');
    await bob.run();
    expect(bob.projects.get(p)).toMatchObject({ role: 'editor' });
    expect(bob.tasks.get(task)!.content).toBe('Existing');

    await alice.ok(cmd('task_update', { id: task, content: 'Edited by Alice' }));
    await bob.run();
    expect(bob.tasks.get(task)!.content).toBe('Edited by Alice');

    await revokeProjectAccess(t.db.db, p, bob.userId);
    await bob.run();
    expect(bob.projects.has(p)).toBe(false);
    expect(bob.tasks.has(task)).toBe(false);

    await alice.ok(cmd('task_update', { id: task, content: 'After revoke' }));
    const res = await t.app.services.sync.sync(bob.userId, { cursor: bob.cursor });
    expect(JSON.stringify(res)).not.toContain('After revoke');
    expect(await bob.result(cmd('task_update', { id: task, content: 'x' }))).toMatchObject({
      ok: false,
      error: 'not_found',
    });
  });

  it('a task moved out of a shared project disappears for those who can’t follow it', async () => {
    const privateProject = id();
    await grantProjectAccess(t.db.db, p, bob.userId, 'editor');
    await bob.run();
    await alice.ok(
      cmd('project_add', { id: privateProject, name: 'Private' }),
      cmd('task_move', { id: task, projectId: privateProject }),
    );
    await bob.run();
    expect(bob.tasks.has(task)).toBe(false);
    expect(bob.last.removed.tasks).toContain(task);
  });

  it('enforces roles', async () => {
    const roleCan = async (role: 'viewer' | 'commenter' | 'editor' | 'admin') => {
      await grantProjectAccess(t.db.db, p, bob.userId, role);
      const r = async (c: ReturnType<typeof cmd>) => (await bob.result(c))?.ok ?? false;
      return {
        editTask: await r(cmd('task_update', { id: task, content: `by ${role}` })),
        addSection: await r(cmd('section_add', { id: id(), projectId: p, name: role })),
        rename: await r(cmd('project_update', { id: p, name: `Team ${role}` })),
        favorite: await r(cmd('project_update', { id: p, isFavorite: true })),
        delete: await r(cmd('project_delete', { id: p })),
      };
    };
    expect(await roleCan('viewer')).toEqual({
      editTask: false,
      addSection: false,
      rename: false,
      favorite: true,
      delete: false,
    });
    expect(await roleCan('commenter')).toEqual({
      editTask: false,
      addSection: false,
      rename: false,
      favorite: true,
      delete: false,
    });
    expect(await roleCan('editor')).toEqual({
      editTask: true,
      addSection: true,
      rename: false,
      favorite: true,
      delete: false,
    });
    expect(await roleCan('admin')).toEqual({
      editTask: true,
      addSection: true,
      rename: true,
      favorite: true,
      delete: false,
    });
    // Bob's favorite is his own; Alice's stays off.
    await alice.run();
    expect(alice.projects.get(p)!.isFavorite).toBe(false);
  });

  it('only assigns tasks to project members', async () => {
    expect(
      await alice.result(cmd('task_update', { id: task, assigneeId: bob.userId })),
    ).toMatchObject({ ok: false, error: 'invalid' });
    await grantProjectAccess(t.db.db, p, bob.userId, 'editor');
    await alice.ok(cmd('task_update', { id: task, assigneeId: bob.userId }));
    expect(alice.tasks.get(task)).toMatchObject({
      assigneeId: bob.userId,
      assignedById: alice.userId,
    });
  });

  it('refuses sub-projects under someone else’s project', async () => {
    await grantProjectAccess(t.db.db, p, bob.userId, 'admin');
    expect(
      await bob.result(cmd('project_add', { id: id(), name: 'x', parentId: p })),
    ).toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('consistency under concurrency', () => {
  it('a syncing client never misses a change committed by concurrent writers', async () => {
    const shared = id();
    await alice.ok(cmd('project_add', { id: shared, name: 'Shared' }));
    await grantProjectAccess(t.db.db, shared, bob.userId, 'editor');
    await bob.run();
    const observer = new SyncUser(t.app.services.sync, bob.userId);
    await observer.run();

    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      writes.push(alice.run(cmd('task_add', { id: id(), projectId: shared, content: `a${i}` })));
      writes.push(bob.run(cmd('task_add', { id: id(), projectId: shared, content: `b${i}` })));
      if (i % 3 === 0) writes.push(observer.run());
    }
    await Promise.all(writes);
    await observer.run();

    const inDb = await t.db.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.projectId, shared));
    expect(inDb).toHaveLength(60);
    expect([...observer.tasks.values()].filter((x) => x.projectId === shared)).toHaveLength(60);
  });
});
