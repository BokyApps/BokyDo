import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { grantProjectAccess } from '../sync/membership.js';

let t: TestApp;
const u: Record<string, { sync: SyncUser; http: Client; id: string }> = {};
let project: string;
let task: string;

async function user(name: string) {
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
  u[name] = { sync, http, id: userId };
}

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  for (const name of ['owner', 'admin', 'commenter', 'viewer', 'outsider']) await user(name);
  project = id();
  task = id();
  await u.owner!.sync.ok(
    cmd('project_add', { id: project, name: 'Launch' }),
    cmd('task_add', { id: task, projectId: project, content: 'Write copy' }),
  );
  await grantProjectAccess(t.db.db, project, u.admin!.id, 'admin');
  await grantProjectAccess(t.db.db, project, u.commenter!.id, 'commenter');
  await grantProjectAccess(t.db.db, project, u.viewer!.id, 'viewer');
  for (const x of Object.values(u)) await x.sync.run();
});
afterEach(async () => t.close());

const result = (who: string, c: ReturnType<typeof cmd>) => u[who]!.sync.result(c);
const outcome = async (who: string, c: ReturnType<typeof cmd>) => {
  const r = await result(who, c);
  return r?.ok ? 'ok' : (r as { error: string }).error;
};

describe.skipIf(!TEST_DATABASE_URL)('comments (roles and sync)', () => {
  it.each([
    ['owner', 'ok'],
    ['admin', 'ok'],
    ['commenter', 'ok'],
    ['viewer', 'forbidden'],
    ['outsider', 'not_found'],
  ])('%s commenting → %s', async (who, expected) => {
    expect(
      await outcome(who, cmd('comment_add', { id: id(), taskId: task, content: 'Looks good' })),
    ).toBe(expected);
  });

  it('syncs comments and reactions to members only', async () => {
    const c = id();
    await u.commenter!.sync.ok(cmd('comment_add', { id: c, taskId: task, content: '**Ship** it' }));
    await u.viewer!.sync.run();
    expect(u.viewer!.sync.comments.get(c)).toMatchObject({
      taskId: task,
      projectId: project,
      userId: u.commenter!.id,
      content: '**Ship** it',
      reactions: {},
    });
    expect(await outcome('viewer', cmd('reaction_toggle', { commentId: c, emoji: '👍' }))).toBe(
      'forbidden',
    );
    await u.admin!.sync.ok(cmd('reaction_toggle', { commentId: c, emoji: '🎉' }));
    await u.owner!.sync.ok(cmd('reaction_toggle', { commentId: c, emoji: '🎉' }));
    await u.viewer!.sync.run();
    expect(u.viewer!.sync.comments.get(c)?.reactions).toEqual({
      '🎉': expect.arrayContaining([u.admin!.id, u.owner!.id]),
    });
    await u.admin!.sync.ok(cmd('reaction_toggle', { commentId: c, emoji: '🎉' }));
    await u.viewer!.sync.run();
    expect(u.viewer!.sync.comments.get(c)?.reactions).toEqual({ '🎉': [u.owner!.id] });
    await u.outsider!.sync.run();
    expect(u.outsider!.sync.comments.size).toBe(0);
    expect(await outcome('outsider', cmd('reaction_toggle', { commentId: c, emoji: '👍' }))).toBe(
      'not_found',
    );
  });

  it('rejects reactions outside the allowed set', async () => {
    const c = id();
    await u.owner!.sync.ok(cmd('comment_add', { id: c, taskId: task, content: 'x' }));
    for (const emoji of ['🍆', 'x', '👍👍', '<script>'])
      expect(await outcome('owner', cmd('reaction_toggle', { commentId: c, emoji }))).toBe(
        'invalid',
      );
  });

  it('lets authors edit, and authors or admins delete', async () => {
    const c = id();
    await u.commenter!.sync.ok(cmd('comment_add', { id: c, taskId: task, content: 'first' }));
    expect(await outcome('admin', cmd('comment_update', { id: c, content: 'hijack' }))).toBe(
      'forbidden',
    );
    expect(await outcome('commenter', cmd('comment_update', { id: c, content: 'edited' }))).toBe(
      'ok',
    );
    expect(await outcome('viewer', cmd('comment_delete', { id: c }))).toBe('forbidden');
    expect(await outcome('admin', cmd('comment_delete', { id: c }))).toBe('ok');
    await u.viewer!.sync.run();
    expect(u.viewer!.sync.comments.has(c)).toBe(false);
    expect(u.viewer!.sync.last.removed.comments).toContain(c);
  });

  it('supports project comments, and validates the target', async () => {
    expect(
      await outcome(
        'commenter',
        cmd('comment_add', { id: id(), projectId: project, content: 'Kickoff notes' }),
      ),
    ).toBe('ok');
    expect(await outcome('owner', cmd('comment_add', { id: id(), content: 'nowhere' }))).toBe(
      'invalid',
    );
    expect(
      await outcome(
        'owner',
        cmd('comment_add', { id: id(), taskId: task, projectId: project, content: 'both' }),
      ),
    ).toBe('invalid');
    expect(
      await outcome('owner', cmd('comment_add', { id: id(), taskId: task, content: '   ' })),
    ).toBe('invalid');
  });

  it('drops comments with their task, and from removed members', async () => {
    const c = id();
    await u.owner!.sync.ok(cmd('comment_add', { id: c, taskId: task, content: 'x' }));
    await u.viewer!.sync.run();
    expect(u.viewer!.sync.comments.has(c)).toBe(true);
    await u.owner!.sync.ok(
      cmd('project_member_remove', { projectId: project, userId: u.viewer!.id }),
    );
    await u.viewer!.sync.run();
    expect(u.viewer!.sync.comments.has(c)).toBe(false);
    // A fresh full sync of a non-member includes none of it either.
    u.viewer!.sync.cursor = null;
    await u.viewer!.sync.run();
    expect(u.viewer!.sync.comments.size).toBe(0);
    await u.owner!.sync.ok(cmd('task_delete', { id: task }));
    expect(
      await outcome('owner', cmd('comment_add', { id: id(), taskId: task, content: 'late' })),
    ).toBe('not_found');
  });

  it('refuses new comments in archived projects', async () => {
    await u.owner!.sync.ok(cmd('project_archive', { id: project }));
    expect(
      await outcome('commenter', cmd('comment_add', { id: id(), taskId: task, content: 'x' })),
    ).toBe('invalid');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('activity log', () => {
  async function entries(who: string, q: string) {
    const res = await u[who]!.http.request({ method: 'GET', url: `/api/v1/activity?${q}` });
    return {
      status: res.statusCode,
      body: JSON.parse(res.body) as {
        entries: { type: string; data: Record<string, unknown>; actorId: string }[];
        users: Record<string, string>;
      },
    };
  }

  it('records what happened, readable by members only', async () => {
    await u.owner!.sync.ok(
      cmd('task_update', { id: task, content: 'Write the copy', priority: 1 }),
      cmd('comment_add', { id: id(), taskId: task, content: 'On it' }),
      cmd('task_complete', { id: task }),
    );
    await u.owner!.sync.ok(
      cmd('project_member_update', { projectId: project, userId: u.viewer!.id, role: 'commenter' }),
    );
    const { status, body } = await entries('viewer', `projectId=${project}`);
    expect(status).toBe(200);
    expect(body.entries.map((e) => e.type)).toEqual([
      'member_role_changed',
      'task_completed',
      'comment_added',
      'task_updated',
      'task_added',
    ]);
    expect(body.entries[3]!.data).toMatchObject({
      fields: ['content', 'priority'],
      from: 'Write copy',
      title: 'Write the copy',
    });
    expect(body.users[u.owner!.id]).toBe('owner');
    expect(body.users[u.viewer!.id]).toBe('viewer');
    expect((await entries('outsider', `projectId=${project}`)).status).toBe(404);
    expect((await entries('outsider', `taskId=${task}`)).body.entries).toEqual([]);
    expect((await entries('viewer', `taskId=${task}`)).body.entries).toHaveLength(4);
  });

  it('keeps every completed occurrence of a repeating task', async () => {
    const daily = id();
    await u.owner!.sync.ok(
      cmd('task_add', {
        id: daily,
        projectId: project,
        content: 'Stretch',
        due: {
          date: '2026-01-01',
          time: null,
          timezone: null,
          string: 'every day',
          recurrence: { rrule: 'FREQ=DAILY', anchor: 'scheduled' },
        },
      }),
      cmd('task_complete', { id: daily }),
      cmd('task_complete', { id: daily }),
    );
    const { body } = await entries('owner', `taskId=${daily}`);
    expect(body.entries.filter((e) => e.type === 'task_completed')).toHaveLength(2);
    expect(body.entries[1]!.data).toMatchObject({ occurrence: '2026-01-01' });
  });

  it('hides history after leaving', async () => {
    await u.viewer!.sync.ok(
      cmd('project_member_remove', { projectId: project, userId: u.viewer!.id }),
    );
    expect((await entries('viewer', `projectId=${project}`)).status).toBe(404);
    expect((await entries('viewer', `taskId=${task}`)).body.entries).toEqual([]);
    expect((await entries('owner', `projectId=${project}`)).body.entries[0]).toMatchObject({
      type: 'member_left',
    });
  });

  it('validates its query', async () => {
    expect((await entries('owner', '')).status).toBe(400);
    expect((await entries('owner', `projectId=${project}&taskId=${task}`)).status).toBe(400);
    expect((await entries('owner', `projectId=nope`)).status).toBe(400);
  });
});
