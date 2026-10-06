import type { Due } from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifications, reminders } from '../db/schema.js';
import { createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { grantProjectAccess } from '../sync/membership.js';

let t: TestApp;
let alice: SyncUser;
let bob: SyncUser;
let project: string;

const due = (date: string, time: string | null, extra: Partial<Due> = {}): Due => ({
  date,
  time,
  timezone: null,
  string: date,
  recurrence: null,
  ...extra,
});

async function user(name: string, timezone: string | null, autoReminder: number | null = null) {
  const userId = await createUser(t.db, { username: name, password: 'x'.repeat(12) });
  const s = new SyncUser(t.app.services.sync, userId);
  await s.ok(cmd('user_update_preferences', { timezone, notifications: { autoReminder } }));
  return s;
}

const fireAt = async (reminderId: string) =>
  (await t.db.db.select().from(reminders).where(eq(reminders.id, reminderId)))[0]?.fireAt ?? null;
const reminderNotes = async (userId: string) =>
  (await t.db.db.select().from(notifications).where(eq(notifications.userId, userId))).filter(
    (n) => n.type === 'reminder',
  );
const tick = (iso: string) => t.app.services.jobs.tick(new Date(iso));

beforeEach(async () => {
  t = await testApp();
  alice = await user('alice', 'Asia/Phnom_Penh'); // UTC+7
  bob = await user('bob', 'America/New_York');
  project = id();
  await alice.ok(cmd('project_add', { id: project, name: 'Trip' }));
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('reminders: commands and sync', () => {
  it('needs a due time for relative reminders', async () => {
    const task = id();
    await alice.ok(
      cmd('task_add', {
        id: task,
        projectId: project,
        content: 'Pack',
        due: due('2030-01-15', null),
      }),
    );
    const r = await alice.result(
      cmd('reminder_add', { id: id(), taskId: task, type: 'relative', minutesBefore: 30 }),
    );
    expect(r).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('computes fire times in the right zone and follows due changes', async () => {
    const task = id();
    const rel = id();
    const abs = id();
    await alice.ok(
      cmd('task_add', {
        id: task,
        projectId: project,
        content: 'Fly',
        due: due('2030-01-15', '09:00'),
      }),
      cmd('reminder_add', { id: rel, taskId: task, type: 'relative', minutesBefore: 30 }),
      cmd('reminder_add', {
        id: abs,
        taskId: task,
        type: 'absolute',
        date: '2030-01-14',
        time: '20:00',
      }),
    );
    // Floating 09:00 in Phnom Penh (UTC+7), 30 minutes early.
    expect((await fireAt(rel))?.toISOString()).toBe('2030-01-15T01:30:00.000Z');
    expect((await fireAt(abs))?.toISOString()).toBe('2030-01-14T13:00:00.000Z');
    expect(alice.reminders.get(abs)).toMatchObject({ timeZone: 'Asia/Phnom_Penh', isAuto: false });

    await alice.ok(
      cmd('task_update', {
        id: task,
        due: due('2030-01-16', '10:00', { timezone: 'Europe/Berlin' }),
      }),
    );
    expect((await fireAt(rel))?.toISOString()).toBe('2030-01-16T08:30:00.000Z');
    expect((await fireAt(abs))?.toISOString()).toBe('2030-01-14T13:00:00.000Z');
    await alice.ok(cmd('task_update', { id: task, due: due('2030-01-16', null) }));
    expect(await fireAt(rel)).toBeNull();
  });

  it('moves floating reminders when the owner changes time zone', async () => {
    const task = id();
    const rel = id();
    await alice.ok(
      cmd('task_add', {
        id: task,
        projectId: project,
        content: 'Call',
        due: due('2030-01-15', '09:00'),
      }),
      cmd('reminder_add', { id: rel, taskId: task, type: 'relative', minutesBefore: 0 }),
    );
    await alice.ok(cmd('user_update_preferences', { timezone: 'UTC' }));
    expect((await fireAt(rel))?.toISOString()).toBe('2030-01-15T09:00:00.000Z');
  });

  it('keeps reminders private to their owner', async () => {
    const task = id();
    const rem = id();
    await grantProjectAccess(t.db.db, project, bob.userId, 'viewer');
    await alice.ok(
      cmd('task_add', {
        id: task,
        projectId: project,
        content: 'Visa',
        due: due('2030-01-15', '09:00'),
      }),
      cmd('reminder_add', { id: rem, taskId: task, type: 'relative', minutesBefore: 10 }),
    );
    await bob.run();
    expect(bob.reminders.size).toBe(0);
    // A viewer can remind themselves, but can't touch someone else's reminder.
    await bob.ok(
      cmd('reminder_add', { id: id(), taskId: task, type: 'relative', minutesBefore: 5 }),
    );
    expect(await bob.result(cmd('reminder_delete', { id: rem }))).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    await alice.run();
    expect([...alice.reminders.keys()]).toEqual([rem]);
    // Strangers can't add reminders to tasks they can't see.
    const eve = await user('eve', null);
    expect(
      await eve.result(
        cmd('reminder_add', { id: id(), taskId: task, type: 'relative', minutesBefore: 5 }),
      ),
    ).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('removes deleted reminders from sync and caps reminders per task', async () => {
    const task = id();
    await alice.ok(
      cmd('task_add', {
        id: task,
        projectId: project,
        content: 'X',
        due: due('2030-01-15', '09:00'),
      }),
    );
    const ids = Array.from({ length: 20 }, () => id());
    await alice.ok(
      ...ids.map((r, i) =>
        cmd('reminder_add', { id: r, taskId: task, type: 'relative', minutesBefore: i }),
      ),
    );
    expect(
      await alice.result(
        cmd('reminder_add', { id: id(), taskId: task, type: 'relative', minutesBefore: 99 }),
      ),
    ).toMatchObject({ ok: false, error: 'limit_exceeded' });
    await alice.ok(cmd('reminder_delete', { id: ids[0]! }));
    expect(alice.reminders.has(ids[0]!)).toBe(false);
    expect(alice.reminders.size).toBe(19);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('reminders: automatic', () => {
  it('reminds the creator of timed tasks, follows the assignee and stays deleted', async () => {
    const carol = await user('carol', 'UTC', 15);
    await grantProjectAccess(t.db.db, project, carol.userId, 'editor');
    const p2 = id();
    const task = id();
    await carol.ok(cmd('project_add', { id: p2, name: 'Carol' }));
    await carol.ok(
      cmd('task_add', { id: task, projectId: p2, content: 'Gym', due: due('2030-01-15', '18:00') }),
    );
    const [auto] = [...carol.reminders.values()];
    expect(auto).toMatchObject({ isAuto: true, minutesBefore: 15, taskId: task });
    expect((await fireAt(auto!.id))?.toISOString()).toBe('2030-01-15T17:45:00.000Z');

    // Untimed tasks get none; deleting the automatic one keeps it gone after edits.
    await carol.ok(
      cmd('task_add', {
        id: id(),
        projectId: p2,
        content: 'Someday',
        due: due('2030-01-15', null),
      }),
    );
    expect(carol.reminders.size).toBe(1);
    await carol.ok(cmd('reminder_delete', { id: auto!.id }));
    await carol.ok(cmd('task_update', { id: task, due: due('2030-01-16', '18:00') }));
    expect(carol.reminders.size).toBe(0);
  });

  it('moves to the assignee, and is skipped for people who set their own', async () => {
    const carol = await user('carol', 'UTC', 0);
    await grantProjectAccess(t.db.db, project, carol.userId, 'editor');
    await alice.ok(cmd('user_update_preferences', { notifications: { autoReminder: 0 } }));
    const task = id();
    await alice.ok(
      cmd('task_add', {
        id: task,
        projectId: project,
        content: 'Book',
        due: due('2030-01-15', '09:00'),
      }),
    );
    expect([...alice.reminders.values()].map((r) => r.isAuto)).toEqual([true]);
    await alice.ok(cmd('task_update', { id: task, assigneeId: carol.userId }));
    await carol.run();
    expect(alice.reminders.size).toBe(0);
    expect([...carol.reminders.values()].map((r) => r.isAuto)).toEqual([true]);

    const own = id();
    await alice.ok(
      cmd('task_add', {
        id: own,
        projectId: project,
        content: 'Mine',
        due: due('2030-01-15', null),
      }),
      cmd('reminder_add', {
        id: id(),
        taskId: own,
        type: 'absolute',
        date: '2030-01-15',
        time: '08:00',
      }),
      cmd('task_update', { id: own, due: due('2030-01-15', '09:00') }),
    );
    expect(
      [...alice.reminders.values()].filter((r) => r.taskId === own).map((r) => r.isAuto),
    ).toEqual([false]);
  });

  it('turns automatic reminders off and back on with the preference', async () => {
    await alice.ok(cmd('user_update_preferences', { notifications: { autoReminder: 10 } }));
    const task = id();
    await alice.ok(
      cmd('task_add', {
        id: task,
        projectId: project,
        content: 'Run',
        due: due('2030-01-15', '07:00'),
      }),
    );
    expect(alice.reminders.size).toBe(1);
    await alice.ok(cmd('user_update_preferences', { notifications: { autoReminder: null } }));
    expect(alice.reminders.size).toBe(0);
    await alice.ok(cmd('user_update_preferences', { notifications: { autoReminder: 60 } }));
    expect([...alice.reminders.values()].map((r) => r.minutesBefore)).toEqual([60]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('reminders: delivery', () => {
  it('fires once, at its time', async () => {
    const task = id();
    await alice.ok(
      cmd('task_add', {
        id: task,
        projectId: project,
        content: 'Leave for airport',
        due: due('2030-01-15', '09:00'),
      }),
      cmd('reminder_add', { id: id(), taskId: task, type: 'relative', minutesBefore: 30 }),
    );
    await tick('2030-01-15T01:29:00Z');
    expect(await reminderNotes(alice.userId)).toHaveLength(0);
    await tick('2030-01-15T01:30:05Z');
    await tick('2030-01-15T01:31:00Z');
    const notes = await reminderNotes(alice.userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ taskId: task, projectId: project, actorId: null });
    expect(notes[0]!.data).toMatchObject({ title: 'Leave for airport' });
    await alice.run();
    expect(alice.last.notifications[0]?.type).toBe('reminder');
  });

  it('fires again for the next occurrence of a recurring task', async () => {
    const task = id();
    const recurring = due('2030-01-15', '09:00', {
      string: 'every day',
      recurrence: { rrule: 'FREQ=DAILY', anchor: 'scheduled' },
    });
    await alice.ok(
      cmd('task_add', { id: task, projectId: project, content: 'Pills', due: recurring }),
      cmd('reminder_add', { id: id(), taskId: task, type: 'relative', minutesBefore: 0 }),
    );
    await tick('2030-01-15T02:00:00Z');
    await alice.ok(cmd('task_complete', { id: task }));
    await tick('2030-01-15T03:00:00Z');
    expect(await reminderNotes(alice.userId)).toHaveLength(1);
    await tick('2030-01-16T02:00:30Z');
    expect(await reminderNotes(alice.userId)).toHaveLength(2);
  });

  it('skips completed tasks, lost access and reminders missed by more than 12 hours', async () => {
    const done = id();
    const shared = id();
    const old = id();
    const late = id();
    await grantProjectAccess(t.db.db, project, bob.userId, 'editor');
    await alice.ok(
      cmd('task_add', {
        id: done,
        projectId: project,
        content: 'Done',
        due: due('2030-01-15', '09:00'),
      }),
      cmd('task_add', {
        id: shared,
        projectId: project,
        content: 'Shared',
        // Fixed to Phnom Penh so it's due for Bob (New York) at the same moment.
        due: due('2030-01-15', '09:00', { timezone: 'Asia/Phnom_Penh' }),
      }),
      cmd('task_add', {
        id: old,
        projectId: project,
        content: 'Old',
        due: due('2030-01-14', '09:00'),
      }),
      cmd('task_add', {
        id: late,
        projectId: project,
        content: 'Late',
        due: due('2030-01-15', '06:00'),
      }),
      cmd('reminder_add', { id: id(), taskId: done, type: 'relative', minutesBefore: 0 }),
      cmd('reminder_add', { id: id(), taskId: old, type: 'relative', minutesBefore: 0 }),
      cmd('reminder_add', { id: id(), taskId: late, type: 'relative', minutesBefore: 0 }),
      cmd('task_complete', { id: done }),
    );
    await bob.ok(
      cmd('reminder_add', { id: id(), taskId: shared, type: 'relative', minutesBefore: 0 }),
    );
    await alice.ok(cmd('project_member_remove', { projectId: project, userId: bob.userId }));
    // "Now" is 10:00 in Phnom Penh: Old is a day late, Late is 4 hours late.
    await tick('2030-01-15T03:00:00Z');
    const notes = await reminderNotes(alice.userId);
    expect(notes.map((n) => (n.data as { title: string }).title)).toEqual(['Late']);
    expect(notes[0]!.data).toMatchObject({ late: true });
    expect(await reminderNotes(bob.userId)).toHaveLength(0);
  });
});
