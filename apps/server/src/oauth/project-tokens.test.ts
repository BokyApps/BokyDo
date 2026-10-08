import type { ApiScope, CommandType } from '@bokydo/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../db/ids.js';
import { apiTokens, comments, projects, tasks } from '../db/schema.js';
import { grantProjectAccess } from '../sync/membership.js';
import { Client, createUser, TEST_HOST, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { PatProjectError } from './token-store.js';

/**
 * Personal access tokens limited to some projects (PLAN W10a follow-up). Alice owns Allowed (with
 * a task) and Other (with a task); her token is limited to Allowed. Nothing in Other, her Inbox or
 * her account-wide data may be read or written through it, on REST, MCP or the command path.
 */
let t: TestApp;
let alice: { id: string; sync: SyncUser; http: Client };
let allowed: string;
let other: string;
let allowedTask: string;
let otherTask: string;

const ALL: ApiScope[] = [
  'tasks:read',
  'tasks:write',
  'projects:read',
  'projects:write',
  'comments:read',
  'comments:write',
];

async function limitedToken(projectIds: string[] | null = [allowed], scopes = ALL) {
  return (
    await t.app.services.apiTokens.createPat(alice.id, {
      name: 'limited',
      scopes,
      expiresInDays: 1,
      projectIds,
    })
  ).token;
}

function bearer(token: string): Client {
  const client = new Client(t.app, null);
  const request = client.request.bind(client);
  client.request = (opts) =>
    request({
      ...opts,
      headers: { ...(opts.headers as object), authorization: `Bearer ${token}` },
    });
  return client;
}

async function call(
  client: Client,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  const res = await client.request({ method, url, ...(payload === undefined ? {} : { payload }) });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

let seq = 0;
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      host: TEST_HOST,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    payload: { jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.statusCode).toBe(200);
  const result = res.json().result as { content: { text: string }[]; isError?: boolean };
  return { isError: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
}

const taskRow = async (taskId: string) =>
  (await t.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0];

describe.skipIf(!TEST_DATABASE_URL)('project-limited personal access tokens', () => {
  beforeEach(async () => {
    t = await testApp();
    await t.app.services.settings.update(
      { 'instance.publicUrl': 'https://tasks.example.com', 'instance.defaultTimezone': 'UTC' },
      { userId: null, ip: null },
    );
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    const userId = await createUser(t.db, { username: 'alice', password: 'x'.repeat(12) });
    const http = new Client(t.app, 'https://tasks.example.com');
    const { token: session, session: s } = await t.app.services.sessions.create(
      { id: userId, username: 'alice', isAdmin: false, mustChangePassword: false },
      { ip: null, userAgent: null, authMethod: 'password' },
    );
    http.cookies.set('bokydo_session', session);
    http.csrfToken = s.csrfToken;
    alice = { id: userId, sync: new SyncUser(t.app.services.sync, userId), http };
    allowed = id();
    other = id();
    allowedTask = id();
    otherTask = id();
    await alice.sync.ok(
      cmd('project_add', { id: allowed, name: 'Allowed' }),
      cmd('project_add', { id: other, name: 'Other' }),
      cmd('task_add', { id: allowedTask, projectId: allowed, content: 'allowed errand' }),
      cmd('task_add', { id: otherTask, projectId: other, content: 'other errand' }),
    );
  });
  afterEach(async () => t.close());

  describe('creating one', () => {
    it('limits a token to projects the user can see, and lists the limit', async () => {
      const res = await alice.http.post('/api/v1/account/tokens', {
        name: 'n8n',
        scopes: ['tasks:read'],
        expiresInDays: 30,
        projectIds: [allowed],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().pat.projectIds).toEqual([allowed]);
      const list = (await alice.http.get('/api/v1/account/tokens')).json();
      expect(list.tokens[0].projectIds).toEqual([allowed]);
      // No limit given: every project, as before.
      const all = await alice.http.post('/api/v1/account/tokens', {
        name: 'all',
        scopes: ['tasks:read'],
        expiresInDays: 30,
      });
      expect(all.json().pat.projectIds).toBeNull();
    });

    it('refuses projects the user cannot see, an empty list, and whole-account sync', async () => {
      const bob = await createUser(t.db, { username: 'bob', password: 'x'.repeat(12) });
      const bobs = id();
      await new SyncUser(t.app.services.sync, bob).ok(
        cmd('project_add', { id: bobs, name: 'Bob' }),
      );
      const create = (body: Record<string, unknown>) =>
        alice.http.post('/api/v1/account/tokens', {
          name: 'x',
          scopes: ['tasks:read'],
          expiresInDays: 30,
          ...body,
        });
      expect((await create({ projectIds: [bobs] })).statusCode).toBe(400);
      expect((await create({ projectIds: [allowed, newId()] })).statusCode).toBe(400);
      expect((await create({ projectIds: [] })).statusCode).toBe(400);
      expect((await create({ projectIds: [allowed], scopes: ['sync'] })).statusCode).toBe(400);
      await expect(limitedToken([allowed], ['sync'])).rejects.toBeInstanceOf(PatProjectError);
      const stored = await t.db.db.select().from(apiTokens).where(eq(apiTokens.userId, alice.id));
      expect(stored).toHaveLength(0);
    });
  });

  describe('REST', () => {
    it('reads only inside its projects', async () => {
      const api = bearer(await limitedToken());
      const list = await call(api, 'GET', '/api/v1/projects');
      expect(list.body.projects.map((p: { id: string }) => p.id)).toEqual([allowed]);
      expect((await call(api, 'GET', `/api/v1/projects/${other}`)).status).toBe(404);
      expect((await call(api, 'GET', `/api/v1/projects/${alice.sync.inbox}`)).status).toBe(404);
      const all = await call(api, 'GET', '/api/v1/tasks');
      expect(all.body.tasks.map((x: { id: string }) => x.id)).toEqual([allowedTask]);
      expect((await call(api, 'GET', `/api/v1/tasks?projectId=${other}`)).status).toBe(404);
      expect((await call(api, 'GET', `/api/v1/tasks/${otherTask}`)).status).toBe(404);
      expect((await call(api, 'GET', `/api/v1/tasks/${allowedTask}`)).status).toBe(200);
    });

    it('writes only inside its projects, and creates no projects', async () => {
      const api = bearer(await limitedToken());
      const into = (projectId?: string) =>
        call(api, 'POST', '/api/v1/tasks', {
          content: 'new',
          ...(projectId ? { projectId } : {}),
        });
      expect((await into(other)).status).toBe(404);
      expect((await into()).status).toBe(404); // the Inbox is outside too
      expect((await into(allowed)).status).toBe(201);
      for (const [method, url, body] of [
        ['PATCH', `/api/v1/tasks/${otherTask}`, { content: 'hijacked' }],
        ['POST', `/api/v1/tasks/${otherTask}/complete`, undefined],
        ['DELETE', `/api/v1/tasks/${otherTask}`, undefined],
        ['PATCH', `/api/v1/projects/${other}`, { name: 'hijacked' }],
        ['DELETE', `/api/v1/projects/${other}`, undefined],
      ] as const)
        expect((await call(api, method, url, body)).status, `${method} ${url}`).toBe(404);
      expect((await call(api, 'POST', '/api/v1/projects', { name: 'Escape' })).status).toBe(403);
      const after = await taskRow(otherTask);
      expect(after).toMatchObject({ content: 'other errand', isCompleted: false, deletedAt: null });
      const [otherProject] = await t.db.db.select().from(projects).where(eq(projects.id, other));
      expect(otherProject).toMatchObject({ name: 'Other', deletedAt: null });
      expect(
        (await call(api, 'PATCH', `/api/v1/tasks/${allowedTask}`, { content: 'fine' })).status,
      ).toBe(200);
    });

    it('cannot delete an allowed project whose sub-project is outside the limit', async () => {
      const child = id();
      await alice.sync.ok(cmd('project_add', { id: child, name: 'Child', parentId: allowed }));
      const api = bearer(await limitedToken());
      expect((await call(api, 'DELETE', `/api/v1/projects/${allowed}`)).status).toBe(404);
      const live = await t.db.db
        .select({ id: projects.id })
        .from(projects)
        .where(isNull(projects.deletedAt));
      expect(live.map((p) => p.id)).toEqual(expect.arrayContaining([allowed, child]));
      // With the sub-project included it works.
      const both = bearer(await limitedToken([allowed, child]));
      expect((await call(both, 'DELETE', `/api/v1/projects/${allowed}`)).status).toBe(204);
    });

    it('never reaches whole-account sync, even if such a token were stored', async () => {
      const token = await limitedToken();
      await t.db.db
        .update(apiTokens)
        .set({ scopes: [...ALL, 'sync'] })
        .where(eq(apiTokens.userId, alice.id));
      const api = bearer(token);
      expect((await call(api, 'POST', '/api/v1/sync', { cursor: null })).status).toBe(403);
      expect((await call(api, 'GET', '/api/v1/push/key')).status).toBe(403);
      expect((await call(api, 'GET', '/api/v1/tasks')).status).toBe(200);
    });
  });

  describe('MCP', () => {
    it('offers no account-wide tools and sees only its projects', async () => {
      const token = await limitedToken();
      const listed = await t.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          host: TEST_HOST,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        payload: { jsonrpc: '2.0', id: ++seq, method: 'tools/list' },
      });
      const names = (listed.json().result.tools as { name: string }[]).map((x) => x.name);
      expect(names).not.toContain('list_filters');
      expect(names).toContain('list_projects');

      const projectsText = (await tool(token, 'list_projects')).text;
      expect(projectsText).toContain('Allowed');
      expect(projectsText).not.toContain('Other');
      expect(projectsText).not.toContain('Inbox');
      expect((await tool(token, 'search_tasks', { query: 'errand' })).text).not.toContain(
        'other errand',
      );
      expect((await tool(token, 'run_filter', { query: '#Other' })).text).not.toContain(
        'other errand',
      );
      expect((await tool(token, 'run_filter', { query: 'no date' })).text).not.toContain(
        'other errand',
      );
      expect((await tool(token, 'get_report')).text).not.toContain('other errand');
      expect((await tool(token, 'get_task', { id: otherTask })).isError).toBe(true);
    });

    it('writes only inside its projects', async () => {
      const token = await limitedToken();
      expect((await tool(token, 'complete_task', { id: otherTask })).isError).toBe(true);
      expect(
        (await tool(token, 'update_task', { id: otherTask, content: 'hijacked' })).isError,
      ).toBe(true);
      expect((await tool(token, 'add_comment', { taskId: otherTask, content: 'hi' })).isError).toBe(
        true,
      );
      expect((await tool(token, 'add_task', { text: 'x', projectId: other })).isError).toBe(true);
      // "#Other" isn't a project it knows, and without a project the task would go to the Inbox.
      expect((await tool(token, 'add_task', { text: 'sneak #Other' })).isError).toBe(true);
      expect((await tool(token, 'add_task', { text: 'fine', projectId: allowed })).isError).toBe(
        false,
      );
      expect(await taskRow(otherTask)).toMatchObject({
        content: 'other errand',
        isCompleted: false,
      });
      const notes = await t.db.db.select().from(comments).where(eq(comments.taskId, otherTask));
      expect(notes).toHaveLength(0);
    });
  });

  describe('the command path', () => {
    const scope = () => new Set([allowed]);
    const run = (type: CommandType, args: Record<string, unknown>) =>
      t.app.services.sync.apply(alice.id, type, newId(), args, scope());

    it('treats everything outside the limit as not found', async () => {
      const section = id();
      await alice.sync.ok(cmd('section_add', { id: section, projectId: other, name: 'S' }));
      const outside: [CommandType, Record<string, unknown>][] = [
        ['task_add', { id: id(), content: 'x', projectId: other }],
        ['task_add', { id: id(), content: 'x', parentId: otherTask }],
        ['task_add', { id: id(), content: 'x' }], // Inbox
        ['task_update', { id: otherTask, content: 'x' }],
        ['task_move', { id: allowedTask, projectId: other }],
        ['task_move', { id: otherTask, projectId: allowed }],
        ['task_complete', { id: otherTask }],
        ['task_delete', { id: otherTask }],
        ['section_add', { id: id(), projectId: other, name: 'x' }],
        ['section_update', { id: section, name: 'x' }],
        ['comment_add', { id: id(), taskId: otherTask, content: 'x' }],
        ['comment_add', { id: id(), projectId: other, content: 'x' }],
        ['reminder_add', { id: id(), taskId: otherTask, type: 'relative', minutesBefore: 10 }],
        ['project_update', { id: other, name: 'x' }],
        ['project_archive', { id: other }],
      ];
      for (const [type, args] of outside) {
        const result = await run(type, args);
        expect(result, `${type} ${JSON.stringify(args)}`).toMatchObject({
          ok: false,
          error: 'not_found',
        });
      }
      expect((await taskRow(allowedTask))?.projectId).toBe(allowed);
      expect(await taskRow(otherTask)).toMatchObject({
        content: 'other errand',
        projectId: other,
        deletedAt: null,
      });
      expect(await run('task_update', { id: allowedTask, content: 'ok' })).toEqual({ ok: true });
    });

    it('refuses account-wide and sharing commands outright', async () => {
      const bob = await createUser(t.db, { username: 'bob', password: 'x'.repeat(12) });
      await grantProjectAccess(t.db.db, allowed, bob, 'editor');
      for (const [type, args] of [
        ['project_add', { id: id(), name: 'x' }],
        ['project_add', { id: id(), name: 'x', parentId: allowed }],
        ['project_move', { id: allowed, parentId: null }],
        ['label_add', { id: id(), name: 'x' }],
        ['filter_add', { id: id(), name: 'x', query: 'today' }],
        ['user_update_preferences', { weekStart: 'sunday' }],
        ['project_member_update', { projectId: allowed, userId: bob, role: 'viewer' }],
        ['project_member_remove', { projectId: allowed, userId: bob }],
        ['project_transfer', { projectId: allowed, userId: bob }],
        ['workspace_add', { id: id(), name: 'x' }],
        ['notifications_mark_read', { all: true }],
      ] as [CommandType, Record<string, unknown>][]) {
        expect(await run(type, args), type).toMatchObject({ ok: false, error: 'forbidden' });
      }
    });

    it('rolls back a whole Ramble-style batch that strays outside', async () => {
      const first = id();
      const result = await t.app.services.sync.applyAll(
        alice.id,
        [
          { type: 'task_add', args: { id: first, content: 'in', projectId: allowed } },
          { type: 'task_add', args: { id: id(), content: 'out', projectId: other } },
        ],
        scope(),
      );
      expect(result).toMatchObject({ ok: false, index: 1 });
      expect(await taskRow(first)).toBeUndefined();
    });

    it('leaves sessions and unlimited tokens as they were', async () => {
      const api = bearer(await limitedToken(null));
      const all = await call(api, 'GET', '/api/v1/tasks');
      expect(all.body.tasks.map((x: { id: string }) => x.id).sort()).toEqual(
        [allowedTask, otherTask].sort(),
      );
      const moved = await t.app.services.sync.apply(alice.id, 'task_move', newId(), {
        id: otherTask,
        projectId: allowed,
      });
      expect(moved).toEqual({ ok: true });
      const [row] = await t.db.db
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.id, otherTask)));
      expect(row?.projectId).toBe(allowed);
    });
  });
});
