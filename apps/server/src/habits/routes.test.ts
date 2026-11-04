import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { habitCheckIns } from '../db/schema.js';
import { cmd, id as newId, SyncUser } from '../test/sync.js';
import { TEST_DATABASE_URL } from '../test/db.js';

let t: TestApp;
type Person = { id: string; http: Client };

async function person(username: string): Promise<Person> {
  const id = await createUser(t.db, { username, password: 'x'.repeat(12) });
  const http = new Client(t.app);
  const { token, session } = await t.app.services.sessions.create(
    { id, username, isAdmin: false, mustChangePassword: false },
    { ip: null, userAgent: null, authMethod: 'password' },
  );
  http.cookies.set('bokydo_session', token);
  http.csrfToken = session.csrfToken;
  return { id, http };
}

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('habits API', () => {
  it('never derives habit progress from normal task completions', async () => {
    const alice = await person('alice');
    await alice.http.post('/api/v1/habits', { name: 'Read', period: 'day', target: 1 });
    const sync = new SyncUser(t.app.services.sync, alice.id);
    const projectId = newId();
    const taskId = newId();
    await sync.ok(
      cmd('project_add', { id: projectId, name: 'Work' }),
      cmd('task_add', { id: taskId, projectId, content: 'Normal task' }),
      cmd('task_complete', { id: taskId }),
    );
    const response = (await alice.http.get('/api/v1/habits')).json();
    expect(response.habits[0].progress.completed).toBe(0);
    expect(response.habits[0].streak.current).toBe(0);
    expect(response.habits[0].history.every((day: { completed: boolean }) => !day.completed)).toBe(
      true,
    );
    expect((await alice.http.get('/api/v1/productivity')).statusCode).toBe(404);
  });

  it('creates a habit, returns stable-ID retries idempotently, and lists an empty history', async () => {
    const alice = await person('alice');
    const id = randomUUID();
    const payload = { id, name: 'Read', period: 'day', target: 1 };
    const created = await alice.http.post('/api/v1/habits', payload);
    expect(created.statusCode).toBe(201);
    expect(created.json().habit).toMatchObject({ id, name: 'Read', period: 'day', target: 1 });
    expect((await alice.http.post('/api/v1/habits', payload)).statusCode).toBe(200);
    const listed = await alice.http.get('/api/v1/habits');
    expect(listed.json().habits).toHaveLength(1);
    expect(listed.json().habits[0].history).toHaveLength(14);
    expect(listed.json().today).toBe(listed.json().habits[0].history[13].date);
  });

  it('refuses a conflicting stable ID and does not disclose another owner’s habit', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const id = randomUUID();
    await alice.http.post('/api/v1/habits', { id, name: 'Read', period: 'day', target: 1 });
    expect(
      (await alice.http.post('/api/v1/habits', { id, name: 'Walk', period: 'day', target: 1 }))
        .statusCode,
    ).toBe(409);
    expect((await bob.http.get(`/api/v1/habits`)).json().habits).toEqual([]);
    expect(
      (await bob.http.put(`/api/v1/habits/${id}/check-ins/2026-11-04`, { completed: true }))
        .statusCode,
    ).toBe(404);
    expect((await bob.http.patch(`/api/v1/habits/${id}`, { name: 'Changed' })).statusCode).toBe(
      404,
    );
  });

  it('makes check-in set operations idempotent and allows clearing them', async () => {
    const alice = await person('alice');
    const id = randomUUID();
    await alice.http.post('/api/v1/habits', { id, name: 'Read', period: 'day', target: 1 });
    const today = (await alice.http.get('/api/v1/habits')).json().today as string;
    const url = `/api/v1/habits/${id}/check-ins/${today}`;
    expect((await alice.http.put(url, { completed: true })).json().habit.todayCompleted).toBe(true);
    expect(
      (await alice.http.put(url, { completed: true })).json().habit.history[13].completed,
    ).toBe(true);
    expect((await alice.http.put(url, { completed: false })).json().habit.todayCompleted).toBe(
      false,
    );
  });

  it('validates targets, malformed dates, and future check-ins', async () => {
    const alice = await person('alice');
    const id = randomUUID();
    expect(
      (await alice.http.post('/api/v1/habits', { name: 'Bad', period: 'day', target: 2 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await alice.http.post('/api/v1/habits', { name: 'Bad', period: 'week', target: 8 }))
        .statusCode,
    ).toBe(400);
    await alice.http.post('/api/v1/habits', { id, name: 'Read', period: 'week', target: 2 });
    expect(
      (await alice.http.put(`/api/v1/habits/${id}/check-ins/2025-02-29`, { completed: true }))
        .statusCode,
    ).toBe(400);
    const today = (await alice.http.get('/api/v1/habits')).json().today as string;
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const future = tomorrow.toISOString().slice(0, 10);
    expect(
      (await alice.http.put(`/api/v1/habits/${id}/check-ins/${future}`, { completed: true }))
        .statusCode,
    ).toBe(400);
  });

  it('validates a patched merged period/target pair and deletes check-ins with the habit', async () => {
    const alice = await person('alice');
    const id = randomUUID();
    await alice.http.post('/api/v1/habits', { id, name: 'Read', period: 'day', target: 1 });
    expect(
      (await alice.http.patch(`/api/v1/habits/${id}`, { period: 'week', target: 2 })).statusCode,
    ).toBe(200);
    expect((await alice.http.patch(`/api/v1/habits/${id}`, { period: 'day' })).statusCode).toBe(
      400,
    );
    expect(
      (await alice.http.patch(`/api/v1/habits/${id}`, { period: 'day', target: 1 })).statusCode,
    ).toBe(200);
    const today = (await alice.http.get('/api/v1/habits')).json().today as string;
    await alice.http.put(`/api/v1/habits/${id}/check-ins/${today}`, { completed: true });
    expect((await alice.http.delete(`/api/v1/habits/${id}`)).statusCode).toBe(204);
    expect((await alice.http.get('/api/v1/habits')).json().habits).toEqual([]);
    expect(await t.db.db.select().from(habitCheckIns)).toEqual([]);
  });
});
