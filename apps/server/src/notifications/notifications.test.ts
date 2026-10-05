import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../db/ids.js';
import { notifications } from '../db/schema.js';
import { createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { grantProjectAccess } from '../sync/membership.js';
import { NOTIFICATIONS_PER_ACTOR_PER_HOUR } from './notify.js';

let t: TestApp;
const u: Record<string, SyncUser> = {};
let project: string;
let task: string;

beforeEach(async () => {
  if (!TEST_DATABASE_URL) return;
  t = await testApp();
  for (const name of ['ann', 'ben', 'cat', 'dan']) {
    u[name] = new SyncUser(
      t.app.services.sync,
      await createUser(t.db, { username: name, password: 'x'.repeat(12) }),
    );
    await u[name]!.run();
  }
  project = id();
  task = id();
  await u.ann!.ok(
    cmd('project_add', { id: project, name: 'Launch' }),
    cmd('task_add', { id: task, projectId: project, content: 'Write copy' }),
  );
  await grantProjectAccess(t.db.db, project, u.ben!.userId, 'editor');
  await grantProjectAccess(t.db.db, project, u.cat!.userId, 'commenter');
  for (const x of Object.values(u)) await x.run();
});
afterEach(async () => t?.close());

const inbox = async (name: string) => {
  await u[name]!.run();
  return u[name]!.last;
};
const types = async (name: string) => (await inbox(name)).notifications.map((n) => n.type);

describe.skipIf(!TEST_DATABASE_URL)('notifications', () => {
  it('tells people when a task is assigned to them, but not when they assign themselves', async () => {
    await u.ann!.ok(cmd('task_update', { id: task, assigneeId: u.ben!.userId }));
    const ben = await inbox('ben');
    expect(ben.unreadNotifications).toBe(1);
    expect(ben.notifications[0]).toMatchObject({
      type: 'assigned',
      actorId: u.ann!.userId,
      taskId: task,
      projectId: project,
      read: false,
      data: { title: 'Write copy' },
    });
    await u.ann!.ok(cmd('task_update', { id: task, assigneeId: u.ann!.userId }));
    expect(await types('ann')).toEqual([]);
  });

  it('notifies @mentioned members (only members, capped) and the task’s followers', async () => {
    await u.ann!.ok(cmd('task_update', { id: task, assigneeId: u.ben!.userId }));
    await u.cat!.ok(cmd('comment_add', { id: id(), taskId: task, content: 'First thoughts' }));
    await u.ann!.ok(
      cmd('comment_add', {
        id: id(),
        taskId: task,
        content: 'Hey @CAT, and @dan (not a member) and@ben?',
      }),
    );
    expect(await types('cat')).toEqual(['mentioned']);
    // Ben follows the task as its assignee (the "and@ben" isn't a mention).
    expect(await types('ben')).toEqual(['commented', 'commented', 'assigned']);
    expect(await types('dan')).toEqual([]);
    expect(await types('ann')).toEqual(['commented']);
  });

  it('tells people about changes to their access, without leaking removed projects', async () => {
    await u.ann!.ok(cmd('task_update', { id: task, assigneeId: u.cat!.userId }));
    await u.ann!.ok(
      cmd('project_member_update', { projectId: project, userId: u.cat!.userId, role: 'viewer' }),
    );
    expect(await types('cat')).toEqual(['role_changed', 'assigned']);
    await u.ann!.ok(cmd('project_member_remove', { projectId: project, userId: u.cat!.userId }));
    const cat = await inbox('cat');
    // Only the removal is left: the others point into a project Cat can no longer see.
    expect(cat.notifications).toEqual([
      expect.objectContaining({
        type: 'removed_from_project',
        projectId: null,
        data: { projectName: 'Launch' },
      }),
    ]);
    expect(cat.unreadNotifications).toBe(1);
    await u.ann!.ok(cmd('project_transfer', { projectId: project, userId: u.ben!.userId }));
    expect((await types('ben'))[0]).toBe('became_owner');
  });

  it('marks only your own notifications read', async () => {
    await u.ann!.ok(cmd('task_update', { id: task, assigneeId: u.ben!.userId }));
    const [n] = (await inbox('ben')).notifications;
    await u.cat!.ok(cmd('notifications_mark_read', { ids: [n!.id] }));
    expect((await inbox('ben')).unreadNotifications).toBe(1);
    await u.ben!.ok(cmd('notifications_mark_read', { ids: [n!.id] }));
    expect((await inbox('ben')).notifications[0]?.read).toBe(true);
    await u.ann!.ok(cmd('comment_add', { id: id(), taskId: task, content: '@ben @ben' }));
    expect((await inbox('ben')).unreadNotifications).toBe(1);
    await u.ben!.ok(cmd('notifications_mark_read', { all: true }));
    expect((await inbox('ben')).unreadNotifications).toBe(0);
  });

  it('caps how many notifications one person can cause per hour', async () => {
    await t.db.db.insert(notifications).values(
      Array.from({ length: NOTIFICATIONS_PER_ACTOR_PER_HOUR }, () => ({
        id: newId(),
        userId: u.dan!.userId,
        type: 'mentioned',
        actorId: u.ann!.userId,
      })),
    );
    await u.ann!.ok(cmd('task_update', { id: task, assigneeId: u.ben!.userId }));
    expect(await types('ben')).toEqual([]);
  });
});
