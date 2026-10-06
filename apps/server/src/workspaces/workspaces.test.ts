import type { Role, WorkspaceRole } from '@bokydo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

let t: TestApp;
type Person = { sync: SyncUser; http: Client; id: string; name: string };
let people: Record<string, Person> = {};

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
  people[name] = { sync, http, id: userId, name };
  return people[name]!;
}

const json = (body: string) => JSON.parse(body) as Record<string, unknown>;

async function post(who: Person, url: string, payload: Record<string, unknown>) {
  const res = await who.http.request({ method: 'POST', url, payload });
  return { status: res.statusCode, body: res.body ? json(res.body) : {} };
}

/** Bring `who` into the workspace with `role` through a one-time link from its owner. */
async function join(ws: string, who: Person, role: Exclude<WorkspaceRole, 'owner'>) {
  const link = await post(people.olivia!, `/api/v1/workspaces/${ws}/invites`, { role });
  expect(link.status).toBe(201);
  const accepted = await post(who, '/api/v1/invites/link/accept', { token: link.body.token });
  expect(accepted).toMatchObject({ status: 200, body: { workspaceId: ws } });
  await who.sync.run();
}

/** Share a project directly with `who`. */
async function share(by: Person, projectId: string, who: Person, role: Exclude<Role, 'owner'>) {
  const link = await post(by, `/api/v1/projects/${projectId}/invites`, { role });
  expect(link.status).toBe(201);
  expect((await post(who, '/api/v1/invites/link/accept', { token: link.body.token })).status).toBe(
    200,
  );
}

const errorOf = (r: { ok: boolean } | undefined) =>
  r?.ok ? 'ok' : (r as { error: string } | undefined)?.error;
const roleIn = (who: string, projectId: string) =>
  people[who]!.sync.projects.get(projectId)?.role ?? null;
const syncAll = async () => {
  for (const p of Object.values(people)) await p.sync.run();
};

let ws: string;
let open: string; // visible to the workspace
let closed: string; // restricted to its members

