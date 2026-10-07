import { and, eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../attachments/store.js';
import { newId } from '../db/ids.js';
import {
  attachments,
  auditLog,
  comments,
  projects,
  tasks,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import { grantProjectAccess } from '../sync/membership.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
let t: TestApp;
type Person = { id: string; http: Client; sync: SyncUser };
let alice: Person;
let bob: Person;

async function person(name: string, isAdmin = false): Promise<Person> {
  const userId = await createUser(t.db, { username: name, password: PASSWORD, isAdmin });
  const http = new Client(t.app);
  await http.login(name, PASSWORD);
  return { id: userId, http, sync: new SyncUser(t.app.services.sync, userId) };
}

/** Read a ZIP with Python's zipfile: an independent check that the archive is valid. */
async function unzip(body: Buffer): Promise<Record<string, string>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bokydo-zip-'));
  const file = path.join(dir, 'x.zip');
  await writeFile(file, body);
  const out = execFileSync('python3', [
    '-c',
    'import zipfile,json,sys\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({n: z.read(n).decode("utf-8","replace") for n in z.namelist()}))',
    file,
  ]);
  return JSON.parse(out.toString()) as Record<string, string>;
}

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  await createUser(t.db, { username: 'root', password: PASSWORD, isAdmin: true });
  alice = await person('alice');
  bob = await person('bob');
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('export everything', () => {
  it('needs a recent sign-in', async () => {
    await t.db.db.execute(`update sessions set reauthenticated_at = now() - interval '1 hour'`);
    expect((await alice.http.get('/api/v1/account/export')).json().error).toBe('reauth_required');
  });

  it('exports everything the user can see as a valid ZIP, and nothing secret', async () => {
    const mine = id();
    const done = id();
    await alice.sync.ok(
      cmd('project_add', { id: mine, name: 'Home' }),
      cmd('task_add', { id: id(), projectId: mine, content: '=HYPERLINK("http://evil","x")' }),
      cmd('task_add', { id: done, projectId: mine, content: 'Long done' }),
      cmd('task_complete', { id: done }),
    );
    // Completed long ago: outside the sync window, still in the export.
    await t.db.db
      .update(tasks)
      .set({ completedAt: new Date('2020-01-01') })
      .where(eq(tasks.id, done));
    const shared = id();
    await bob.sync.ok(
      cmd('project_add', { id: shared, name: 'Shared' }),
      cmd('task_add', { id: id(), projectId: shared, content: 'Bob task in shared' }),
    );
    await grantProjectAccess(t.db.db, shared, alice.id, 'editor');
    const secret = id();
    await bob.sync.ok(
      cmd('project_add', { id: secret, name: 'Bob private' }),
      cmd('task_add', { id: id(), projectId: secret, content: 'bob-only secret' }),
    );
    const attachmentId = newId();
    const store = new AttachmentStore(t.dataDir);
    await store.write(attachmentId, Readable.from([Buffer.from('hello file')]), 1024);
    await t.db.db.insert(attachments).values({
      id: attachmentId,
      projectId: mine,
      uploaderId: alice.id,
      filename: '../../etc/passwd',
      contentType: 'text/plain',
      size: 10,
      sha256: 'x'.repeat(64),
    });
    await alice.http.post('/api/v1/account/tokens', {
      name: 'n8n',
      scopes: ['sync'],
      expiresInDays: 1,
    });

    const res = await alice.http.request({ method: 'GET', url: '/api/v1/account/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="bokydo-export-\d{4}-\d\d-\d\d\.zip"$/,
    );
    const files = await unzip(res.rawPayload);
    const names = Object.keys(files);
    expect(names).toEqual(
      expect.arrayContaining([
        'README.txt',
        'export.json',
        'tasks.csv',
        `attachments/${attachmentId}/etc_passwd`,
      ]),
    );
    expect(names.every((n) => !n.includes('..') && !n.startsWith('/'))).toBe(true);
    expect(files[`attachments/${attachmentId}/etc_passwd`]).toBe('hello file');

    const data = JSON.parse(files['export.json'] ?? '{}') as {
      account: { username: string };
      tasks: { content: string; isCompleted: boolean }[];
      projects: { name: string }[];
      personalAccessTokens: { name: string }[];
    };
    expect(data.account.username).toBe('alice');
    expect(data.tasks.map((x) => x.content)).toEqual(
      expect.arrayContaining(['Long done', 'Bob task in shared']),
    );
    expect(data.projects.map((p) => p.name)).not.toContain('Bob private');
    expect(data.personalAccessTokens.map((p) => p.name)).toEqual(['n8n']);
    const everything = JSON.stringify(files);
    for (const leak of [
      'bob-only secret',
      '$argon2',
      'passwordHash',
      'bkd_pat_',
      'totpSecret',
      'csrf',
    ])
      expect(everything, leak).not.toContain(leak);
    // Spreadsheet-safe CSV.
    expect(files['tasks.csv']).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('account deletion', () => {
  it('is blocked while others rely on what the user owns, or for the last admin', async () => {
    const shared = id();
    await alice.sync.ok(cmd('project_add', { id: shared, name: 'Team plan' }));
    await grantProjectAccess(t.db.db, shared, bob.id, 'editor');
    const team = id();
    await alice.sync.ok(cmd('workspace_add', { id: team, name: 'Crew' }));
    await t.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: team, userId: bob.id, role: 'member' });

    const blockers = (await alice.http.get('/api/v1/account/deletion')).json();
    expect(blockers).toEqual({
      projects: [{ id: shared, name: 'Team plan' }],
      workspaces: [{ id: team, name: 'Crew' }],
      lastAdmin: false,
    });
    const res = await alice.http.post('/api/v1/account/delete', { confirm: 'alice' });
    expect(res.statusCode).toBe(409);

    const root = await person('root2', true);
    await t.db.db.update(users).set({ isAdmin: false }).where(eq(users.username, 'root'));
    expect((await root.http.get('/api/v1/account/deletion')).json().lastAdmin).toBe(true);
  });

  it('needs re-authentication and the username typed', async () => {
    expect((await alice.http.post('/api/v1/account/delete', { confirm: 'Alice' })).statusCode).toBe(
      400,
    );
    await t.db.db.execute(`update sessions set reauthenticated_at = now() - interval '1 hour'`);
    expect(
      (await alice.http.post('/api/v1/account/delete', { confirm: 'alice' })).json().error,
    ).toBe('reauth_required');
  });

  it('removes the account and its private data, and leaves shared work in place', async () => {
    const own = id();
    const ownTask = id();
    await alice.sync.ok(
      cmd('project_add', { id: own, name: 'Diary' }),
      cmd('task_add', { id: ownTask, projectId: own, content: 'private' }),
    );
    const shared = id();
    const bobTask = id();
    await bob.sync.ok(
      cmd('project_add', { id: shared, name: 'Shared' }),
      cmd('task_add', { id: bobTask, projectId: shared, content: 'for alice' }),
    );
    await grantProjectAccess(t.db.db, shared, alice.id, 'editor');
    const aliceInShared = id();
    const comment = id();
    await alice.sync.ok(
      cmd('task_add', { id: aliceInShared, projectId: shared, content: 'alice wrote this' }),
      cmd('comment_add', { id: comment, taskId: bobTask, content: 'on it' }),
    );
    await bob.sync.ok(cmd('task_update', { id: bobTask, assigneeId: alice.id }));
    // A team only Alice is in goes with her; Bob's busy team is untouched.
    const solo = id();
    await alice.sync.ok(cmd('workspace_add', { id: solo, name: 'Solo' }));
    const busy = id();
    await bob.sync.ok(cmd('workspace_add', { id: busy, name: 'Busy' }));
    const carol = await createUser(t.db, { username: 'carol', password: PASSWORD });
    await t.db.db
      .insert(workspaceMembers)
      .values({ workspaceId: busy, userId: carol, role: 'member' });
    await alice.http.post('/api/v1/account/tokens', {
      name: 'x',
      scopes: ['sync'],
      expiresInDays: 1,
    });
    const bobCursor = (await bob.sync.run()).cursor;

    const res = await alice.http.post('/api/v1/account/delete', { confirm: 'alice' });
    expect(res.statusCode).toBe(204);

    expect(await t.db.db.select().from(users).where(eq(users.id, alice.id))).toEqual([]);
    expect(await t.db.db.select().from(projects).where(eq(projects.id, own))).toEqual([]);
    expect(await t.db.db.select().from(tasks).where(eq(tasks.id, ownTask))).toEqual([]);
    const [kept] = await t.db.db.select().from(tasks).where(eq(tasks.id, aliceInShared));
    expect(kept).toMatchObject({ content: 'alice wrote this', createdById: null });
    const [note] = await t.db.db.select().from(comments).where(eq(comments.id, comment));
    expect(note).toMatchObject({ content: 'on it', userId: null });
    // Bob's devices learn that the assignment lapsed.
    const delta = await t.app.services.sync.sync(bob.id, { cursor: bobCursor });
    expect(delta.tasks.find((x) => x.id === bobTask)?.assigneeId).toBeNull();
    const teams = (await t.db.db.select({ name: workspaces.name }).from(workspaces)).map(
      (w) => w.name,
    );
    expect(teams).toEqual(['Busy']);
    // Signed out everywhere.
    expect((await alice.http.get('/api/v1/auth/session')).statusCode).toBe(401);
    const [entry] = await t.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'account.deleted'), eq(auditLog.targetId, alice.id)));
    expect(entry?.meta).toEqual({ by: 'self' });
  });

  it('lets an admin delete someone else, with the same checks', async () => {
    const root = await person('admin2', true);
    expect(
      (await root.http.post(`/api/v1/admin/users/${root.id}/delete`, { confirm: 'admin2' })).json()
        .message,
    ).toBe('use_account_deletion');
    expect(
      (await root.http.post(`/api/v1/admin/users/${bob.id}/delete`, { confirm: 'alice' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await root.http.post(`/api/v1/admin/users/${bob.id}/delete`, { confirm: 'bob' })).statusCode,
    ).toBe(204);
    expect(await t.db.db.select().from(users).where(eq(users.id, bob.id))).toEqual([]);
    expect(
      (await alice.http.post(`/api/v1/admin/users/${root.id}/delete`, { confirm: 'admin2' }))
        .statusCode,
    ).toBe(403);
  });
});
