import { addDays, localNow } from '@bokydo/nlp';
import type { Due } from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../db/schema.js';
import { createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { grantProjectAccess } from './membership.js';

let t: TestApp;
let alice: SyncUser;
let bob: SyncUser;

beforeEach(async () => {
  t = await testApp();
  alice = new SyncUser(
    t.app.services.sync,
    await createUser(t.db, { username: 'alice', password: 'x'.repeat(12) }),
  );
  bob = new SyncUser(
    t.app.services.sync,
    await createUser(t.db, { username: 'bob', password: 'x'.repeat(12) }),
  );
  await alice.run();
  await bob.run();
});
afterEach(async () => t.close());

const due = (
  date: string,
  rrule: string,
  anchor: 'scheduled' | 'completion' = 'scheduled',
): Due => ({
  date,
  time: null,
  timezone: null,
  string: 'every …',
  recurrence: { rrule, anchor },
});

describe.skipIf(!TEST_DATABASE_URL)('recurring tasks', () => {
  it('move to the next occurrence and stay open; sub-tasks reopen', async () => {
    const [task, sub] = [id(), id()];
    await alice.ok(
      cmd('task_add', {
        id: task,
        content: 'Pay rent',
        due: due('2026-01-01', 'FREQ=MONTHLY;BYMONTHDAY=1'),
      }),
      cmd('task_add', { id: sub, parentId: task, content: 'Transfer' }),
      cmd('task_complete', { id: sub }),
    );
    expect(alice.tasks.get(sub)!.isCompleted).toBe(true);

    await alice.ok(cmd('task_complete', { id: task }));
    const today = localNow('UTC').date;
    const rolled = alice.tasks.get(task)!;
    expect(rolled.isCompleted).toBe(false);
    expect(rolled.due).toMatchObject({
      string: 'every …',
      recurrence: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' },
    });
    expect(rolled.due!.date.endsWith('-01')).toBe(true);
    expect(rolled.due!.date >= today).toBe(true);
    expect(alice.tasks.get(sub)!.isCompleted).toBe(false);

    // The indexed due_date column follows, so Today/Upcoming queries see the new date.
    const [row] = await t.db.db.select().from(tasks).where(eq(tasks.id, task));
    expect(row!.dueDate).toBe(rolled.due!.date);
  });

  it('complete for good once the series has ended', async () => {
    const task = id();
    await alice.ok(
      cmd('task_add', {
        id: task,
        content: 'Course',
        due: due('2026-01-05', 'FREQ=DAILY;UNTIL=20260106'),
      }),
      cmd('task_complete', { id: task }),
    );
    expect(alice.tasks.get(task)!.isCompleted).toBe(true);
  });

  it("count every! from today in the completing user's time zone", async () => {
    // UTC+14 and UTC-11 are on different calendar days for most of every day.
    for (const [user, zone] of [
      [alice, 'Pacific/Kiritimati'],
      [bob, 'Pacific/Pago_Pago'],
    ] as const) {
      const task = id();
      await user.ok(
        cmd('user_update_preferences', { timezone: zone }),
        cmd('task_add', {
          id: task,
          content: 'Water plants',
          due: due('2020-01-01', 'FREQ=DAILY;INTERVAL=3', 'completion'),
        }),
      );
      const before = localNow(zone).date;
      await user.ok(cmd('task_complete', { id: task }));
      const after = localNow(zone).date;
      expect([addDays(before, 3), addDays(after, 3)]).toContain(user.tasks.get(task)!.due!.date);
    }
  });

  it('fall back to the instance time zone', async () => {
    await t.app.services.settings.update(
      { 'instance.defaultTimezone': 'Pacific/Kiritimati' },
      { userId: null, ip: null },
    );
    const task = id();
    await alice.ok(
      cmd('task_add', {
        id: task,
        content: 'x',
        due: due('2020-01-01', 'FREQ=DAILY', 'completion'),
      }),
    );
    const before = localNow('Pacific/Kiritimati').date;
    await alice.ok(cmd('task_complete', { id: task }));
    expect([addDays(before, 1), addDays(localNow('Pacific/Kiritimati').date, 1)]).toContain(
      alice.tasks.get(task)!.due!.date,
    );
  });

  it('reject rules outside the supported subset', async () => {
    for (const rrule of [
      'FREQ=SECONDLY',
      'FREQ=DAILY;COUNT=3',
      'FREQ=WEEKLY;BYDAY=2MO',
      'FREQ=DAILY;INTERVAL=0',
    ]) {
      const result = await alice.result(
        cmd('task_add', { id: id(), content: 'x', due: due('2026-01-01', rrule) }),
      );
      expect(result, rrule).toMatchObject({ ok: false, error: 'invalid' });
    }
  });

  it('need edit rights, like any completion', async () => {
    const project = id();
    const task = id();
    await alice.ok(
      cmd('project_add', { id: project, name: 'Shared' }),
      cmd('task_add', {
        id: task,
        projectId: project,
        content: 'x',
        due: due('2026-01-01', 'FREQ=DAILY'),
      }),
    );
    await grantProjectAccess(t.db.db, project, bob.userId, 'viewer');
    await bob.run();
    expect(await bob.result(cmd('task_complete', { id: task }))).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    await alice.run();
    expect(alice.tasks.get(task)!.due!.date).toBe('2026-01-01');
  });
});