beforeEach(async () => {
  t = await testApp();
  people = {};
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  for (const name of ['olivia', 'ada', 'meg', 'gus', 'xavier']) await person(name);
  ws = id();
  open = id();
  closed = id();
  await people.olivia!.sync.ok(
    cmd('workspace_add', { id: ws, name: 'Acme' }),
    cmd('project_add', { id: open, name: 'Roadmap', workspaceId: ws }),
    cmd('project_add', { id: closed, name: 'Salaries', workspaceId: ws, visibility: 'restricted' }),
  );
  await join(ws, people.ada!, 'admin');
  await join(ws, people.meg!, 'member');
  await join(ws, people.gus!, 'guest');
  await syncAll();
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('workspaces: access', () => {
  it('gives each role its implicit access to workspace-visible projects only', () => {
    expect(roleIn('olivia', open)).toBe('owner');
    expect(roleIn('ada', open)).toBe('admin');
    expect(roleIn('meg', open)).toBe('editor');
    expect(roleIn('gus', open)).toBeNull();
    expect(roleIn('xavier', open)).toBeNull();
    for (const who of ['ada', 'meg', 'gus', 'xavier']) expect(roleIn(who, closed)).toBeNull();
  });

  it('syncs the workspace to its members only, and hides the member list from guests', () => {
    expect(people.meg!.sync.last.workspaces).toEqual([{ id: ws, name: 'Acme', role: 'member' }]);
    expect(people.meg!.sync.last.workspaceMembers.map((m) => m.role).sort()).toEqual([
      'admin',
      'guest',
      'member',
      'owner',
    ]);
    expect(people.gus!.sync.last.workspaces).toEqual([{ id: ws, name: 'Acme', role: 'guest' }]);
    expect(people.gus!.sync.last.workspaceMembers).toEqual([
      { workspaceId: ws, userId: people.gus!.id, role: 'guest' },
    ]);
    expect(people.gus!.sync.last.collaborators.map((c) => c.username)).toEqual(['gus']);
    expect(people.xavier!.sync.last.workspaces).toEqual([]);
    expect(people.xavier!.sync.last.workspaceMembers).toEqual([]);
  });

  it('follows role changes in both directions', async () => {
    const set = (who: string, role: Exclude<WorkspaceRole, 'owner'>) =>
      people.olivia!.sync.ok(
        cmd('workspace_member_update', { workspaceId: ws, userId: people[who]!.id, role }),
      );
    await set('meg', 'guest');
    await set('gus', 'member');
    await set('ada', 'member');
    await syncAll();
    expect(roleIn('meg', open)).toBeNull();
    expect(roleIn('gus', open)).toBe('editor');
    expect(roleIn('ada', open)).toBe('editor');
    expect(people.meg!.sync.last.notifications[0]).toMatchObject({
      type: 'role_changed',
      data: { workspaceName: 'Acme', role: 'guest' },
    });
  });

  it('follows visibility changes, without touching direct shares', async () => {
    await share(people.olivia!, closed, people.gus!, 'viewer');
    await people.olivia!.sync.ok(cmd('project_update', { id: closed, visibility: 'workspace' }));
    await syncAll();
    expect(roleIn('meg', closed)).toBe('editor');
    expect(roleIn('ada', closed)).toBe('admin');
    expect(roleIn('gus', closed)).toBe('viewer'); // guest: direct share only
    await people.ada!.sync.ok(cmd('project_update', { id: closed, visibility: 'restricted' }));
    await syncAll();
    expect(roleIn('meg', closed)).toBeNull();
    expect(roleIn('ada', closed)).toBeNull();
    expect(roleIn('gus', closed)).toBe('viewer');
  });

  it('keeps an explicit role once set, and only removes it with the workspace', async () => {
    // An admin lowers Meg to viewer on one project: that's a direct share from now on.
    await people.ada!.sync.ok(
      cmd('project_member_update', { projectId: open, userId: people.meg!.id, role: 'viewer' }),
    );
    await people.olivia!.sync.ok(
      cmd('workspace_member_update', { workspaceId: ws, userId: people.meg!.id, role: 'admin' }),
    );
    await syncAll();
    expect(roleIn('meg', open)).toBe('viewer');
    // A workspace-granted row can't be removed per project…
    const r = await people.olivia!.sync.result(
      cmd('project_member_remove', { projectId: open, userId: people.ada!.id }),
    );
    expect(r).toMatchObject({ ok: false, error: 'forbidden' });
    // …but a direct one can, and the workspace grant comes back.
    await people.olivia!.sync.ok(
      cmd('project_member_remove', { projectId: open, userId: people.meg!.id }),
    );
    await people.meg!.sync.run();
    expect(roleIn('meg', open)).toBe('admin');
  });

  it('gives new workspace-visible projects to everyone at once', async () => {
    const p = id();
    await people.meg!.sync.ok(cmd('project_add', { id: p, name: 'Offsite', workspaceId: ws }));
    await syncAll();
    expect(roleIn('meg', p)).toBe('owner');
    expect(roleIn('olivia', p)).toBe('admin');
    expect(roleIn('ada', p)).toBe('admin');
    expect(roleIn('gus', p)).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('workspaces: permissions', () => {
  // [actor, command, expected]
  const cases: [string, () => ReturnType<typeof cmd>, string][] = [
    ['meg', () => cmd('workspace_update', { id: ws, name: 'X' }), 'forbidden'],
    ['ada', () => cmd('workspace_update', { id: ws, name: 'X' }), 'ok'],
    ['xavier', () => cmd('workspace_update', { id: ws, name: 'X' }), 'not_found'],
    ['ada', () => cmd('workspace_delete', { id: ws }), 'forbidden'],
    ['gus', () => cmd('project_add', { id: id(), name: 'X', workspaceId: ws }), 'forbidden'],
    ['xavier', () => cmd('project_add', { id: id(), name: 'X', workspaceId: ws }), 'not_found'],
    [
      'ada',
      () =>
        cmd('workspace_member_update', { workspaceId: ws, userId: people.meg!.id, role: 'admin' }),
      'forbidden',
    ],
    [
      'ada',
      () =>
        cmd('workspace_member_update', { workspaceId: ws, userId: people.gus!.id, role: 'member' }),
      'ok',
    ],
    [
      'meg',
      () =>
        cmd('workspace_member_update', { workspaceId: ws, userId: people.gus!.id, role: 'member' }),
      'forbidden',
    ],
    [
      'ada',
      () =>
        cmd('workspace_member_update', {
          workspaceId: ws,
          userId: people.olivia!.id,
          role: 'guest',
        }),
      'forbidden',
    ],
    [
      'olivia',
      () =>
        cmd('workspace_member_update', { workspaceId: ws, userId: people.meg!.id, role: 'owner' }),
      'invalid',
    ],
    [
      'ada',
      () => cmd('workspace_member_remove', { workspaceId: ws, userId: people.meg!.id }),
      'ok',
    ],
    [
      'meg',
      () => cmd('workspace_member_remove', { workspaceId: ws, userId: people.gus!.id }),
      'forbidden',
    ],
    [
      'olivia',
      () => cmd('workspace_member_remove', { workspaceId: ws, userId: people.olivia!.id }),
      'forbidden',
    ],
    [
      'ada',
      () => cmd('workspace_transfer', { workspaceId: ws, userId: people.ada!.id }),
      'forbidden',
    ],
    ['meg', () => cmd('folder_add', { id: id(), workspaceId: ws, name: 'X' }), 'forbidden'],
    ['ada', () => cmd('folder_add', { id: id(), workspaceId: ws, name: 'X' }), 'ok'],
    ['meg', () => cmd('project_update', { id: open, visibility: 'restricted' }), 'forbidden'],
    ['meg', () => cmd('project_move_workspace', { id: open, workspaceId: null }), 'forbidden'],
  ];
  it.each(cases)('%s: case %# → %s', async (actor, make, expected) => {
    expect(errorOf(await people[actor]!.sync.result(make()))).toBe(expected);
  });

  it('only lets admins invite, and only the owner invite admins', async () => {
    const url = `/api/v1/workspaces/${ws}/invites`;
    expect((await post(people.meg!, url, { role: 'member' })).status).toBe(403);
    expect((await post(people.xavier!, url, { role: 'member' })).status).toBe(404);
    expect((await post(people.ada!, url, { role: 'admin' })).status).toBe(403);
    expect((await post(people.ada!, url, { role: 'member' })).status).toBe(201);
    expect((await post(people.olivia!, url, { role: 'owner' })).status).toBe(400);
    const list = await people.meg!.http.request({ method: 'GET', url });
    expect(list.statusCode).toBe(403);
  });

  it('delivers direct invites through sync, and joins on accept', async () => {
    const r = await post(people.ada!, `/api/v1/workspaces/${ws}/invites`, {
      identifier: 'xavier',
      role: 'member',
    });
    expect(r.status).toBe(202);
    await people.xavier!.sync.run();
    const [inv] = people.xavier!.sync.last.invitations;
    expect(inv).toMatchObject({ kind: 'workspace', targetId: ws, name: 'Acme', role: 'member' });
    const accepted = await post(people.xavier!, `/api/v1/invites/${inv!.id}/accept`, {});
    expect(accepted.status).toBe(200);
    await people.xavier!.sync.run();
    expect(roleIn('xavier', open)).toBe('editor');
  });

  it('previews a workspace link without joining', async () => {
    const link = await post(people.olivia!, `/api/v1/workspaces/${ws}/invites`, { role: 'guest' });
    const preview = await post(people.xavier!, '/api/v1/invites/link/preview', {
      token: link.body.token,
    });
    expect(preview).toMatchObject({
      status: 200,
      body: { kind: 'workspace', name: 'Acme', role: 'guest', alreadyMember: false },
    });
    await people.xavier!.sync.run();
    expect(people.xavier!.sync.last.workspaces).toEqual([]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('workspaces: leaving and removal', () => {
  it('removes all access to its projects, hands over owned projects and unassigns', async () => {
    const megs = id();
    const task = id();
    await people.meg!.sync.ok(cmd('project_add', { id: megs, name: 'Meg’s', workspaceId: ws }));
    await share(people.olivia!, closed, people.meg!, 'editor');
    await people.olivia!.sync.ok(
      cmd('task_add', { id: task, projectId: open, content: 'Plan', assigneeId: people.meg!.id }),
    );
    await people.ada!.sync.ok(
      cmd('workspace_member_remove', { workspaceId: ws, userId: people.meg!.id }),
    );
    await syncAll();
    expect(roleIn('meg', open)).toBeNull();
    expect(roleIn('meg', closed)).toBeNull(); // the direct share goes too
    expect(roleIn('meg', megs)).toBeNull();
    expect(roleIn('olivia', megs)).toBe('owner');
    expect(people.olivia!.sync.tasks.get(task)?.assigneeId).toBeNull();
    expect(people.meg!.sync.last.workspaces).toEqual([]);
    expect(people.meg!.sync.last.notifications[0]).toMatchObject({
      type: 'removed_from_project',
      data: { workspaceName: 'Acme' },
    });
    expect(people.ada!.sync.last.workspaceMembers.map((m) => m.userId)).not.toContain(
      people.meg!.id,
    );
  });

  it('lets anyone but the owner leave', async () => {
    await people.gus!.sync.ok(
      cmd('workspace_member_remove', { workspaceId: ws, userId: people.gus!.id }),
    );
    await people.gus!.sync.run();
    expect(people.gus!.sync.last.workspaces).toEqual([]);
  });

  it('transfers ownership, keeping the old owner as an admin', async () => {
    await people.olivia!.sync.ok(
      cmd('workspace_transfer', { workspaceId: ws, userId: people.meg!.id }),
    );
    await syncAll();
    expect(people.meg!.sync.last.workspaces[0]?.role).toBe('owner');
    expect(people.olivia!.sync.last.workspaces[0]?.role).toBe('admin');
    expect(roleIn('meg', open)).toBe('admin');
    expect(errorOf(await people.olivia!.sync.result(cmd('workspace_delete', { id: ws })))).toBe(
      'forbidden',
    );
  });

  it('deletes its projects for everyone when the workspace is deleted', async () => {
    await people.olivia!.sync.ok(cmd('workspace_delete', { id: ws }));
    await syncAll();
    for (const who of ['olivia', 'ada', 'meg']) {
      expect(roleIn(who, open)).toBeNull();
      expect(people[who]!.sync.last.workspaces).toEqual([]);
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)('workspaces: moving projects and folders', () => {
  it('moves a personal project in as restricted, and back out without workspace access', async () => {
    const p = id();
    const sub = id();
    await people.olivia!.sync.ok(
      cmd('project_add', { id: p, name: 'Side' }),
      cmd('project_add', { id: sub, name: 'Side sub', parentId: p }),
    );
    await people.olivia!.sync.ok(cmd('project_move_workspace', { id: p, workspaceId: ws }));
    await syncAll();
    expect(people.olivia!.sync.projects.get(sub)).toMatchObject({
      workspaceId: ws,
      visibility: 'restricted',
    });
    expect(roleIn('meg', p)).toBeNull();
    await people.olivia!.sync.ok(cmd('project_update', { id: p, visibility: 'workspace' }));
    await syncAll();
    expect(roleIn('meg', p)).toBe('editor');
    await people.olivia!.sync.ok(cmd('project_move_workspace', { id: p, workspaceId: null }));
    await syncAll();
    expect(roleIn('meg', p)).toBeNull();
    expect(people.olivia!.sync.projects.get(p)).toMatchObject({
      workspaceId: null,
      visibility: 'restricted',
    });
  });

  it('keeps sub-projects in their parent’s workspace', async () => {
    const p = id();
    await people.olivia!.sync.ok(cmd('project_add', { id: p, name: 'Personal' }));
    const r = await people.olivia!.sync.result(
      cmd('project_add', { id: id(), name: 'X', parentId: open, workspaceId: null }),
    );
    expect(r).toMatchObject({ ok: false, error: 'invalid' });
    const sub = id();
    await people.olivia!.sync.ok(cmd('project_add', { id: sub, name: 'Sub', parentId: open }));
    await people.meg!.sync.run();
    expect(people.meg!.sync.projects.get(sub)).toMatchObject({ workspaceId: ws, role: 'editor' });
    expect(
      errorOf(await people.olivia!.sync.result(cmd('project_move', { id: sub, parentId: p }))),
    ).toBe('invalid');
    expect(
      errorOf(
        await people.olivia!.sync.result(
          cmd('project_move_workspace', { id: sub, workspaceId: null }),
        ),
      ),
    ).toBe('invalid');
    expect(
      errorOf(
        await people.olivia!.sync.result(cmd('project_update', { id: p, visibility: 'workspace' })),
      ),
    ).toBe('invalid');
  });

  it('files projects in folders of their own workspace only', async () => {
    const folder = id();
    const other = id();
    const elsewhere = id();
    await people.ada!.sync.ok(cmd('folder_add', { id: folder, workspaceId: ws, name: 'Ops' }));
    await people.xavier!.sync.ok(
      cmd('workspace_add', { id: other, name: 'Other' }),
      cmd('folder_add', { id: elsewhere, workspaceId: other, name: 'Theirs' }),
    );
    expect(
      errorOf(
        await people.olivia!.sync.result(cmd('project_update', { id: open, folderId: elsewhere })),
      ),
    ).toBe('invalid');
    await people.olivia!.sync.ok(cmd('project_update', { id: open, folderId: folder }));
    await people.meg!.sync.run();
    expect(people.meg!.sync.last.folders.map((f) => f.name)).toEqual(['Ops']);
    expect(people.meg!.sync.projects.get(open)?.folderId).toBe(folder);
    await people.ada!.sync.ok(cmd('folder_delete', { id: folder }));
    await people.meg!.sync.run();
    expect(people.meg!.sync.last.folders).toEqual([]);
    expect(people.meg!.sync.projects.get(open)?.folderId).toBeNull();
  });

  it('finds tasks by workspace in filters', async () => {
    await people.olivia!.sync.ok(
      cmd('task_add', { id: id(), projectId: open, content: 'Team thing' }),
      cmd('task_add', { id: id(), projectId: people.olivia!.sync.inbox, content: 'Mine' }),
    );
    const run = async (query: string) => {
      const res = await people.olivia!.http.request({
        method: 'GET',
        url: `/api/v1/tasks/filter?query=${encodeURIComponent(query)}`,
      });
      const body = json(res.body) as { lists: { tasks: { content: string }[] }[] };
      return body.lists[0]!.tasks.map((x) => x.content);
    };
    expect(await run('workspace: Acme')).toEqual(['Team thing']);
    expect(await run('workspace: My Projects')).toEqual(['Mine']);
  });
});
