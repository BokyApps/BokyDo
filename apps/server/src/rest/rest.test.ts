import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

let t: TestApp;
type Person = { id: string; sync: SyncUser; http: Client; token: string; writeToken: string };
const people: Record<string, Person> = {};

async function person(name: string) {
  const userId = await createUser(t.db, { username: name, password: 'x'.repeat(12) });
  const http = new Client(t.app);
  const { token: session, session: s } = await t.app.services.sessions.create(
    { id: userId, username: name, isAdmin: false, mustChangePassword: false },
    { ip: null, userAgent: null, authMethod: 'password' },
  );
  http.cookies.set('bokydo_session', session);
  http.csrfToken = s.csrfToken;
  const sync = new SyncUser(t.app.services.sync, userId);
  await sync.run();
  // Read-only and read-write integration tokens, the way a user would mint them in Settings.
  const { token } = await t.app.services.apiTokens.createPat(userId, {
    name: `${name}-read`,
    scopes: ['tasks:read', 'projects:read'],
    expiresInDays: 1,
  });
  const { token: writeToken } = await t.app.services.apiTokens.createPat(userId, {
    name: `${name}-write`,
    scopes: ['tasks:read', 'tasks:write', 'projects:read', 'projects:write'],
    expiresInDays: 1,
  });
  people[name] = { id: userId, sync, http, token, writeToken };
}

/** Like curl: no cookies, no Origin, just the bearer token. */
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

