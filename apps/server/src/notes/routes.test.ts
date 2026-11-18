import { randomUUID } from 'node:crypto';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noteFiles, noteLinks, noteTaskLinks, notes } from '../db/schema.js';
import { grantProjectAccess } from '../sync/membership.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id as newId, SyncUser } from '../test/sync.js';

let t: TestApp;
type Person = { id: string; http: Client; sync: SyncUser };

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 1),
]);
const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>');
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
    // Somebody else's stable ID is not usable.
    expect((await createNote(bob, payload)).status).toBe(404);
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
    expect((await listNotes(alice, '?cursor=not-a-cursor')).status).toBe(400);
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

  it('rate-limits note uploads to 120 per hour per user', async () => {
    const alice = await person('alice');
    const note = await createNote(alice, { title: 'Rate' });
    const noteId = note.note.id as string;
    for (let i = 0; i < 120; i++)
      expect((await upload(alice, noteId, PNG, { filename: `f${i}.png` })).status).toBe(201);
    expect((await upload(alice, noteId, PNG)).body).toEqual({ error: 'rate_limited' });
  });

  it('marks files referenced by the body and purges pending, trashed and stray files', async () => {
    const alice = await person('alice');
    const note = await createNote(alice, { title: 'Purge' });
    const noteId = note.note.id as string;
    const pending = await upload(alice, noteId, PNG, { filename: 'pending.png' });
    const pendingId = pending.body.id as string;

    // Pending for 25 hours: gone from the row table and from disk.
    await ageFile(pendingId);
    await t.app.services.purgeNotes!();
    expect(await t.db.db.select().from(noteFiles)).toEqual([]);
    expect(await readdir(path.join(t.dataDir, 'note-files'))).not.toContain(pendingId);

    // Referenced files survive even when old.
    const kept = await upload(alice, noteId, PNG, { filename: 'kept.png' });
    const keptId = kept.body.id as string;
    await alice.http.patch(`/api/v1/notes/${noteId}`, {
      body: `![kept](/api/v1/note-files/${keptId})`,
    });
    await ageFile(keptId);
    await t.app.services.purgeNotes!();
    expect((await t.db.db.select().from(noteFiles)).map((row) => row.id)).toEqual([keptId]);
    expect(await readdir(path.join(t.dataDir, 'note-files'))).toContain(keptId);

    // A note trashed for over 30 days, with its file and links, is purged.
    const trashed = await createNote(alice, { title: 'Old trash' });
    const trashedId = trashed.note.id as string;
    const doomed = await upload(alice, trashedId, PNG, { filename: 'doomed.png' });
    const doomedId = doomed.body.id as string;
    await alice.http.patch(`/api/v1/notes/${trashedId}`, {
      body: `![doomed](/api/v1/note-files/${doomedId})`,
    });
    await alice.http.patch(`/api/v1/notes/${trashedId}`, { trashed: true });
    await t.db.db
      .update(notes)
      .set({ trashedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) })
      .where(eq(notes.id, trashedId));
    await t.app.services.purgeNotes!();
    expect((await t.db.db.select().from(notes)).map((row) => row.id)).not.toContain(trashedId);
    expect(await readdir(path.join(t.dataDir, 'note-files'))).not.toContain(doomedId);

    // Bytes with no row are removed once they are old enough; fresh ones are left alone.
    const dir = path.join(t.dataDir, 'note-files');
    await mkdir(dir, { recursive: true });
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

    expect((await createNote(alice, { title: 't'.repeat(201) })).status).toBe(400);
    expect((await createNote(alice, { title: 't'.repeat(200) })).status).toBe(201);
  });
});
