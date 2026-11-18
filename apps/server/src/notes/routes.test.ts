import { randomUUID } from 'node:crypto';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../attachments/store.js';
import { noteFiles, noteLinks, noteTaskLinks, notes } from '../db/schema.js';
import { grantProjectAccess } from '../sync/membership.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id as newId, SyncUser } from '../test/sync.js';
import { purgeNotes } from './service.js';

let t: TestApp;
type Person = { id: string; http: Client; sync: SyncUser };

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 1),
]);
const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>');
const PDF = Buffer.from('%PDF-1.7\n% not an image\n');
const SALT = 'A'.repeat(22);
const IV = 'B'.repeat(16);
/** A syntactically valid v1 span; its ciphertext is not a word anyone could search for. */
const censorToken = (ciphertext = 'c2VjcmV0cGhyYXNl') =>
  `{{censored:v1:${SALT}:${IV}:${ciphertext}}}`;

async function person(username: string): Promise<Person> {
  const userId = await createUser(t.db, { username, password: 'x'.repeat(12) });
  const http = new Client(t.app);
  const { token, session } = await t.app.services.sessions.create(
    { id: userId, username, isAdmin: false, mustChangePassword: false },
    { ip: null, userAgent: null, authMethod: 'password' },
  );
  http.cookies.set('bokydo_session', token);
  http.csrfToken = session.csrfToken;
  const sync = new SyncUser(t.app.services.sync, userId);
  await sync.run();
  return { id: userId, http, sync };
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

async function createNote(
  who: Person,
  payload: Record<string, unknown> = {},
): Promise<{ status: number; note: Record<string, unknown>; body: Record<string, unknown> }> {
  const res = await who.http.post('/api/v1/notes', { title: 'Note', ...payload });
  const body = res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {};
  return { status: res.statusCode, note: (body.note ?? {}) as Record<string, unknown>, body };
}

async function listNotes(who: Person, query = '') {
  const res = await who.http.get(`/api/v1/notes${query}`);
  return { status: res.statusCode, ...(JSON.parse(res.body) as Record<string, unknown>) } as {
    status: number;
    notes: Record<string, unknown>[];
    nextCursor: string | null;
  };
}

async function upload(
  who: Person,
  noteId: string,
  body: Buffer,
  opts: { filename?: string; type?: string } = {},
) {
  const res = await who.http.request({
    method: 'POST',
    url: `/api/v1/notes/${noteId}/files`,
    headers: {
      'content-type': opts.type ?? 'application/octet-stream',
      'x-filename': encodeURIComponent(opts.filename ?? 'file.bin'),
    },
    payload: body,
  });
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}

const download = (who: Person, fileId: string, inline = false) =>
  who.http.request({
    method: 'GET',
    url: `/api/v1/note-files/${fileId}${inline ? '?inline=1' : ''}`,
  });

function ageFile(id: string, ms = 25 * 3600 * 1000) {
  return t.db.db
    .update(noteFiles)
    .set({ createdAt: new Date(Date.now() - ms) })
    .where(eq(noteFiles.id, id));
}

function ageUnreferenced(id: string, ms: number) {
  return t.db.db
    .update(noteFiles)
    .set({ unreferencedAt: new Date(Date.now() - ms) })
    .where(eq(noteFiles.id, id));
}

/** Replace the app so a test can inject route registration options. */
async function appWithQuota(quota: { bytes: number; count: number }): Promise<TestApp> {
  await t?.close();
  const next = await testApp({ noteUploadQuota: quota });
  await next.app.services.settings.markSetupComplete({ userId: null, ip: null });
  return next;
}

beforeEach(async () => {
  if (!TEST_DATABASE_URL) return;
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
});
afterEach(async () => t?.close());

describe.skipIf(!TEST_DATABASE_URL)('notes API', () => {
  it('creates, reads, updates, lists and deletes a note forever', async () => {
    const alice = await person('alice');
    const created = await createNote(alice, {
      title: 'First',
      body: 'Hello **world**',
      tags: ['Work'],
      pinned: true,
    });
    expect(created.status).toBe(201);
    expect(created.note).toMatchObject({
      title: 'First',
      body: 'Hello **world**',
      tags: ['work'],
      pinned: true,
      state: 'active',
      trashedAt: null,
      snippet: 'Hello world',
      backlinks: [],
      linkedTasks: [],
      files: [],
    });
    const id = created.note.id as string;

    const got = await alice.http.get(`/api/v1/notes/${id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().note.body).toBe('Hello **world**');

    const patched = await alice.http.patch(`/api/v1/notes/${id}`, {
      title: 'Second',
      body: 'New [body](https://example.com)',
      tags: [' Ideas '],
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().note).toMatchObject({
      title: 'Second',
      tags: ['ideas'],
      snippet: 'New body',
    });

    const listed = await listNotes(alice);
    expect(listed.notes).toHaveLength(1);
    expect(listed.notes[0]).toMatchObject({ id, title: 'Second', snippet: 'New body' });
    expect(listed.notes[0]!.body).toBeUndefined();

    expect((await alice.http.delete(`/api/v1/notes/${id}`)).statusCode).toBe(204);
    expect((await alice.http.get(`/api/v1/notes/${id}`)).statusCode).toBe(404);
    expect((await listNotes(alice)).notes).toEqual([]);
    expect(await t.db.db.select().from(notes)).toEqual([]);
  });

  it('makes stable-ID creates idempotent and rejects conflicting retries', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const id = randomUUID();
    const payload = { id, title: 'Retry', body: 'same', tags: ['One'] };
    const first = await createNote(alice, payload);
    expect(first.status).toBe(201);
    const retry = await createNote(alice, payload);
    expect(retry.status).toBe(200);
    expect(retry.note.id).toBe(id);
    expect((await createNote(alice, { ...payload, title: 'Changed' })).status).toBe(409);
    // Somebody else's stable ID is a conflict, never a hint that the ID is free.
    expect((await createNote(bob, payload)).status).toBe(409);
    expect((await createNote(bob, payload)).body).toEqual({ error: 'id_conflict' });
    expect((await listNotes(bob)).notes).toEqual([]);
  });

  it('keeps every resource owner-scoped', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const project = newId();
    const task = newId();
    await alice.sync.ok(
      cmd('project_add', { id: project, name: 'Private' }),
      cmd('task_add', { id: task, projectId: project, content: 'Alice task' }),
    );
    const aliceNote = await createNote(alice, {
      title: 'Alice note',
      body: `[task](bokydo:task/${task})`,
    });
    const noteId = aliceNote.note.id as string;
    const file = await upload(alice, noteId, PNG, { filename: 'a.png' });
    const fileId = file.body.id as string;

    expect((await bob.http.get(`/api/v1/notes/${noteId}`)).statusCode).toBe(404);
    expect((await bob.http.patch(`/api/v1/notes/${noteId}`, { title: 'x' })).statusCode).toBe(404);
    expect((await bob.http.delete(`/api/v1/notes/${noteId}`)).statusCode).toBe(404);
    expect((await bob.http.put(`/api/v1/notes/${noteId}/tasks/${task}`)).statusCode).toBe(404);
    expect((await bob.http.delete(`/api/v1/notes/${noteId}/tasks/${task}`)).statusCode).toBe(404);
    expect((await upload(bob, noteId, PNG)).status).toBe(404);
    expect((await download(bob, fileId)).statusCode).toBe(404);
    expect((await bob.http.get(`/api/v1/tasks/${task}/notes`)).statusCode).toBe(404);
    expect((await listNotes(bob)).notes).toEqual([]);
    expect((await bob.http.get('/api/v1/notes/tags')).json().tags).toEqual([]);

    // The owner still sees everything.
    expect((await download(alice, fileId)).statusCode).toBe(200);
    expect((await alice.http.get(`/api/v1/tasks/${task}/notes`)).json().notes).toMatchObject([
      { id: noteId },
    ]);
  });

  it('normalises tags and reports tag counts for live notes only', async () => {
    const alice = await person('alice');
    const first = await createNote(alice, { tags: [' Work ', 'work', 'Ideas'] });
    expect(first.note.tags).toEqual(['work', 'ideas']);
    const second = await createNote(alice, { tags: ['work'] });
    const trashed = await createNote(alice, { tags: ['work', 'secret'] });
    await alice.http.patch(`/api/v1/notes/${trashed.note.id as string}`, { trashed: true });
    const archived = await createNote(alice, { tags: ['work', 'old'] });
    await alice.http.patch(`/api/v1/notes/${archived.note.id as string}`, { state: 'archived' });

    for (const tags of [
      ['#bad'],
      ['a,b'],
      ['a b'],
      ['x'.repeat(51)],
      Array.from({ length: 21 }, (_, i) => `tag-${i}`),
    ])
      expect((await createNote(alice, { tags })).status).toBe(400);

    expect(
      (await alice.http.patch(`/api/v1/notes/${second.note.id as string}`, { tags: [' New '] }))
        .statusCode,
    ).toBe(200);
    expect((await alice.http.get('/api/v1/notes/tags')).json()).toEqual({
      tags: [
        { tag: 'ideas', count: 1 },
        { tag: 'new', count: 1 },
        { tag: 'old', count: 1 },
        { tag: 'work', count: 2 },
      ],
    });
    expect((await listNotes(alice, '?tag=ideas')).notes).toMatchObject([{ id: first.note.id }]);
    // Lists default to active notes, so the archived `work` note only shows up when asked for.
    expect((await listNotes(alice, '?tag=work')).notes).toHaveLength(1);
    expect((await listNotes(alice, '?tag=work&state=archived')).notes).toMatchObject([
      { id: archived.note.id },
    ]);
  });

  it('searches titles, tags and content, and never indexes censor tokens', async () => {
    const alice = await person('alice');
    const roadmap = await createNote(alice, {
      title: 'Quarterly Roadmap',
      body: 'The secret plans live here.',
      tags: ['planning'],
    });
    const groceries = await createNote(alice, {
      title: 'Groceries',
      body: 'milk and bread',
      tags: ['food'],
    });
    const censored = await createNote(alice, {
      title: 'Private',
      body: `Visible words ${censorToken()}`,
    });
    const percent = await createNote(alice, { title: 'Battery 100% charged' });

    const search = async (q: string) =>
      (await listNotes(alice, `?q=${encodeURIComponent(q)}`)).notes.map((n) => n.id);
    expect(await search('roadmap')).toEqual([roadmap.note.id]);
    expect(await search('secret')).toEqual([roadmap.note.id]);
    expect(await search('planning')).toEqual([roadmap.note.id]);
    expect(await search('milk')).toEqual([groceries.note.id]);
    expect(await search('food')).toEqual([groceries.note.id]);
    expect(await search('visible')).toEqual([censored.note.id]);
    expect(await search('c2VjcmV0cGhyYXNl')).toEqual([]);
    expect(await search(censorToken())).toEqual([]);
    // LIKE wildcards are literal, not a match-everything.
    expect(await search('%')).toEqual([percent.note.id]);
    expect(await search('100%')).toEqual([percent.note.id]);

    const [row] = await t.db.db
      .select({ searchText: notes.searchText })
      .from(notes)
      .where(eq(notes.id, censored.note.id as string));
    expect(row?.searchText).not.toContain('censored');
    expect(row?.searchText).not.toContain('c2VjcmV0');

    // Archived notes stay searchable within the archive; trashed ones only when asked for.
    await alice.http.patch(`/api/v1/notes/${roadmap.note.id as string}`, { state: 'archived' });
    expect(await search('roadmap')).toEqual([]);
    expect((await listNotes(alice, '?state=archived&q=roadmap')).notes).toMatchObject([
      { id: roadmap.note.id },
    ]);
    await alice.http.patch(`/api/v1/notes/${roadmap.note.id as string}`, { trashed: true });
    expect(await search('roadmap')).toEqual([]);
    expect((await listNotes(alice, '?state=trashed&q=roadmap')).notes).toMatchObject([
      { id: roadmap.note.id },
    ]);
  });

  it('pages pinned-first results without skipping or repeating', async () => {
    const alice = await person('alice');
    const a = await createNote(alice, { title: 'A' });
    const b = await createNote(alice, { title: 'B' });
    const c = await createNote(alice, { title: 'C' });
    await alice.http.patch(`/api/v1/notes/${b.note.id as string}`, { pinned: true });
    await t.db.db
      .update(notes)
      .set({ updatedAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(notes.id, a.note.id as string));
    await t.db.db
      .update(notes)
      .set({ updatedAt: new Date('2026-01-02T00:00:00Z') })
      .where(eq(notes.id, b.note.id as string));
    await t.db.db
      .update(notes)
      .set({ updatedAt: new Date('2026-01-03T00:00:00Z') })
      .where(eq(notes.id, c.note.id as string));

    const first = await listNotes(alice, '?limit=2');
    expect(first.notes.map((n) => n.id)).toEqual([b.note.id, c.note.id]);
    expect(first.nextCursor).toBeTruthy();
    const second = await listNotes(
      alice,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.notes.map((n) => n.id)).toEqual([a.note.id]);
    expect(second.nextCursor).toBeNull();
    // A supplied cursor must decode strictly: every one of these is a 400, never a silent first
    // page or a page from an instant the caller did not ask for.
    const decoded = JSON.parse(
      Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const rejected = [
      '', // supplied but empty
      'not-a-cursor',
      `${first.nextCursor}=`, // padded
      `${first.nextCursor}*`, // outside the base64url alphabet
      encode([decoded.p, decoded.u, decoded.i]), // not an object
      encode({ ...decoded, extra: true }), // a key a cursor never carries
      encode({ p: decoded.p, u: decoded.u }), // a missing key
      encode({ ...decoded, p: 'true' }), // wrong types
      encode({ ...decoded, i: 'not-a-uuid' }),
      ...['2026-01-02T00:00:00Z', '2026-01-02T00:00:00.000+00:00', 'not a date'].map((u) =>
        encode({ ...decoded, u }),
      ),
    ];
    for (const cursor of rejected) {
      const res = await listNotes(alice, `?cursor=${encodeURIComponent(cursor)}`);
      expect(res.status, cursor).toBe(400);
    }
  });

  it('archives, trashes, restores and deletes forever with its files', async () => {
    const alice = await person('alice');
    const created = await createNote(alice, { title: 'Lifecycle' });
    const id = created.note.id as string;
    const uploaded = await upload(alice, id, PNG, { filename: 'pic.png' });
    const fileId = uploaded.body.id as string;
    await alice.http.patch(`/api/v1/notes/${id}`, {
      body: `![pic](/api/v1/note-files/${fileId})`,
    });

    expect((await alice.http.patch(`/api/v1/notes/${id}`, { state: 'archived' })).statusCode).toBe(
      200,
    );
    expect((await listNotes(alice)).notes).toEqual([]);
    expect((await listNotes(alice, '?state=archived')).notes).toMatchObject([{ id }]);

    expect((await alice.http.patch(`/api/v1/notes/${id}`, { trashed: true })).statusCode).toBe(200);
    expect((await alice.http.get(`/api/v1/notes/${id}`)).json().note).toMatchObject({
      state: 'trashed',
    });
    expect((await listNotes(alice, '?state=archived')).notes).toEqual([]);
    expect((await listNotes(alice, '?state=trashed')).notes).toMatchObject([{ id }]);
    // No uploads or manual links against a trashed note.
    expect((await upload(alice, id, PNG)).status).toBe(404);

    expect((await alice.http.patch(`/api/v1/notes/${id}`, { trashed: false })).statusCode).toBe(
      200,
    );
    expect((await listNotes(alice, '?state=archived')).notes).toMatchObject([{ id }]);
    expect((await alice.http.patch(`/api/v1/notes/${id}`, { state: 'active' })).statusCode).toBe(
      200,
    );
    expect((await listNotes(alice)).notes).toMatchObject([{ id, state: 'active' }]);

    expect((await alice.http.delete(`/api/v1/notes/${id}`)).statusCode).toBe(204);
    expect(await readdir(path.join(t.dataDir, 'note-files'))).not.toContain(fileId);
    expect(await t.db.db.select().from(noteFiles)).toEqual([]);
  });

  it('stores backlinks only to live notes of the same owner', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const target = await createNote(alice, { title: 'Target' });
    const bobNote = await createNote(bob, { title: 'Bob note' });
    const targetId = target.note.id as string;
    const source = await createNote(alice, {
      title: 'Source',
      body: `[target](bokydo:note/${targetId}) and [bob](bokydo:note/${bobNote.note.id as string})`,
    });
    const sourceId = source.note.id as string;

    expect((await alice.http.get(`/api/v1/notes/${targetId}`)).json().note.backlinks).toEqual([
      { id: sourceId, title: 'Source' },
    ]);
    // Bob's note is not visible, so no row was stored for it.
    expect((await t.db.db.select().from(noteLinks)).map((row) => row.toNoteId)).toEqual([targetId]);
    expect(
      (await bob.http.get(`/api/v1/notes/${bobNote.note.id as string}`)).json().note.backlinks,
    ).toEqual([]);

    // Even a link row written straight into the table is not shown: the backlink query joins the
    // source note on (id, owner_user_id = caller), not on the id alone.
    const bobNoteId = bobNote.note.id as string;
    await t.db.db.insert(noteLinks).values({ fromNoteId: bobNoteId, toNoteId: targetId });
    const backlinks = (await alice.http.get(`/api/v1/notes/${targetId}`)).json().note.backlinks as {
      id: string;
    }[];
    expect(backlinks).toEqual([{ id: sourceId, title: 'Source' }]);
    expect(backlinks.map((link) => link.id)).not.toContain(bobNoteId);
    expect(
      (await bob.http.get(`/api/v1/notes/${targetId}`)).statusCode,
      'Bob cannot read Alice’s note at all',
    ).toBe(404);
    await t.db.db
      .delete(noteLinks)
      .where(and(eq(noteLinks.fromNoteId, bobNoteId), eq(noteLinks.toNoteId, targetId)));

    // A trashed target stops resolving, and starts again once restored.
    await alice.http.patch(`/api/v1/notes/${targetId}`, { trashed: true });
    await alice.http.patch(`/api/v1/notes/${sourceId}`, {
      body: `[target](bokydo:note/${targetId})`,
    });
    expect(await t.db.db.select().from(noteLinks)).toEqual([]);
    await alice.http.patch(`/api/v1/notes/${targetId}`, { trashed: false });
    await alice.http.patch(`/api/v1/notes/${sourceId}`, {
      body: `[target](bokydo:note/${targetId})`,
    });
    expect(await t.db.db.select().from(noteLinks)).toHaveLength(1);

    // A trashed source note is not shown as a backlink.
    await alice.http.patch(`/api/v1/notes/${sourceId}`, { trashed: true });
    expect((await alice.http.get(`/api/v1/notes/${targetId}`)).json().note.backlinks).toEqual([]);
  });

  it('links body tasks only while their project is visible, and hides them when access goes', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const shared = newId();
    const sharedTask = newId();
    const secret = newId();
    const secretTask = newId();
    await bob.sync.ok(
      cmd('project_add', { id: shared, name: 'Shared' }),
      cmd('task_add', { id: sharedTask, projectId: shared, content: 'Shared task' }),
      cmd('project_add', { id: secret, name: 'Secret' }),
      cmd('task_add', { id: secretTask, projectId: secret, content: 'Secret task' }),
    );
    await grantProjectAccess(t.db.db, shared, alice.id, 'editor');

    const created = await createNote(alice, {
      title: 'Links',
      body: `[shared](bokydo:task/${sharedTask}) [secret](bokydo:task/${secretTask})`,
    });
    const noteId = created.note.id as string;
    expect(created.note.linkedTasks).toMatchObject([
      { id: sharedTask, content: 'Shared task', projectId: shared, completed: false },
    ]);
    expect((await t.db.db.select().from(noteTaskLinks)).map((row) => row.taskId)).toEqual([
      sharedTask,
    ]);

    expect((await alice.http.get(`/api/v1/tasks/${sharedTask}/notes`)).json().notes).toMatchObject([
      { id: noteId },
    ]);
    // Bob can see the task but never Alice's note.
    expect((await bob.http.get(`/api/v1/tasks/${sharedTask}/notes`)).json().notes).toEqual([]);

    await bob.sync.ok(cmd('project_member_remove', { projectId: shared, userId: alice.id }));
    expect((await alice.http.get(`/api/v1/notes/${noteId}`)).json().note.linkedTasks).toEqual([]);
    expect((await alice.http.get(`/api/v1/tasks/${sharedTask}/notes`)).statusCode).toBe(404);
    // The stale row is harmless; listing joins current access. Clearing the body drops it.
    await alice.http.patch(`/api/v1/notes/${noteId}`, { body: 'no links' });
    expect(await t.db.db.select().from(noteTaskLinks)).toEqual([]);
  });

  it('adds and removes manual note-task links', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const project = newId();
    const task = newId();
    await alice.sync.ok(
      cmd('project_add', { id: project, name: 'Work' }),
      cmd('task_add', { id: task, projectId: project, content: 'Task' }),
    );
    const note = await createNote(alice, { title: 'Manual' });
    const noteId = note.note.id as string;

    expect((await alice.http.put(`/api/v1/notes/${noteId}/tasks/${task}`)).statusCode).toBe(204);
    expect((await alice.http.put(`/api/v1/notes/${noteId}/tasks/${task}`)).statusCode).toBe(204);
    expect((await alice.http.get(`/api/v1/notes/${noteId}`)).json().note.linkedTasks).toMatchObject(
      [{ id: task }],
    );
    const listed = await alice.http.get(`/api/v1/tasks/${task}/notes`);
    expect(listed.json().notes).toMatchObject([{ id: noteId, title: 'Manual' }]);

    // Someone else's note or an invisible task is a 404, never a link.
    expect((await bob.http.put(`/api/v1/notes/${noteId}/tasks/${task}`)).statusCode).toBe(404);
    const bobNote = await createNote(bob, { title: "Bob's" });
    expect(
      (await bob.http.put(`/api/v1/notes/${bobNote.note.id as string}/tasks/${task}`)).statusCode,
    ).toBe(404);

    expect((await alice.http.delete(`/api/v1/notes/${noteId}/tasks/${task}`)).statusCode).toBe(204);
    expect((await alice.http.get(`/api/v1/notes/${noteId}`)).json().note.linkedTasks).toEqual([]);
    expect((await alice.http.get(`/api/v1/tasks/${task}/notes`)).json().notes).toEqual([]);

    // A trashed note disappears from the task's list.
    await alice.http.put(`/api/v1/notes/${noteId}/tasks/${task}`);
    await alice.http.patch(`/api/v1/notes/${noteId}`, { trashed: true });
    expect((await alice.http.get(`/api/v1/tasks/${task}/notes`)).json().notes).toEqual([]);
  });

  it('uploads, sniffs and serves note files with attachment-grade headers', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const note = await createNote(alice, { title: 'Files' });
    const noteId = note.note.id as string;

    const uploaded = await upload(alice, noteId, PNG, { filename: 'shot one.png' });
    expect(uploaded).toMatchObject({
      status: 201,
      body: { filename: 'shot one.png', contentType: 'image/png', size: PNG.length },
    });
    const fileId = uploaded.body.id as string;
    expect((await alice.http.get(`/api/v1/notes/${noteId}`)).json().note.files).toEqual([
      { id: fileId, filename: 'shot one.png', contentType: 'image/png', size: PNG.length },
    ]);

    const inline = await download(alice, fileId, true);
    expect(inline.statusCode).toBe(200);
    expect(inline.rawPayload.equals(PNG)).toBe(true);
    expect(inline.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(PNG.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    expect(inline.headers['content-disposition']).toMatch(/^inline; /);
    expect((await download(alice, fileId)).headers['content-disposition']).toMatch(/^attachment; /);
    expect((await download(bob, fileId)).statusCode).toBe(404);
    expect((await download(alice, randomUUID())).statusCode).toBe(404);

    const html = await upload(alice, noteId, HTML, { filename: 'page.html' });
    expect(html.body.contentType).toBe('application/octet-stream');
    const htmlDownload = await download(alice, html.body.id as string, true);
    expect(htmlDownload.headers['content-type']).toBe('application/octet-stream');
    expect(htmlDownload.headers['content-disposition']).toMatch(/^attachment; /);

    // A PDF is not a raster image: downloaded as opaque bytes even when inline is requested.
    const pdf = await upload(alice, noteId, PDF, { filename: 'doc.pdf' });
    const pdfDownload = await download(alice, pdf.body.id as string, true);
    expect(pdfDownload.headers['content-type']).toBe('application/octet-stream');
    expect(pdfDownload.headers['content-disposition']).toMatch(/^attachment; /);
    expect(pdfDownload.rawPayload.equals(PDF)).toBe(true);
  });

  it('enforces upload size, emptiness, media type, the off switch and quotas', async () => {
    const alice = await person('alice');
    const note = await createNote(alice, { title: 'Limits' });
    const noteId = note.note.id as string;
    await t.app.services.settings.update(
      { 'attachments.maxSizeMb': 1 },
      { userId: null, ip: null },
    );
    expect((await upload(alice, noteId, Buffer.alloc(1024 * 1024 + 1))).status).toBe(413);
    expect((await upload(alice, noteId, Buffer.alloc(0))).status).toBe(400);
    for (const type of ['text/plain', 'application/json', 'multipart/form-data; boundary=x'])
      expect((await upload(alice, noteId, PNG, { type })).status).toBe(415);
    await t.app.services.settings.update(
      { 'attachments.maxSizeMb': 0 },
      { userId: null, ip: null },
    );
    expect((await upload(alice, noteId, PNG)).status).toBe(403);

    await t.app.services.settings.update(
      { 'attachments.maxSizeMb': 25 },
      { userId: null, ip: null },
    );
    const many = Array.from({ length: 2000 }, () => ({
      id: newId(),
      noteId,
      ownerUserId: alice.id,
      filename: 'x',
      contentType: 'application/octet-stream',
      size: 0,
      sha256: 'x',
    }));
    await t.db.db.insert(noteFiles).values(many);
    expect((await upload(alice, noteId, PNG)).body).toEqual({ error: 'limit_exceeded' });
    await t.db.db.delete(noteFiles).where(eq(noteFiles.noteId, noteId));
    await t.db.db.insert(noteFiles).values({
      id: newId(),
      noteId,
      ownerUserId: alice.id,
      filename: 'huge',
      contentType: 'application/octet-stream',
      size: 1024 * 1024 * 1024,
      sha256: 'x',
    });
    expect((await upload(alice, noteId, PNG)).status).toBe(429);
  });

  it('reserves quota before streaming, so one upload cannot cross it', async () => {
    t = await appWithQuota({ bytes: PNG.length - 1, count: 10 });
    const alice = await person('alice');
    const note = await createNote(alice, { title: 'Budget' });
    const noteId = note.note.id as string;
    const dir = path.join(t.dataDir, 'note-files');

    const tooBig = await upload(alice, noteId, PNG);
    expect(tooBig.status).toBe(413);
    expect(await t.db.db.select().from(noteFiles)).toEqual([]);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('removes the row and the bytes when upload finalization fails', async () => {
    const alice = await person('alice');
    const note = await createNote(alice, { title: 'Finalize' });
    const noteId = note.note.id as string;
    const dir = path.join(t.dataDir, 'note-files');
    // Inject the failure exactly where the route writes the final `ready` row.
    await t.db.sql.unsafe(`
      create function test_fail_note_file_ready() returns trigger language plpgsql as $$
      begin
        raise exception 'injected finalization failure';
      end $$;
      create trigger test_fail_note_file_ready before update on note_files
        for each row when (old.status = 'uploading' and new.status = 'ready')
        execute function test_fail_note_file_ready()`);
    try {
      const failed = await upload(alice, noteId, PNG);
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ error: 'internal_error' });
      // The fresh read finds the row still `uploading`, so no row and no bytes are kept.
      expect(await t.db.db.select().from(noteFiles)).toEqual([]);
      expect(await readdir(dir).catch(() => [])).toEqual([]);
    } finally {
      await t.db.sql.unsafe(`
        drop trigger if exists test_fail_note_file_ready on note_files;
        drop function if exists test_fail_note_file_ready()`);
    }
    // The same upload succeeds once finalization can write the row.
    const retried = await upload(alice, noteId, PNG);
    expect(retried.status).toBe(201);
    expect(await readdir(dir)).toEqual([retried.body.id]);
  });

  it('lets exactly one of two concurrent uploads take the last quota slot', async () => {
    t = await appWithQuota({ bytes: PNG.length + 40, count: 10 });
    const alice = await person('alice');
    const note = await createNote(alice, { title: 'Race' });
    const noteId = note.note.id as string;
    const [a, b] = await Promise.all([upload(alice, noteId, PNG), upload(alice, noteId, PNG)]);
    expect([a.status, b.status].filter((status) => status === 201)).toHaveLength(1);
    expect([a.status, b.status].filter((status) => status !== 201)).toHaveLength(1);
    const rows = await t.db.db.select().from(noteFiles);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ready');
    expect(await readdir(path.join(t.dataDir, 'note-files'))).toHaveLength(1);
  });

  it('rate-limits note uploads to 120 per hour per user', async () => {
    const alice = await person('alice');
    const note = await createNote(alice, { title: 'Rate' });
    const noteId = note.note.id as string;
    for (let i = 0; i < 120; i++)
      expect((await upload(alice, noteId, PNG, { filename: `f${i}.png` })).status).toBe(201);
    expect((await upload(alice, noteId, PNG)).body).toEqual({ error: 'rate_limited' });
  });

  it('claims links, and purges pending files, stale uploads and trashed notes', async () => {
    const alice = await person('alice');
    const project = newId();
    const task = newId();
    await alice.sync.ok(
      cmd('project_add', { id: project, name: 'Work' }),
      cmd('task_add', { id: task, projectId: project, content: 'Linked task' }),
    );
    const target = await createNote(alice, { title: 'Target' });
    const note = await createNote(alice, { title: 'Purge' });
    const noteId = note.note.id as string;

    // A referenced file survives even when it was uploaded long ago, and its links are stored.
    const kept = await upload(alice, noteId, PNG, { filename: 'kept.png' });
    const keptId = kept.body.id as string;
    expect(
      (
        await alice.http.patch(`/api/v1/notes/${noteId}`, {
          body: [
            `![kept](/api/v1/note-files/${keptId})`,
            `[target](bokydo:note/${target.note.id as string})`,
            `[task](bokydo:task/${task})`,
          ].join('\n'),
        })
      ).statusCode,
    ).toBe(200);
    expect(await t.db.db.select().from(noteLinks)).toHaveLength(1);
    expect(await t.db.db.select().from(noteTaskLinks)).toHaveLength(1);
    await ageFile(keptId, 48 * 3600 * 1000);
    await t.app.services.purgeNotes!();
    expect((await t.db.db.select().from(noteFiles)).map((row) => row.id)).toEqual([keptId]);
    expect(await readdir(path.join(t.dataDir, 'note-files'))).toContain(keptId);

    // Removing the reference starts the 24 h clock then, not at upload time: 23 h after the
    // removal the file is still there, even though it was uploaded 48 hours ago.
    expect(
      (await alice.http.patch(`/api/v1/notes/${noteId}`, { body: 'no links' })).statusCode,
    ).toBe(200);
    expect(await t.db.db.select().from(noteLinks)).toEqual([]);
    expect(await t.db.db.select().from(noteTaskLinks)).toEqual([]);
    await ageUnreferenced(keptId, 23 * 3600 * 1000);
    await t.app.services.purgeNotes!();
    expect((await t.db.db.select().from(noteFiles)).map((row) => row.id)).toEqual([keptId]);
    expect(await readdir(path.join(t.dataDir, 'note-files'))).toContain(keptId);

    await ageUnreferenced(keptId, 25 * 3600 * 1000);
    await t.app.services.purgeNotes!();
    expect(await t.db.db.select().from(noteFiles)).toEqual([]);
    expect(await readdir(path.join(t.dataDir, 'note-files'))).not.toContain(keptId);

    // A reservation whose client went away is gone after an hour, row, file and `.part`.
    const dir = path.join(t.dataDir, 'note-files');
    await mkdir(dir, { recursive: true });
    const staleId = newId();
    await writeFile(path.join(dir, staleId), 'stale');
    await writeFile(path.join(dir, `${staleId}.part`), 'partial');
    await t.db.db.insert(noteFiles).values({
      id: staleId,
      noteId,
      ownerUserId: alice.id,
      filename: 'stale',
      contentType: 'application/octet-stream',
      size: 5,
      sha256: 'x',
      status: 'uploading',
      createdAt: new Date(Date.now() - 2 * 3600 * 1000),
    });
    await t.app.services.purgeNotes!();
    expect(await readdir(dir)).not.toContain(staleId);
    expect(await readdir(dir)).not.toContain(`${staleId}.part`);

    // A note trashed for over 30 days, with its file and links, is purged; the link rows go too.
    const trashed = await createNote(alice, { title: 'Old trash' });
    const trashedId = trashed.note.id as string;
    const doomed = await upload(alice, trashedId, PNG, { filename: 'doomed.png' });
    const doomedId = doomed.body.id as string;
    await alice.http.patch(`/api/v1/notes/${trashedId}`, {
      body: [
        `![doomed](/api/v1/note-files/${doomedId})`,
        `[target](bokydo:note/${target.note.id as string})`,
        `[task](bokydo:task/${task})`,
      ].join('\n'),
    });
    expect(await t.db.db.select().from(noteLinks)).toHaveLength(1);
    expect(await t.db.db.select().from(noteTaskLinks)).toHaveLength(1);
    await alice.http.patch(`/api/v1/notes/${trashedId}`, { trashed: true });
    await t.db.db
      .update(notes)
      .set({ trashedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) })
      .where(eq(notes.id, trashedId));
    await t.app.services.purgeNotes!();
    expect((await t.db.db.select().from(notes)).map((row) => row.id)).not.toContain(trashedId);
    expect(await t.db.db.select().from(noteLinks)).toEqual([]);
    expect(await t.db.db.select().from(noteTaskLinks)).toEqual([]);
    expect(await readdir(dir)).not.toContain(doomedId);

    // Bytes with no row are removed once they are old enough; fresh ones are left alone.
    const stray = newId();
    const fresh = newId();
    await writeFile(path.join(dir, stray), 'stray');
    await writeFile(path.join(dir, fresh), 'fresh');
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    await utimes(path.join(dir, stray), old, old);
    await t.app.services.purgeNotes!();
    expect(await readdir(dir)).not.toContain(stray);
    expect(await readdir(dir)).toContain(fresh);
  });

  it('does not delete a note restored between the purge select and delete', async () => {
    const alice = await person('alice');
    const note = await createNote(alice, { title: 'Restored' });
    const noteId = note.note.id as string;
    const uploaded = await upload(alice, noteId, PNG, { filename: 'keep.png' });
    const fileId = uploaded.body.id as string;
    await alice.http.patch(`/api/v1/notes/${noteId}`, {
      body: `![keep](/api/v1/note-files/${fileId})`,
    });
    await alice.http.patch(`/api/v1/notes/${noteId}`, { trashed: true });
    await t.db.db
      .update(notes)
      .set({ trashedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) })
      .where(eq(notes.id, noteId));
    let selected = false;
    const store = new AttachmentStore(t.dataDir, 'note-files');
    await purgeNotes(t.db.db, store, new Date(), {
      afterTrashSelected: async (tx) => {
        selected = true;
        // The restore won the race: the row no longer matches the purge's predicate. Since the
        // files are only deleted for ids re-checked after this hook, the note keeps its bytes.
        await tx.update(notes).set({ trashedAt: null }).where(eq(notes.id, noteId));
      },
    });
    expect(selected).toBe(true);
    expect(
      (await t.db.db.select().from(notes).where(eq(notes.id, noteId))).map((n) => n.id),
    ).toEqual([noteId]);
    expect(
      (await t.db.db.select().from(noteFiles).where(eq(noteFiles.id, fileId))).map((f) => f.id),
    ).toEqual([fileId]);
    expect(await readdir(path.join(t.dataDir, 'note-files'))).toContain(fileId);
    expect((await download(alice, fileId)).statusCode).toBe(200);
  });

  it('refuses project-limited tokens and enforces the notes scopes', async () => {
    const alice = await person('alice');
    const project = newId();
    await alice.sync.ok(cmd('project_add', { id: project, name: 'P' }));
    const limited = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'limited',
      scopes: ['notes:read', 'notes:write'],
      expiresInDays: 1,
      projectIds: [project],
    });
    const limitedRead = await bearer(limited.token).get('/api/v1/notes');
    expect(limitedRead.statusCode).toBe(403);
    expect(limitedRead.json()).toEqual({ error: 'project_limited_token' });
    const limitedWrite = await bearer(limited.token).post('/api/v1/notes', { title: 'x' });
    expect(limitedWrite.statusCode).toBe(403);
    expect(limitedWrite.json()).toEqual({ error: 'project_limited_token' });

    const readOnly = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'read',
      scopes: ['notes:read'],
      expiresInDays: 1,
    });
    const read = await bearer(readOnly.token).get('/api/v1/notes');
    expect(read.statusCode).toBe(200);
    expect((await bearer(readOnly.token).post('/api/v1/notes', { title: 'x' })).statusCode).toBe(
      403,
    );

    const full = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'full',
      scopes: ['sync'],
      expiresInDays: 1,
    });
    expect(
      (await bearer(full.token).post('/api/v1/notes', { title: 'via token' })).statusCode,
    ).toBe(201);
  });

  it('holds back linked tasks and full notes from tokens without the read scopes', async () => {
    const alice = await person('alice');
    const project = newId();
    const task = newId();
    await alice.sync.ok(
      cmd('project_add', { id: project, name: 'P' }),
      cmd('task_add', { id: task, projectId: project, content: 'Task' }),
    );
    const note = await createNote(alice, {
      title: 'Linked',
      body: `[task](bokydo:task/${task})`,
    });
    const noteId = note.note.id as string;

    const withTasks = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'tasks',
      scopes: ['notes:read', 'notes:write', 'tasks:read'],
      expiresInDays: 1,
    });
    expect(
      (await bearer(withTasks.token).get(`/api/v1/notes/${noteId}`)).json().note.linkedTasks,
    ).toMatchObject([{ id: task }]);

    const notesOnly = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'notes',
      scopes: ['notes:read'],
      expiresInDays: 1,
    });
    expect(
      (await bearer(notesOnly.token).get(`/api/v1/notes/${noteId}`)).json().note.linkedTasks,
    ).toEqual([]);
    // It can still read the note itself.
    expect((await bearer(notesOnly.token).get(`/api/v1/notes/${noteId}`)).json().note.body).toBe(
      `[task](bokydo:task/${task})`,
    );

    // A write-only token gets only the identity of a note it may not read in full.
    const writeOnly = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'write',
      scopes: ['notes:write'],
      expiresInDays: 1,
    });
    const created = await bearer(writeOnly.token).post('/api/v1/notes', { title: 'Write only' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      note: { id: expect.any(String), updatedAt: expect.any(String) },
    });
    const createdId = created.json().note.id as string;
    const patched = await bearer(writeOnly.token).patch(`/api/v1/notes/${createdId}`, {
      title: 'Changed',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({
      note: { id: createdId, updatedAt: expect.any(String) },
    });

    // Listing a task's notes names the task, so that route needs tasks:read as well: a token with
    // notes:read alone is refused rather than told whether the task exists.
    const taskNotes = await bearer(notesOnly.token).get(`/api/v1/tasks/${task}/notes`);
    expect(taskNotes.statusCode).toBe(403);
    expect(taskNotes.json()).toEqual({ error: 'insufficient_scope' });
    expect(
      (await bearer(withTasks.token).get(`/api/v1/tasks/${task}/notes`)).json().notes,
    ).toMatchObject([{ id: noteId }]);

    // Linking a task tells the caller about task visibility, so a token must hold tasks:read even
    // when it holds the notes write scope the route itself asks for.
    const writer = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'writer',
      scopes: ['notes:write'],
      expiresInDays: 1,
    });
    const denied = await bearer(writer.token).put(`/api/v1/notes/${noteId}/tasks/${task}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'insufficient_scope' });
    expect(
      (await bearer(withTasks.token).put(`/api/v1/notes/${noteId}/tasks/${task}`)).statusCode,
    ).toBe(204);
  });

  it('allows notes-scoped tokens on the file routes and refuses project-limited ones', async () => {
    const alice = await person('alice');
    const project = newId();
    await alice.sync.ok(cmd('project_add', { id: project, name: 'P' }));
    const note = await createNote(alice, { title: 'Files' });
    const noteId = note.note.id as string;
    const notesToken = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'notes-files',
      scopes: ['notes:read', 'notes:write'],
      expiresInDays: 1,
    });
    const uploaded = await bearer(notesToken.token).request({
      method: 'POST',
      url: `/api/v1/notes/${noteId}/files`,
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'a.png' },
      payload: PNG,
    });
    expect(uploaded.statusCode).toBe(201);
    const fileId = uploaded.json().id as string;
    const fetched = await bearer(notesToken.token).get(`/api/v1/note-files/${fileId}`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.rawPayload.equals(PNG)).toBe(true);

    const limited = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'limited-files',
      scopes: ['notes:read', 'notes:write'],
      expiresInDays: 1,
      projectIds: [project],
    });
    const limitedUpload = await bearer(limited.token).request({
      method: 'POST',
      url: `/api/v1/notes/${noteId}/files`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: PNG,
    });
    expect(limitedUpload.statusCode).toBe(403);
    expect(limitedUpload.json()).toEqual({ error: 'project_limited_token' });
    const limitedDownload = await bearer(limited.token).get(`/api/v1/note-files/${fileId}`);
    expect(limitedDownload.statusCode).toBe(403);
    expect(limitedDownload.json()).toEqual({ error: 'project_limited_token' });
  });

  it('claims only the note’s own files, including the 600th reference', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const note = await createNote(alice, { title: 'Many files' });
    const other = await createNote(alice, { title: 'Other note' });
    const bobNote = await createNote(bob, { title: 'Bob note' });
    const noteId = note.note.id as string;
    const ids = Array.from({ length: 600 }, () => newId());
    const fileRow = (id: string, noteId: string, ownerUserId: string) => ({
      id,
      noteId,
      ownerUserId,
      filename: 'f',
      contentType: 'application/octet-stream',
      size: 0,
      sha256: 'x',
      status: 'ready' as const,
    });
    await t.db.db.insert(noteFiles).values(ids.map((id) => fileRow(id, noteId, alice.id)));
    const foreign = newId();
    const foreignOwner = newId();
    await t.db.db
      .insert(noteFiles)
      .values([
        fileRow(foreign, other.note.id as string, alice.id),
        fileRow(foreignOwner, bobNote.note.id as string, bob.id),
      ]);

    const body = [
      ...ids.map((id) => `![f](/api/v1/note-files/${id})`),
      `![x](/api/v1/note-files/${foreign})`,
      `![y](/api/v1/note-files/${foreignOwner})`,
    ].join('\n');
    expect((await alice.http.patch(`/api/v1/notes/${noteId}`, { body })).statusCode).toBe(200);

    const mine = await t.db.db.select().from(noteFiles).where(eq(noteFiles.noteId, noteId));
    expect(mine).toHaveLength(600);
    expect(mine.every((row) => row.referenced && row.unreferencedAt === null)).toBe(true);
    const theirs = await t.db.db
      .select()
      .from(noteFiles)
      .where(eq(noteFiles.noteId, other.note.id as string));
    expect(theirs.map((row) => ({ referenced: row.referenced }))).toEqual([{ referenced: false }]);
    const bobs = await t.db.db
      .select()
      .from(noteFiles)
      .where(eq(noteFiles.noteId, bobNote.note.id as string));
    expect(bobs.map((row) => row.referenced)).toEqual([false]);
  });

  it('rejects more than 1000 distinct note and task links in one body', async () => {
    const alice = await person('alice');
    const note = await createNote(alice, { title: 'Links' });
    const noteId = note.note.id as string;
    const write = (count: number) =>
      Array.from(
        { length: count },
        (_, i) => `[n](${(i % 2 ? 'bokydo:note/' : 'bokydo:task/') + newId()})`,
      ).join('\n');
    const atLimit = write(1000);
    expect((await alice.http.patch(`/api/v1/notes/${noteId}`, { body: atLimit })).statusCode).toBe(
      200,
    );
    const tooMany = await alice.http.patch(`/api/v1/notes/${noteId}`, { body: write(1001) });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json()).toEqual({ error: 'too_many_links' });
    // The rejected save rolled back: the body still holds the previous links.
    expect((await alice.http.get(`/api/v1/notes/${noteId}`)).json().note.body).toBe(atLimit);

    const created = await alice.http.post('/api/v1/notes', {
      title: 'Too many',
      body: write(1001),
    });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toEqual({ error: 'too_many_links' });
  });

  it('pages notes with equal updated_at without duplicates or misses', async () => {
    const alice = await person('alice');
    const created: string[] = [];
    for (let i = 0; i < 5; i++)
      created.push((await createNote(alice, { title: `Note ${i}` })).note.id as string);
    await t.db.db
      .update(notes)
      .set({ updatedAt: new Date('2026-06-01T12:00:00.000Z') })
      .where(eq(notes.ownerUserId, alice.id));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const listed = await listNotes(
        alice,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(listed.status).toBe(200);
      expect(listed.notes.length).toBeLessThanOrEqual(2);
      seen.push(...listed.notes.map((note) => note.id as string));
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual(created.sort());
  });

  it('hides soft-deleted tasks from note links in both directions', async () => {
    const alice = await person('alice');
    const project = newId();
    const task = newId();
    await alice.sync.ok(
      cmd('project_add', { id: project, name: 'P' }),
      cmd('task_add', { id: task, projectId: project, content: 'Doomed' }),
    );
    const note = await createNote(alice, {
      title: 'Linked',
      body: `[task](bokydo:task/${task})`,
    });
    const noteId = note.note.id as string;
    expect(note.note.linkedTasks).toMatchObject([{ id: task }]);
    expect((await alice.http.get(`/api/v1/tasks/${task}/notes`)).json().notes).toMatchObject([
      { id: noteId },
    ]);

    await alice.sync.ok(cmd('task_delete', { id: task }));
    expect((await alice.http.get(`/api/v1/notes/${noteId}`)).json().note.linkedTasks).toEqual([]);
    expect((await alice.http.get(`/api/v1/tasks/${task}/notes`)).statusCode).toBe(404);
    // Saving the same body again drops the now-invisible body link.
    expect(
      (await alice.http.patch(`/api/v1/notes/${noteId}`, { body: `[task](bokydo:task/${task})` }))
        .statusCode,
    ).toBe(200);
    expect(await t.db.db.select().from(noteTaskLinks)).toEqual([]);
  });

  it('accepts bodies at the 512 KiB limit, including JSON escaping and non-ASCII', async () => {
    const alice = await person('alice');
    const ascii = 'a'.repeat(512 * 1024);
    const atLimit = await createNote(alice, { title: 'Big', body: ascii });
    expect(atLimit.status).toBe(201);
    expect(atLimit.note.body).toBe(ascii);
    expect((await createNote(alice, { title: 'Too big', body: `${ascii}b` })).status).toBe(400);

    const emoji = '😀'.repeat((512 * 1024) / 4);
    expect((await createNote(alice, { title: 'Emoji', body: emoji })).status).toBe(201);
    expect((await createNote(alice, { title: 'Emoji+1', body: `${emoji}😀` })).status).toBe(400);

    const escaped = 'a"'.repeat(200_000);
    const withQuotes = await createNote(alice, { title: 'Quotes', body: escaped });
    expect(withQuotes.status).toBe(201);
    expect(withQuotes.note.body).toBe(escaped);

    // 512 KiB of control characters is ~3 MiB of JSON escapes: the route's own 6 MiB limit
    // lets it through to the decoded UTF-8 check.
    const controls = '\u0001'.repeat(512 * 1024);
    const controlBody = await createNote(alice, { title: 'Controls', body: controls });
    expect(controlBody.status).toBe(201);
    expect(controlBody.note.body).toBe(controls);
    expect(
      (await createNote(alice, { title: 'Controls+', body: `${controls}\u0001` })).status,
    ).toBe(400);

    expect((await createNote(alice, { title: 't'.repeat(201) })).status).toBe(400);
    expect((await createNote(alice, { title: 't'.repeat(200) })).status).toBe(201);
  });
});
