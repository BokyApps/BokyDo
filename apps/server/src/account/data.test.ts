import { and, eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  habits,
  habitCheckIns,
  noteFiles,
  noteLinks,
  notes,
  noteTaskLinks,
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
import { deleteAccount } from './deletion.js';
import { buildExport } from './export.js';

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
  try {
    const out = execFileSync('python3', [
      '-c',
      'import zipfile,json,sys\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({n: z.read(n).decode("utf-8","replace") for n in z.namelist()}))',
      file,
    ]);
    return JSON.parse(out.toString()) as Record<string, string>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    const bobTask = id();
    await bob.sync.ok(
      cmd('project_add', { id: secret, name: 'Bob private' }),
      cmd('task_add', { id: bobTask, projectId: secret, content: 'bob-only secret' }),
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

    const habitId = id();
    await t.db.db.insert(habits).values([
      { id: habitId, ownerUserId: alice.id, name: 'Alice daily reading', period: 'day', target: 1 },
      { id: id(), ownerUserId: bob.id, name: 'Bob private habit', period: 'day', target: 1 },
    ]);
    await t.db.db.insert(habitCheckIns).values({ habitId, date: '2026-11-01' });

    // Notes, in every state. The censored span stays ciphertext in the body, as stored.
    const censorToken = `{{censored:v1:${'A'.repeat(22)}:${'B'.repeat(16)}:c2VjcmV0cGhyYXNl}}`;
    const activeNote = newId();
    const archivedNote = newId();
    const trashedNote = newId();
    const bobNote = newId();
    await t.db.db.insert(notes).values([
      {
        id: activeNote,
        ownerUserId: alice.id,
        title: 'Alice note',
        body: `Hello ${censorToken}`,
        tags: ['secret'],
      },
      {
        id: archivedNote,
        ownerUserId: alice.id,
        title: 'Archived note',
        body: 'Old but kept',
        state: 'archived',
      },
      {
        id: trashedNote,
        ownerUserId: alice.id,
        title: 'Trashed note',
        body: 'Gone but exported',
        trashedAt: new Date('2026-11-02T00:00:00Z'),
      },
      { id: bobNote, ownerUserId: bob.id, title: 'Bob private note', body: 'bob-only note' },
    ]);
    await t.db.db.insert(noteLinks).values({ fromNoteId: activeNote, toNoteId: archivedNote });
    // Bob's note is Bob's: a link *from* it, even to Alice's note, is not part of her export.
    await t.db.db.insert(noteLinks).values({ fromNoteId: bobNote, toNoteId: activeNote });
    await t.db.db
      .insert(noteTaskLinks)
      .values({ noteId: activeNote, taskId: done, source: 'manual' });
    await t.db.db
      .insert(noteTaskLinks)
      .values({ noteId: bobNote, taskId: bobTask, source: 'manual' });
    const noteFileId = newId();
    const noteFileStore = new AttachmentStore(t.dataDir, 'note-files');
    await noteFileStore.write(noteFileId, Readable.from([Buffer.from('note file bytes')]), 1024);
    await t.db.db.insert(noteFiles).values({
      id: noteFileId,
      noteId: activeNote,
      ownerUserId: alice.id,
      filename: '../../secret.txt',
      contentType: 'text/plain',
      size: 15,
      sha256: 'x'.repeat(64),
      referenced: true,
    });
    // Stale ownership: Bob's own note file, and an upload that never became ready. Neither may
    // be exported. (The schema's composite foreign key means a file row can never claim a note
    // owned by someone else, which is the stronger version of the same guarantee.)
    const foreignFile = newId();
    await noteFileStore.write(foreignFile, Readable.from([Buffer.from('bob file')]), 1024);
    await t.db.db.insert(noteFiles).values({
      id: foreignFile,
      noteId: bobNote,
      ownerUserId: bob.id,
      filename: 'bob-on-alice.txt',
      contentType: 'text/plain',
      size: 8,
      sha256: 'x'.repeat(64),
      referenced: true,
    });
    const uploadingFile = newId();
    await noteFileStore.write(
      uploadingFile,
      Readable.from([Buffer.from('uploading-bytes-should-not-export')]),
      1024,
    );
    await t.db.db.insert(noteFiles).values({
      id: uploadingFile,
      noteId: activeNote,
      ownerUserId: alice.id,
      filename: 'uploading.txt',
      contentType: 'application/octet-stream',
      size: 7,
      sha256: 'x'.repeat(64),
      status: 'uploading',
      referenced: false,
    });
    // Ready rows whose bytes are gone: metadata stays, the entry and a `missingFiles` line say so.
    const missingNoteFile = newId();
    await t.db.db.insert(noteFiles).values({
      id: missingNoteFile,
      noteId: activeNote,
      ownerUserId: alice.id,
      filename: 'gone.txt',
      contentType: 'text/plain',
      size: 4,
      sha256: 'x'.repeat(64),
      referenced: true,
    });
    const missingAttachment = newId();
    await t.db.db.insert(attachments).values({
      id: missingAttachment,
      projectId: mine,
      uploaderId: alice.id,
      filename: 'gone.bin',
      contentType: 'text/plain',
      size: 4,
      sha256: 'x'.repeat(64),
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
        `notes/files/${noteFileId}/secret.txt`,
      ]),
    );
    expect(names.every((n) => !n.includes('..') && !n.startsWith('/'))).toBe(true);
    expect(files[`attachments/${attachmentId}/etc_passwd`]).toBe('hello file');
    expect(files[`notes/files/${noteFileId}/secret.txt`]).toBe('note file bytes');
    expect(files['README.txt']).toContain('notes/files/');

    const data = JSON.parse(files['export.json'] ?? '{}') as {
      account: { username: string };
      habits: { id: string; name: string }[];
      habitCheckIns: { habitId: string; date: string }[];
      tasks: { content: string; isCompleted: boolean }[];
      projects: { name: string }[];
      personalAccessTokens: { name: string }[];
      notes: { id: string; title: string; body: string; state: string; trashedAt: string | null }[];
      noteLinks: { fromNoteId: string; toNoteId: string }[];
      noteTaskLinks: { noteId: string; taskId: string; source: string }[];
      noteFiles: { id: string; noteId: string; file: string }[];
      missingFiles: { id: string; reason: string }[];
    };
    expect(data.account.username).toBe('alice');
    expect(data.habits.map((h) => h.name)).toEqual(['Alice daily reading']);
    expect(data.habitCheckIns).toEqual([expect.objectContaining({ habitId, date: '2026-11-01' })]);
    expect(data.tasks.map((x) => x.content)).toEqual(
      expect.arrayContaining(['Long done', 'Bob task in shared']),
    );
    expect(data.projects.map((p) => p.name)).not.toContain('Bob private');
    expect(data.personalAccessTokens.map((p) => p.name)).toEqual(['n8n']);
    // Notes: all three states, the trashed one included, and the body exactly as stored — the
    // user's own censored ciphertext is theirs, so it stays verbatim.
    expect(data.notes.map((n) => n.title).sort()).toEqual([
      'Alice note',
      'Archived note',
      'Trashed note',
    ]);
    expect(data.notes.find((n) => n.id === activeNote)?.body).toBe(`Hello ${censorToken}`);
    // The stored state is kept alongside `trashedAt`: a trashed note is still stored as active.
    expect(data.notes.find((n) => n.id === trashedNote)).toMatchObject({
      state: 'active',
      trashedAt: '2026-11-02T00:00:00.000Z',
    });
    expect(data.notes.find((n) => n.id === archivedNote)?.state).toBe('archived');
    expect(data.noteLinks).toEqual([{ fromNoteId: activeNote, toNoteId: archivedNote }]);
    expect(data.noteTaskLinks).toEqual([{ noteId: activeNote, taskId: done, source: 'manual' }]);
    // Stale ownership, an in-progress upload and Bob's link are all out; a missing file keeps its
    // metadata in export.json but has no entry in the archive.
    expect(data.noteFiles.map((f) => f.id).sort()).toEqual([noteFileId, missingNoteFile].sort());
    expect(data.noteFiles.every((f) => f.id !== foreignFile && f.id !== uploadingFile)).toBe(true);
    expect(data.missingFiles).toEqual(
      expect.arrayContaining([
        { id: missingNoteFile, reason: 'missing' },
        { id: missingAttachment, reason: 'missing' },
      ]),
    );
    expect(data.missingFiles).toHaveLength(2);
    expect(names).not.toContain(`notes/files/${missingNoteFile}/gone.txt`);
    expect(names).not.toContain(`attachments/${missingAttachment}/gone.bin`);
    expect(names.some((n) => n.includes(foreignFile))).toBe(false);
    expect(names.some((n) => n.includes(uploadingFile))).toBe(false);
    const everything = JSON.stringify(files);
    for (const leak of [
      'bob-only secret',
      'Bob private habit',
      'bob-only note',
      'bob-on-alice',
      'bob file',
      'uploading-bytes-should-not-export',
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

  it('aborts the archive when a file read fails mid-stream', async () => {
    const project = id();
    await alice.sync.ok(cmd('project_add', { id: project, name: 'Files' }));
    const attachmentId = newId();
    await t.db.db.insert(attachments).values({
      id: attachmentId,
      projectId: project,
      uploaderId: alice.id,
      filename: 'hello.txt',
      contentType: 'text/plain',
      size: 16,
      sha256: 'x'.repeat(64),
    });
    // The row exists and its path stats, but reading it fails: a directory in place of the file
    // gives EISDIR on the first read, after the entry header has already gone out.
    await mkdir(path.join(t.dataDir, 'attachments', attachmentId), { recursive: true });

    const zip = buildExport(
      {
        db: t.db.db,
        sync: t.app.services.sync,
        store: new AttachmentStore(t.dataDir),
        noteFileStore: new AttachmentStore(t.dataDir, 'note-files'),
        tokens: t.app.services.apiTokens,
        publicUrl: null,
      },
      alice.id,
    );
    const error = await new Promise<Error | undefined>((resolve) => {
      zip.stream.on('data', () => undefined);
      zip.stream.on('error', (err: Error) => resolve(err));
      zip.stream.on('end', () => resolve(undefined));
    });
    // A broken download, not a valid ZIP with the file quietly missing.
    expect(error).toBeInstanceOf(Error);
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
    const habitId = id();
    await t.db.db.insert(habits).values({
      id: habitId,
      ownerUserId: alice.id,
      name: 'Private routine',
      period: 'day',
      target: 1,
    });
    await t.db.db.insert(habitCheckIns).values({ habitId, date: '2026-11-01' });
    // Note files are the user's own bytes outside the database; deletion must remove them now.
    const noteFileStore = new AttachmentStore(t.dataDir, 'note-files');
    const aliceNote = id();
    const aliceNoteFile = newId();
    await noteFileStore.write(aliceNoteFile, Readable.from([Buffer.from('alice note')]), 1024);
    await t.db.db
      .insert(notes)
      .values({ id: aliceNote, ownerUserId: alice.id, title: 'Private note' });
    await t.db.db.insert(noteFiles).values({
      id: aliceNoteFile,
      noteId: aliceNote,
      ownerUserId: alice.id,
      filename: 'private.txt',
      contentType: 'text/plain',
      size: 10,
      sha256: 'x'.repeat(64),
      referenced: true,
    });
    const bobNote = id();
    const bobNoteFile = newId();
    await noteFileStore.write(bobNoteFile, Readable.from([Buffer.from('bob note')]), 1024);
    await t.db.db.insert(notes).values({ id: bobNote, ownerUserId: bob.id, title: 'Bob note' });
    await t.db.db.insert(noteFiles).values({
      id: bobNoteFile,
      noteId: bobNote,
      ownerUserId: bob.id,
      filename: 'bob.txt',
      contentType: 'text/plain',
      size: 8,
      sha256: 'x'.repeat(64),
      referenced: true,
    });
    const bobCursor = (await bob.sync.run()).cursor;

    const res = await alice.http.post('/api/v1/account/delete', { confirm: 'alice' });
    expect(res.statusCode).toBe(204);

    expect(await t.db.db.select().from(users).where(eq(users.id, alice.id))).toEqual([]);
    expect(await t.db.db.select().from(habits).where(eq(habits.id, habitId))).toEqual([]);
    expect(
      await t.db.db.select().from(habitCheckIns).where(eq(habitCheckIns.habitId, habitId)),
    ).toEqual([]);
    // Notes and their files go at once, not with the hourly stray-file purge; Bob's stay.
    expect(await t.db.db.select().from(notes).where(eq(notes.id, aliceNote))).toEqual([]);
    expect(await t.db.db.select().from(noteFiles).where(eq(noteFiles.id, aliceNoteFile))).toEqual(
      [],
    );
    expect(existsSync(path.join(t.dataDir, 'note-files', aliceNoteFile))).toBe(false);
    expect(existsSync(path.join(t.dataDir, 'note-files', bobNoteFile))).toBe(true);
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

  it('does not fail deletion when a note file cannot be unlinked, and removes a stale .part', async () => {
    const noteId = id();
    const fileId = newId();
    await t.db.db.insert(notes).values({ id: noteId, ownerUserId: alice.id, title: 'Unlink' });
    await t.db.db.insert(noteFiles).values({
      id: fileId,
      noteId,
      ownerUserId: alice.id,
      filename: 'private.txt',
      contentType: 'text/plain',
      size: 4,
      sha256: 'x'.repeat(64),
      referenced: true,
    });
    const dir = path.join(t.dataDir, 'note-files');
    // A directory where the file should be makes unlink fail with EISDIR, which is not ENOENT.
    await mkdir(path.join(dir, fileId), { recursive: true });
    await writeFile(path.join(dir, `${fileId}.part`), 'left over');

    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const result = await deleteAccount(
      {
        db: t.db.db,
        sync: t.app.services.sync,
        noteFileStore: new AttachmentStore(t.dataDir, 'note-files'),
        log: { warn: (fields, message) => warnings.push({ fields, message }) },
      },
      alice.id,
      { userId: alice.id, ip: null },
    );

    expect(result).toEqual({ deleted: true });
    expect(await t.db.db.select().from(users).where(eq(users.id, alice.id))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields.fileId).toBe(fileId);
    // Only the error code is logged: the message would carry the absolute storage path.
    expect(warnings[0]?.fields.code).toBe('EISDIR');
    expect(JSON.stringify(warnings[0]?.fields)).not.toContain('/');
    expect(warnings[0]?.message).toContain('stray-file sweep');
    // The display filename is never logged, only the id.
    expect(JSON.stringify(warnings.map((warning) => warning.fields))).not.toContain('private.txt');
    expect(existsSync(path.join(dir, `${fileId}.part`))).toBe(false);
    expect(existsSync(path.join(dir, fileId))).toBe(true);
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