const as = (who: string) => bearer(people[who]!.token);
const get = async (client: Client, url: string) => {
  const res = await client.request({ method: 'GET', url });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const call = async (
  client: Client,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) => {
  const res = await client.request({ method, url, ...(payload === undefined ? {} : { payload }) });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

let aliceProject: string;
let bobProject: string;
const aliceTasks: string[] = [];

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  for (const name of ['alice', 'bob']) await person(name);
  aliceProject = id();
  bobProject = id();
  aliceTasks.length = 0;
  aliceTasks.push(id(), id(), id());
  await people.alice!.sync.ok(
    cmd('project_add', { id: aliceProject, name: 'Alice roadmap' }),
    ...aliceTasks.map((taskId, i) =>
      cmd('task_add', { id: taskId, projectId: aliceProject, content: `Alice task ${i}` }),
    ),
  );
  await people.bob!.sync.ok(
    cmd('project_add', { id: bobProject, name: 'Bob secrets' }),
    cmd('task_add', { id: id(), projectId: bobProject, content: 'Bob task' }),
  );
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('REST v1: read access with bearer tokens', () => {
  it('lists only the tasks inside projects the token owner can see', async () => {
    const mine = await get(as('alice'), `/api/v1/tasks?projectId=${aliceProject}`);
    expect(mine.status).toBe(200);
    expect(mine.body.tasks.map((task: { id: string }) => task.id).sort()).toEqual(
      [...aliceTasks].sort(),
    );

    const everything = await get(as('alice'), '/api/v1/tasks');
    expect(everything.status).toBe(200);
    expect(everything.body.tasks.map((task: { content: string }) => task.content)).not.toContain(
      'Bob task',
    );
  });

  it('hides a project that was not shared, rather than erroring differently', async () => {
    expect((await get(as('bob'), `/api/v1/tasks?projectId=${aliceProject}`)).status).toBe(404);
    expect((await get(as('bob'), `/api/v1/projects/${aliceProject}`)).status).toBe(404);
    expect((await get(as('bob'), `/api/v1/tasks/${aliceTasks[0]}`)).status).toBe(404);
    expect((await get(as('alice'), `/api/v1/projects/${aliceProject}`)).status).toBe(200);
  });

  it('pages with the opaque cursor without repeating or skipping', async () => {
    const first = await get(as('alice'), `/api/v1/tasks?projectId=${aliceProject}&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.tasks).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await get(
      as('alice'),
      `/api/v1/tasks?projectId=${aliceProject}&limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.tasks).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();

    const seen = [...first.body.tasks, ...second.body.tasks].map((task: { id: string }) => task.id);
    expect([...seen].sort()).toEqual([...aliceTasks].sort());
  });

  it('refuses a token that does not carry the scope, and anonymous callers', async () => {
    const { token } = await t.app.services.apiTokens.createPat(people.alice!.id, {
      name: 'projects-only',
      scopes: ['projects:read'],
      expiresInDays: 1,
    });
    const refused = await get(bearer(token), '/api/v1/tasks');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('insufficient_scope');
    // The scope it does hold still works.
    expect((await get(bearer(token), '/api/v1/projects')).status).toBe(200);

    const anonymous = await get(new Client(t.app, null), '/api/v1/tasks');
    expect(anonymous.status).toBe(401);
  });

  it('rejects a malformed query or path instead of guessing', async () => {
    expect((await get(as('alice'), '/api/v1/tasks?limit=1000')).status).toBe(400);
    expect((await get(as('alice'), '/api/v1/tasks?projectId=not-a-uuid')).status).toBe(400);
    expect((await get(as('alice'), '/api/v1/tasks/not-a-uuid')).status).toBe(400);
  });

  it('publishes an OpenAPI 3.1 document and a plain docs page, both unauthenticated', async () => {
    const spec = await get(new Client(t.app, null), '/api/docs/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths)).toEqual(
      expect.arrayContaining(['/api/v1/tasks', '/api/v1/tasks/{id}', '/api/v1/projects']),
    );
    const listed = spec.body.paths['/api/v1/tasks'].get;
    expect(listed.security).toEqual([{ bearerAuth: ['tasks:read'] }]);
    expect(listed.responses['200'].content['application/json'].schema).toMatchObject({
      type: 'object',
    });
    expect(listed.parameters.map((p: { name: string }) => p.name)).toContain('projectId');

    const page = await new Client(t.app, null).request({ method: 'GET', url: '/api/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('/api/docs/openapi.json');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('REST v1: writes with bearer tokens', () => {
  const write = (who: string) => bearer(people[who]!.writeToken);

  it('creates a task and answers with it', async () => {
    const created = await call(write('alice'), 'POST', '/api/v1/tasks', {
      projectId: aliceProject,
      content: 'Written over REST',
      priority: 2,
    });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({
      content: 'Written over REST',
      priority: 2,
      projectId: aliceProject,
      isCompleted: false,
    });

    const fetched = await get(as('alice'), `/api/v1/tasks/${created.body.task.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.task.content).toBe('Written over REST');
  });

  it('updates, completes, reopens and deletes', async () => {
    const created = await call(write('alice'), 'POST', '/api/v1/tasks', {
      projectId: aliceProject,
      content: 'Draft',
    });
    const taskId = created.body.task.id;

    const patched = await call(write('alice'), 'PATCH', `/api/v1/tasks/${taskId}`, {
      content: 'Final',
      priority: 1,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.task).toMatchObject({ content: 'Final', priority: 1 });

    const done = await call(write('alice'), 'POST', `/api/v1/tasks/${taskId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.task.isCompleted).toBe(true);

    const reopened = await call(write('alice'), 'POST', `/api/v1/tasks/${taskId}/uncomplete`);
    expect(reopened.body.task.isCompleted).toBe(false);

    expect((await call(write('alice'), 'DELETE', `/api/v1/tasks/${taskId}`)).status).toBe(204);
    expect((await get(as('alice'), `/api/v1/tasks/${taskId}`)).status).toBe(404);
  });

  it('refuses a read-only token and writes into someone else’s project', async () => {
    const denied = await call(as('alice'), 'POST', '/api/v1/tasks', {
      projectId: aliceProject,
      content: 'not allowed',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('insufficient_scope');

    // bob holds tasks:write, but not over alice's project.
    const foreign = await call(write('bob'), 'POST', '/api/v1/tasks', {
      projectId: aliceProject,
      content: 'not allowed either',
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('not_found');
  });

  it('rejects an invalid body without creating anything', async () => {
    const missingContent = await call(write('alice'), 'POST', '/api/v1/tasks', {
      projectId: aliceProject,
    });
    expect(missingContent.status).toBe(400);

    const before = await get(as('alice'), `/api/v1/tasks?projectId=${aliceProject}`);
    expect(before.body.tasks).toHaveLength(aliceTasks.length);
    expect((await call(write('alice'), 'PATCH', '/api/v1/tasks/nope', {})).status).toBe(400);
  });

  it('rolls a recurring task forward rather than closing it', async () => {
    const created = await call(write('alice'), 'POST', '/api/v1/tasks', {
      projectId: aliceProject,
      content: 'Water plants',
      due: {
        date: '2026-01-01',
        time: null,
        timezone: null,
        string: 'every day',
        recurrence: { rrule: 'FREQ=DAILY', anchor: 'scheduled' },
      },
    });
    expect(created.status).toBe(201);

    const done = await call(
      write('alice'),
      'POST',
      `/api/v1/tasks/${created.body.task.id}/complete`,
    );
    expect(done.status).toBe(200);
    // The occurrence completed, so the task is open again at its next date.
    expect(done.body.task.isCompleted).toBe(false);
    expect(done.body.task.due.date > '2026-01-01').toBe(true);
  });
});
