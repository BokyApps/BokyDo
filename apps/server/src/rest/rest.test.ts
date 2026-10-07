import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

let t: TestApp;
type Person = { id: string; sync: SyncUser; http: Client; token: string };
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
  // A read-only integration token, the way a user would mint one in Settings.
  const { token } = await t.app.services.apiTokens.createPat(userId, {
    name: `${name}-read`,
    scopes: ['tasks:read', 'projects:read'],
    expiresInDays: 1,
  });
  people[name] = { id: userId, sync, http, token };
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
