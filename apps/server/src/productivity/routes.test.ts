import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

let t: TestApp;

type Person = { sync: SyncUser; http: Client };

async function person(username: string): Promise<Person> {
  const userId = await createUser(t.db, { username, password: 'x'.repeat(12) });
  const http = new Client(t.app);
  const { token, session } = await t.app.services.sessions.create(
    { id: userId, username, isAdmin: false, mustChangePassword: false },
    { ip: null, userAgent: null, authMethod: 'password' },
  );
  http.cookies.set('bokydo_session', token);
  http.csrfToken = session.csrfToken;
  const sync = new SyncUser(t.app.services.sync, userId);
  await sync.run();
  return { sync, http };
}

async function summary(who: Person) {
  const res = await who.http.get('/api/v1/productivity');
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** Add and immediately complete `count` tasks at `priority`. */
async function complete(who: Person, priority: number, count = 1) {
  for (let i = 0; i < count; i++) {
    const taskId = id();
    await who.sync.ok(cmd('task_add', { id: taskId, content: `task ${i}`, priority }));
    await who.sync.ok(cmd('task_complete', { id: taskId }));
  }
}

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
});

afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('productivity summary', () => {
  it('starts empty on the default goals', async () => {
    const pat = await person('pat');
    const s = await summary(pat);
    expect(s.karma).toBe(0);
    expect(s.level.name).toBe('Novice');
    expect(s.today).toMatchObject({ completed: 0, goal: 5, met: false });
    expect(s.streak.current).toBe(0);
    expect(s.days).toHaveLength(14);
  });

  it('scores by priority and only from what the person completed', async () => {
    const pat = await person('pat');
    const sam = await person('sam');
    await complete(pat, 1); // 5 points
    await complete(pat, 4); // 1 point
    await complete(sam, 1, 3); // must not appear in pat's numbers

    const s = await summary(pat);
    expect(s.karma).toBe(6);
    expect(s.today.completed).toBe(2);
    expect(s.week.completed).toBe(2);

    expect((await summary(sam)).karma).toBe(15);
  });

  it('uses the goals from preferences and marks the day met', async () => {
    const pat = await person('pat');
    await complete(pat, 4, 2);
    await pat.sync.ok(cmd('user_update_preferences', { productivity: { dailyGoal: 2 } }));

    const s = await summary(pat);
    expect(s.today).toMatchObject({ completed: 2, goal: 2, met: true });
    expect(s.streak.current).toBe(1);
  });

  it('accepts one goal at a time without clearing the others', async () => {
    const pat = await person('pat');
    await pat.sync.ok(cmd('user_update_preferences', { productivity: { dailyGoal: 3 } }));
    await pat.sync.ok(cmd('user_update_preferences', { productivity: { weeklyGoal: 9 } }));

    const s = await summary(pat);
    expect(s.today.goal).toBe(3);
    expect(s.week.goal).toBe(9);
  });

  it('freezes the goals while on vacation', async () => {
    const pat = await person('pat');
    // Use the date the server itself considers today, which depends on the zone it resolves.
    const today = (await summary(pat)).today.date;
    await pat.sync.ok(
      cmd('user_update_preferences', {
        productivity: { vacationFrom: today, vacationUntil: today },
      }),
    );

    const s = await summary(pat);
    expect(s.vacation).toMatchObject({ from: today, until: today, active: true });
    expect(s.today).toMatchObject({ completed: 0, met: true, vacation: true });
  });

  it('clears a vacation date again', async () => {
    const pat = await person('pat');
    const today = (await summary(pat)).today.date;
    await pat.sync.ok(
      cmd('user_update_preferences', {
        productivity: { vacationFrom: today, vacationUntil: today },
      }),
    );
    await pat.sync.ok(
      cmd('user_update_preferences', {
        productivity: { vacationFrom: null, vacationUntil: null },
      }),
    );

    const s = await summary(pat);
    expect(s.vacation.active).toBe(false);
    expect(s.today.met).toBe(false);
  });
});
