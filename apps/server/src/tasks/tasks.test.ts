import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { grantProjectAccess } from '../sync/membership.js';
import { toPrefixQuery } from './routes.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
let t: TestApp;
let alice: SyncUser;
let bob: SyncUser;
let aliceHttp: Client;
let bobHttp: Client;

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  alice = new SyncUser(
    t.app.services.sync,
    await createUser(t.db, { username: 'alice', password: PASSWORD }),
  );
  bob = new SyncUser(
    t.app.services.sync,
    await createUser(t.db, { username: 'bob', password: PASSWORD }),
  );
  await alice.run();
  await bob.run();
  aliceHttp = new Client(t.app);
  bobHttp = new Client(t.app);
  await aliceHttp.login('alice', PASSWORD);
  await bobHttp.login('bob', PASSWORD);
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('completed tasks', () => {
  it('pages through the user’s own completed tasks, newest first', async () => {
    const ids = Array.from({ length: 5 }, () => id());
    for (const [i, task] of ids.entries()) {
      await alice.ok(
        cmd('task_add', { id: task, content: `done ${i}` }),
        cmd('task_complete', { id: task }),
      );
    }
    const first = (await aliceHttp.get('/api/v1/tasks/completed?limit=3')).json();
    expect(first.tasks.map((x: { content: string }) => x.content)).toEqual([
      'done 4',
      'done 3',
      'done 2',
    ]);
    const second = (
      await aliceHttp.get(
        `/api/v1/tasks/completed?limit=3&before=${encodeURIComponent(first.nextBefore)}`,
      )
    ).json();
    expect(second.tasks.map((x: { content: string }) => x.content)).toEqual(['done 1', 'done 0']);
    expect(second.nextBefore).toBeNull();
  });

  it('never returns another user’s tasks, even when asked for their project', async () => {
    const task = id();
    await alice.ok(
      cmd('task_add', { id: task, content: 'Secret done' }),
      cmd('task_complete', { id: task }),
    );
    const asBob = await bobHttp.get(`/api/v1/tasks/completed?projectId=${alice.inbox}`);
    expect(asBob.json()).toEqual({ tasks: [], nextBefore: null });
    expect((await bobHttp.get('/api/v1/tasks/completed')).body).not.toContain('Secret');
  });

  it('rejects unknown parameters', async () => {
    expect((await aliceHttp.get('/api/v1/tasks/completed?limit=1000')).statusCode).toBe(400);
    expect((await aliceHttp.get('/api/v1/tasks/completed?userId=x')).statusCode).toBe(400);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('search', () => {
  beforeEach(async () => {
    const done = id();
    await alice.ok(
      cmd('task_add', {
        id: id(),
        content: 'Book flights to Lisbon',
        description: 'compare TAP and easyJet',
      }),
      cmd('task_add', { id: done, content: 'Renew passport' }),
      cmd('task_complete', { id: done }),
    );
    await bob.ok(cmd('task_add', { id: id(), content: 'Bob private Lisbon plans' }));
  });

  const search = (c: Client, q: string) => c.get(`/api/v1/search?q=${encodeURIComponent(q)}`);

  it('finds by prefix in titles and descriptions, including completed tasks', async () => {
    expect(
      (await search(aliceHttp, 'lisb')).json().tasks.map((x: { content: string }) => x.content),
    ).toEqual(['Book flights to Lisbon']);
    expect((await search(aliceHttp, 'easyjet')).json().tasks).toHaveLength(1);
    expect((await search(aliceHttp, 'passport')).json().tasks[0]).toMatchObject({
      isCompleted: true,
    });
  });

  it('only searches projects the user can see', async () => {
    expect((await search(aliceHttp, 'lisbon')).body).not.toContain('Bob private');
    const shared = id();
    await bob.ok(
      cmd('project_add', { id: shared, name: 'Trip' }),
      cmd('task_add', { id: id(), projectId: shared, content: 'Shared Lisbon hotel' }),
    );
    await grantProjectAccess(t.db.db, shared, alice.userId, 'viewer');
    expect(
      (await search(aliceHttp, 'lisbon'))
        .json()
        .tasks.map((x: { content: string }) => x.content)
        .sort(),
    ).toEqual(['Book flights to Lisbon', 'Shared Lisbon hotel']);
  });

  it('treats tsquery syntax and SQL as plain text', async () => {
    for (const q of [
      "lisbon' OR 1=1 --",
      'lisbon | bob',
      '!lisbon',
      'lisbon:*B',
      '(lisbon',
      '<-> lisbon',
      '\\',
      ':::',
      "'; drop table tasks; --",
    ]) {
      const res = await search(aliceHttp, q);
      expect(res.statusCode, q).toBe(200);
      expect(res.body, q).not.toContain('Bob private');
    }
    expect(toPrefixQuery("a' | b & !c")).toBe('a:* & b:* & c:*');
    expect(toPrefixQuery('!!!')).toBeNull();
  });
});
