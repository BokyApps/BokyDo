import type { Role } from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectInvitations, users } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

let t: TestApp;
type Person = { sync: SyncUser; http: Client; id: string; name: string };
let people: Record<string, Person> = {};

async function person(name: string, opts: { email?: string; verified?: boolean } = {}) {
  const userId = await createUser(t.db, { username: name, password: 'x'.repeat(12) });
  if (opts.email)
    await t.db.db
      .update(users)
      .set({ email: opts.email, emailVerifiedAt: opts.verified ? new Date() : null })
      .where(eq(users.id, userId));
  const http = new Client(t.app);
  const { token, session } = await t.app.services.sessions.create(
    { id: userId, username: name, isAdmin: false, mustChangePassword: false },
    { ip: null, userAgent: null, authMethod: 'password' },
  );
  http.cookies.set('bokydo_session', token);
  http.csrfToken = session.csrfToken;
  const sync = new SyncUser(t.app.services.sync, userId);
  await sync.run();
  people[name] = { sync, http, id: userId, name };
  return people[name]!;
}

const json = (body: string) => JSON.parse(body) as Record<string, unknown>;

async function invite(by: Person, projectId: string, body: Record<string, unknown>) {
  const res = await by.http.request({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/invites`,
    payload: body,
  });
  return { status: res.statusCode, body: res.body ? json(res.body) : {} };
}

async function acceptLink(who: Person, token: string) {
  const res = await who.http.request({
    method: 'POST',
    url: '/api/v1/invites/link/accept',
    payload: { token },
  });
  return res.statusCode;
}

/** Share `projectId` from its owner to `who` with `role`, through a link invite. */
async function share(owner: Person, projectId: string, who: Person, role: Exclude<Role, 'owner'>) {
  const { body } = await invite(owner, projectId, { role });
  expect(await acceptLink(who, body.token as string)).toBe(200);
  await who.sync.run();
}

let project: string;

beforeEach(async () => {
  t = await testApp();
  people = {};
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  for (const name of ['olivia', 'ada', 'ed', 'cora', 'vic', 'xavier']) await person(name);
  project = id();
  await people.olivia!.sync.ok(cmd('project_add', { id: project, name: 'Launch' }));
  await share(people.olivia!, project, people.ada!, 'admin');
  await share(people.olivia!, project, people.ed!, 'editor');
  await share(people.olivia!, project, people.cora!, 'commenter');
  await share(people.olivia!, project, people.vic!, 'viewer');
  for (const p of Object.values(people)) await p.sync.run();
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('sharing: membership and roles', () => {
  it('syncs members and collaborators to everyone on the project, and nobody else', async () => {
    const olivia = people.olivia!.sync.last;
    expect(
      olivia.members
        .filter((m) => m.projectId === project)
        .map((m) => m.role)
        .sort(),
    ).toEqual(['admin', 'commenter', 'editor', 'owner', 'viewer']);
    expect(people.vic!.sync.last.collaborators.map((c) => c.username).sort()).toEqual([
      'ada',
      'cora',
      'ed',
      'olivia',
      'vic',
    ]);
    expect(people.vic!.sync.projects.get(project)?.role).toBe('viewer');
    // Xavier only sees himself (on his own inbox).
    expect(people.xavier!.sync.last.members.map((m) => m.projectId)).toEqual([
      people.xavier!.sync.inbox,
    ]);
    expect(people.xavier!.sync.last.collaborators.map((c) => c.username)).toEqual(['xavier']);
  });

  // [actor, target, new role, expected]
  const updates: [string, string, Exclude<Role, 'owner'>, string][] = [
    ['olivia', 'ed', 'viewer', 'ok'],
    ['olivia', 'ada', 'editor', 'ok'],
    ['olivia', 'ed', 'admin', 'ok'],
    ['ada', 'ed', 'commenter', 'ok'],
    ['ada', 'vic', 'editor', 'ok'],
    ['ada', 'ed', 'admin', 'forbidden'],
    ['ada', 'ada', 'editor', 'ok'],
    ['ed', 'vic', 'editor', 'forbidden'],
    ['cora', 'vic', 'editor', 'forbidden'],
    ['vic', 'vic', 'admin', 'forbidden'],
    ['xavier', 'vic', 'admin', 'not_found'],
  ];
  it.each(updates)('%s sets %s to %s → %s', async (actor, target, role, expected) => {
    const r = await people[actor]!.sync.result(
      cmd('project_member_update', { projectId: project, userId: people[target]!.id, role }),
    );
    expect(r?.ok ? 'ok' : (r as { error: string }).error).toBe(expected);
  });

  it('never changes the owner by role update', async () => {
    const r = await people.ada!.sync.result(
      cmd('project_member_update', {
        projectId: project,
        userId: people.olivia!.id,
        role: 'viewer',
      }),
    );
    expect(r).toMatchObject({ ok: false, error: 'forbidden' });
    const forged = await people.olivia!.sync.result(
      cmd('project_member_update', { projectId: project, userId: people.ed!.id, role: 'owner' }),
    );
    expect(forged).toMatchObject({ ok: false, error: 'invalid' });
  });

  const removals: [string, string, string][] = [
    ['olivia', 'ada', 'ok'],
    ['ada', 'ed', 'ok'],
    ['ada', 'olivia', 'forbidden'],
    ['ed', 'vic', 'forbidden'],
    ['vic', 'vic', 'ok'],
    ['olivia', 'olivia', 'forbidden'],
    ['xavier', 'ed', 'not_found'],
  ];
  it.each(removals)('%s removes %s → %s', async (actor, target, expected) => {
    const r = await people[actor]!.sync.result(
      cmd('project_member_remove', { projectId: project, userId: people[target]!.id }),
    );
    expect(r?.ok ? 'ok' : (r as { error: string }).error).toBe(expected);
  });

  it('only admins are removed by the owner', async () => {
    await people.olivia!.sync.ok(
      cmd('project_member_update', { projectId: project, userId: people.ed!.id, role: 'admin' }),
    );
    expect(
      await people.ada!.sync.result(
        cmd('project_member_remove', { projectId: project, userId: people.ed!.id }),
      ),
    ).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('a removed member loses the project and its tasks, and their assignments lapse', async () => {
    const task = id();
    await people.olivia!.sync.ok(
      cmd('task_add', { id: task, projectId: project, content: 'Ship', assigneeId: people.ed!.id }),
    );
    await people.ed!.sync.run();
    expect(people.ed!.sync.tasks.has(task)).toBe(true);
    await people.ada!.sync.ok(
      cmd('project_member_remove', { projectId: project, userId: people.ed!.id }),
    );
    await people.ed!.sync.run();
    expect(people.ed!.sync.projects.has(project)).toBe(false);
    expect(people.ed!.sync.tasks.has(task)).toBe(false);
    expect(
      await people.ed!.sync.result(cmd('task_update', { id: task, content: 'pwned' })),
    ).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    await people.olivia!.sync.run();
    expect(people.olivia!.sync.tasks.get(task)?.assigneeId).toBeNull();
  });

  it('assigns only to members', async () => {
    const task = id();
    expect(
      await people.olivia!.sync.result(
        cmd('task_add', {
          id: task,
          projectId: project,
          content: 'x',
          assigneeId: people.xavier!.id,
        }),
      ),
    ).toMatchObject({ ok: false, error: 'invalid' });
    await people.ed!.sync.ok(
      cmd('task_add', { id: task, projectId: project, content: 'x', assigneeId: people.cora!.id }),
    );
    await people.cora!.sync.run();
    expect(people.cora!.sync.tasks.get(task)).toMatchObject({
      assigneeId: people.cora!.id,
      assignedById: people.ed!.id,
    });
  });

  it('transfers ownership; the previous owner becomes an admin', async () => {
    expect(
      await people.ada!.sync.result(
        cmd('project_transfer', { projectId: project, userId: people.ada!.id }),
      ),
    ).toMatchObject({ ok: false, error: 'forbidden' });
    await people.olivia!.sync.ok(
      cmd('project_transfer', { projectId: project, userId: people.ed!.id }),
    );
    await people.olivia!.sync.run();
    await people.ed!.sync.run();
    expect(people.ed!.sync.projects.get(project)?.role).toBe('owner');
    expect(people.olivia!.sync.projects.get(project)?.role).toBe('admin');
    expect(await people.olivia!.sync.result(cmd('project_delete', { id: project }))).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    await people.olivia!.sync.ok(
      cmd('project_member_remove', { projectId: project, userId: people.olivia!.id }),
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)('sharing: invitations (security gate)', () => {
  it('direct invites look the same whether or not the person exists', async () => {
    await person('quinn', { email: 'quinn@example.com', verified: true });
    await person('uma', { email: 'uma@example.com', verified: false });
    const results = await Promise.all(
      [
        'quinn',
        'QUINN@example.com',
        'nobody',
        'nobody@example.com',
        'uma@example.com',
        'olivia',
      ].map((identifier) => invite(people.olivia!, project, { identifier, role: 'editor' })),
    );
    for (const r of results) expect(r).toEqual({ status: 202, body: { sent: true } });
    await people.quinn!.sync.run();
    await people.uma!.sync.run();
    expect(people.quinn!.sync.last.invitations).toEqual([
      expect.objectContaining({
        kind: 'project',
        targetId: project,
        name: 'Launch',
        role: 'editor',
        invitedBy: 'olivia',
      }),
    ]);
    // An unverified email doesn't count: it could belong to anyone.
    expect(people.uma!.sync.last.invitations).toEqual([]);
  });

  it('accepting a direct invite joins with the invite’s role; declining doesn’t', async () => {
    await invite(people.olivia!, project, { identifier: 'xavier', role: 'commenter' });
    await people.xavier!.sync.run();
    const pending = people.xavier!.sync.last.invitations[0]!;
    // Someone else can't accept it.
    expect(
      (
        await people.vic!.http.request({
          method: 'POST',
          url: `/api/v1/invites/${pending.id}/accept`,
        })
      ).statusCode,
    ).toBe(404);
    const res = await people.xavier!.http.request({
      method: 'POST',
      url: `/api/v1/invites/${pending.id}/accept`,
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    await people.xavier!.sync.run();
    expect(people.xavier!.sync.projects.get(project)?.role).toBe('commenter');
    expect(people.xavier!.sync.last.invitations).toEqual([]);
    expect(
      (
        await people.xavier!.http.request({
          method: 'POST',
          url: `/api/v1/invites/${pending.id}/accept`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('declined invites close', async () => {
    await invite(people.olivia!, project, { identifier: 'xavier', role: 'editor' });
    await people.xavier!.sync.run();
    const pending = people.xavier!.sync.last.invitations[0]!;
    expect(
      (
        await people.xavier!.http.request({
          method: 'POST',
          url: `/api/v1/invites/${pending.id}/decline`,
        })
      ).statusCode,
    ).toBe(204);
    await people.xavier!.sync.run();
    expect(people.xavier!.sync.projects.has(project)).toBe(false);
    expect(people.xavier!.sync.last.invitations).toEqual([]);
  });

  it('link tokens are single-use, revocable and expire', async () => {
    const { body } = await invite(people.olivia!, project, { role: 'viewer' });
    const token = body.token as string;
    expect(token).toMatch(/^[\w-]{43}$/);
    const [a, b] = await Promise.all([
      acceptLink(people.xavier!, token),
      acceptLink(people.xavier!, token),
    ]);
    expect([a, b].sort()).toEqual([200, 404]);

    const second = await invite(people.olivia!, project, { role: 'viewer' });
    const del = await people.olivia!.http.request({
      method: 'DELETE',
      url: `/api/v1/projects/${project}/invites/${second.body.id as string}`,
    });
    expect(del.statusCode).toBe(204);
    expect(await acceptLink(people.xavier!, second.body.token as string)).toBe(404);

    const third = await invite(people.olivia!, project, { role: 'viewer' });
    await t.db.db
      .update(projectInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(projectInvitations.id, third.body.id as string));
    expect(await acceptLink(people.xavier!, third.body.token as string)).toBe(404);
    expect(await acceptLink(people.xavier!, 'A'.repeat(43))).toBe(404);
  });

  it('stores only a hash of link tokens', async () => {
    const { body } = await invite(people.olivia!, project, { role: 'viewer' });
    const rows = await t.db.db.select().from(projectInvitations);
    expect(JSON.stringify(rows)).not.toContain(body.token as string);
  });

  it('never lowers an existing role through a link', async () => {
    const { body } = await invite(people.olivia!, project, { role: 'viewer' });
    expect(await acceptLink(people.ada!, body.token as string)).toBe(200);
    await people.ada!.sync.run();
    expect(people.ada!.sync.projects.get(project)?.role).toBe('admin');
  });

  it.each([
    ['ada', { role: 'editor' }, 201],
    ['ada', { role: 'admin' }, 403],
    ['olivia', { role: 'admin' }, 201],
    ['olivia', { role: 'owner' }, 400],
    ['ed', { role: 'viewer' }, 403],
    ['vic', { role: 'viewer' }, 403],
    ['xavier', { role: 'viewer' }, 404],
    ['olivia', { role: 'viewer', projectId: 'x' }, 400],
  ] as const)('%s creating %j → %i', async (who, body, status) => {
    expect((await invite(people[who]!, project, body)).status).toBe(status);
  });

  it('lists and revokes only for project admins', async () => {
    await invite(people.olivia!, project, { role: 'viewer' });
    const list = await people.ada!.http.request({
      method: 'GET',
      url: `/api/v1/projects/${project}/invites`,
    });
    expect(json(list.body).invites).toHaveLength(1);
    expect(list.body).not.toMatch(/token/i);
    expect(
      (await people.ed!.http.request({ method: 'GET', url: `/api/v1/projects/${project}/invites` }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await people.xavier!.http.request({
          method: 'GET',
          url: `/api/v1/projects/${project}/invites`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('refuses to share the inbox', async () => {
    const inbox = people.olivia!.sync.inbox;
    expect((await invite(people.olivia!, inbox, { role: 'viewer' })).status).toBe(400);
  });

  it('rate-limits invitation spam', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 55; i++)
      statuses.push(
        (await invite(people.olivia!, project, { identifier: `n${i}`, role: 'viewer' })).status,
      );
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('previews a link without consuming it', async () => {
    const { body } = await invite(people.olivia!, project, { role: 'editor' });
    const preview = await people.xavier!.http.request({
      method: 'POST',
      url: '/api/v1/invites/link/preview',
      payload: { token: body.token },
    });
    expect(json(preview.body)).toEqual({
      kind: 'project',
      name: 'Launch',
      role: 'editor',
      invitedBy: 'olivia',
      alreadyMember: false,
    });
    expect(await acceptLink(people.xavier!, body.token as string)).toBe(200);
  });
});
