import type { ApiScope } from '@bokydo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../db/ids.js';
import { habits, oauthClients, oauthGrants } from '../db/schema.js';
import { createUser, TEST_HOST, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

const BASE = 'https://tasks.example.com';
let t: TestApp;
let alice: string;
let bob: string;
let limitedProject: string;
let seq = 0;

async function token(userId: string, scopes: ApiScope[], projectIds: string[] | null = null) {
  return (
    await t.app.services.apiTokens.createPat(userId, {
      name: 'habit-test',
      scopes,
      projectIds,
      expiresInDays: 1,
    })
  ).token;
}

async function oauthToken(userId: string, scopes: ApiScope[]) {
  const clientId = `bkdc_${'b'.repeat(22)}`;
  await t.db.db
    .insert(oauthClients)
    .values({
      id: clientId,
      name: 'habit client',
      redirectUris: ['https://client.example/callback'],
      registeredVia: 'dynamic',
    })
    .onConflictDoNothing();
  const grantId = newId();
  await t.db.db
    .insert(oauthGrants)
    .values({ id: grantId, clientId, userId, scopes, audience: 'mcp' });
  const issued = await t.db.db.transaction((tx) =>
    t.app.services.apiTokens.issue(tx, { id: grantId, userId, scopes, audience: 'mcp' }),
  );
  return issued.access_token;
}

async function rpc(bearer: string, method: string, params: Record<string, unknown> = {}) {
  return t.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      host: TEST_HOST,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    payload: { jsonrpc: '2.0', id: ++seq, method, params },
  });
}

async function call(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(bearer, 'tools/call', { name, arguments: args });
  expect(response.statusCode).toBe(200);
  return response.json().result as { content: { text: string }[]; isError?: boolean };
}

describe.skipIf(!TEST_DATABASE_URL)('MCP personal habits', () => {
  beforeEach(async () => {
    t = await testApp();
    await t.app.services.settings.update(
      { 'instance.publicUrl': BASE, 'instance.defaultTimezone': 'UTC' },
      { userId: null, ip: null },
    );
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    alice = await createUser(t.db, { username: 'habit-alice', password: 'x'.repeat(12) });
    bob = await createUser(t.db, { username: 'habit-bob', password: 'x'.repeat(12) });
    limitedProject = id();
    await new SyncUser(t.app.services.sync, alice).ok(
      cmd('project_add', { id: limitedProject, name: 'Limited' }),
    );
  });
  afterEach(async () => t.close());

  it('supports scoped CRUD, stable retries, check-in history and owner isolation', async () => {
    const rw = await token(alice, ['habits:read', 'habits:write']);
    const id = newId();
    const payload = { id, name: 'Read', period: 'week', target: 2 };
    const created = await call(rw, 'add_habit', payload);
    expect(created.isError).toBeFalsy();
    expect((await call(rw, 'add_habit', payload)).content[0]?.text).toContain('"created": false');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const today = `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}-${parts.find((p) => p.type === 'day')?.value}`;
    const checkIn = await call(rw, 'set_habit_check_in', { id, date: today, completed: true });
    expect(checkIn.content[0]?.text).toContain('"completed": 1');
    expect(
      (await call(rw, 'set_habit_check_in', { id, date: today, completed: true })).isError,
    ).toBeFalsy();
    const listed = await call(rw, 'list_habits');
    expect(listed.content[0]?.text).toContain('"history"');
    expect(listed.content[0]?.text).toContain('"current": 0');
    expect((await call(rw, 'update_habit', { id, period: 'day', target: 2 })).isError).toBe(true);
    expect(
      (await call(rw, 'set_habit_check_in', { id, date: '2025-02-29', completed: true })).isError,
    ).toBe(true);
    expect(
      (await call(rw, 'set_habit_check_in', { id, date: '9999-12-31', completed: true })).isError,
    ).toBe(true);
    const bobToken = await token(bob, ['habits:read', 'habits:write']);
    expect((await call(bobToken, 'get_habit', { id })).isError).toBe(true);
    expect((await call(rw, 'delete_habit', { id })).isError).toBeFalsy();
    expect(await t.db.db.select().from(habits)).toEqual([]);
  });

  it('requires habit scopes and never exposes account-wide tools to project-limited tokens', async () => {
    const readOnly = await token(alice, ['habits:read']);
    const listed = await rpc(readOnly, 'tools/list');
    const names = (listed.json().result as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    );
    expect(names).toContain('list_habits');
    expect(names).not.toContain('add_habit');
    expect(
      (await call(readOnly, 'add_habit', { name: 'Walk', period: 'day', target: 1 })).isError,
    ).toBe(true);
    const limited = await token(alice, ['habits:read', 'habits:write'], [limitedProject]);
    const hidden = await rpc(limited, 'tools/list');
    const limitedNames = (hidden.json().result as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    );
    expect(limitedNames).not.toContain('list_habits');
    expect((await call(limited, 'list_habits')).isError).toBe(true);
    const projectLimitedRest = await t.app.inject({
      method: 'GET',
      url: '/api/v1/habits',
      headers: { host: TEST_HOST, authorization: `Bearer ${limited}` },
    });
    expect(projectLimitedRest.statusCode).toBe(403);
  });

  it('supports OAuth habit scopes and denies task-only tokens', async () => {
    const taskOnly = await token(alice, ['tasks:read']);
    expect((await call(taskOnly, 'list_habits')).isError).toBe(true);
    const read = await oauthToken(alice, ['habits:read']);
    const tools = await rpc(read, 'tools/list');
    const names = (tools.json().result as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    );
    expect(names).toContain('list_habits');
    expect(names).not.toContain('add_habit');
    const write = await oauthToken(alice, ['habits:write']);
    const created = await call(write, 'add_habit', { name: 'Walk', period: 'day', target: 1 });
    expect(created.isError).toBeFalsy();
  });
});
