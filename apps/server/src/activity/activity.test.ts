import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

let t: TestApp;
type Person = { sync: SyncUser; http: Client; id: string };
const people: Record<string, Person> = {};

async function person(name: string) {
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
  people[name] = { sync, http, id: userId };
}

async function activity(who: string, query: string) {
  const res = await people[who]!.http.get(`/api/v1/activity${query ? `?${query}` : ''}`);
  const entries = res.statusCode === 200 ? (res.json().entries as { projectId: string }[]) : [];
  return { status: res.statusCode, projects: new Set(entries.map((e) => e.projectId)) };
}

let ws: string;
let open: string;
let closed: string;
let personal: string;
let openTask: string;
let closedTask: string;

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  for (const name of ['olivia', 'meg', 'xavier']) await person(name);
  ws = id();
  open = id();
  closed = id();
  personal = id();
  openTask = id();
  closedTask = id();
  await people.olivia!.sync.ok(
    cmd('workspace_add', { id: ws, name: 'Acme' }),
    cmd('project_add', { id: open, name: 'Roadmap', workspaceId: ws }),
    cmd('project_add', { id: closed, name: 'Salaries', workspaceId: ws, visibility: 'restricted' }),
    // Olivia owns this one too, but it is not part of the team.
    cmd('project_add', { id: personal, name: 'Garden' }),
    cmd('task_add', { id: openTask, projectId: open, content: 'Ship it' }),
    cmd('task_add', { id: closedTask, projectId: closed, content: 'Payroll' }),
    cmd('task_add', { id: id(), projectId: personal, content: 'Buy seeds' }),
  );
  // meg accepts a member invite: implicit editor on the workspace-visible project only.
  const invite = await people.olivia!.http.request({
    method: 'POST',
    url: `/api/v1/workspaces/${ws}/invites`,
    payload: { role: 'member' },
  });
  await people.meg!.http.request({
    method: 'POST',
    url: '/api/v1/invites/link/accept',
    payload: { token: (invite.json() as { token: string }).token },
  });
  await people.meg!.sync.run();
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('workspace activity log', () => {
  it('aggregates every project in the workspace for someone who can see them all', async () => {
    const res = await activity('olivia', `workspaceId=${ws}`);
    expect(res.status).toBe(200);
    expect(res.projects).toContain(open);
    expect(res.projects).toContain(closed);
    // Projects outside the team never leak into its log, even for their owner.
    expect(res.projects).not.toContain(personal);
  });

  it('shows a team member only the projects they can see', async () => {
    const res = await activity('meg', `workspaceId=${ws}`);
    expect(res.status).toBe(200);
    expect(res.projects).toContain(open);
    expect(res.projects).not.toContain(closed);
  });

  it('hides the workspace from non-members, and never confirms one that does not exist', async () => {
    expect((await activity('xavier', `workspaceId=${ws}`)).status).toBe(404);
    expect((await activity('xavier', `workspaceId=${id()}`)).status).toBe(404);
  });

  it('still scopes a single project, and requires exactly one scope', async () => {
    const project = await activity('olivia', `projectId=${closed}`);
    expect(project.projects).toEqual(new Set([closed]));
    expect((await activity('olivia', '')).status).toBe(400);
    expect((await activity('olivia', `projectId=${open}&workspaceId=${ws}`)).status).toBe(400);
    expect((await activity('olivia', `taskId=${openTask}&workspaceId=${ws}`)).status).toBe(400);
  });

  it('never lets a task scope widen past what the caller can see', async () => {
    const own = await activity('meg', `taskId=${openTask}`);
    expect(own.status).toBe(200);
    expect(own.projects).toEqual(new Set([open]));
    // meg cannot see the restricted project, so its task history is empty rather than leaking.
    expect((await activity('meg', `taskId=${closedTask}`)).projects).toEqual(new Set());
  });
});
