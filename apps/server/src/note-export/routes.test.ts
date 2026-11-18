import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../attachments/store.js';
import { noteFiles, notes } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id as newId, SyncUser } from '../test/sync.js';
import { registerNoteExportRoutes } from './routes.js';
import { PNG_1X1, readZipEntries, zipText } from './test-support.js';

let t: TestApp;
let store: AttachmentStore;
type Person = { id: string; http: Client };

const SALT = 'A'.repeat(22);
const IV = 'B'.repeat(16);
const CENSOR = `{{censored:v1:${SALT}:${IV}:c2VjcmV0cGhyYXNl}}`;

beforeEach(async () => {
  t = await testApp({
    configureForTest: (app, deps) => {
      store = new AttachmentStore(deps.dataDir, 'note-files');
      registerNoteExportRoutes(app, { db: deps.db.db, store });
    },
  });
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
});
afterEach(async () => t.close());

async function person(username: string): Promise<Person> {
  const id = await createUser(t.db, { username, password: 'x'.repeat(12) });
  const http = new Client(t.app);
  const { token, session } = await t.app.services.sessions.create(
    { id, username, isAdmin: false, mustChangePassword: false },
    { ip: null, userAgent: null, authMethod: 'password' },
  );
  http.cookies.set('bokydo_session', token);
  http.csrfToken = session.csrfToken;
  return { id, http };
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
  owner: Person,
  payload: { title?: string; body?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await t.db.db.insert(notes).values({
    id,
    ownerUserId: owner.id,
    title: payload.title ?? 'Note',
    body: payload.body ?? '',
  });
  return id;
}

async function addFile(
  owner: Person,
  noteId: string,
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  const id = randomUUID();
  await mkdir(store.dir, { recursive: true });
  await writeFile(path.join(store.dir, id), bytes);
  await t.db.db.insert(noteFiles).values({
    id,
    noteId,
    ownerUserId: owner.id,
    filename,
    contentType,
    size: bytes.length,
    sha256: 'a'.repeat(64),
    status: 'ready',
    referenced: true,
  });
  return id;
}

function exportNote(who: Person | Client, id: string, format?: string) {
  const client = 'http' in who ? who.http : who;
  return client.get(`/api/v1/notes/${id}/export${format ? `?format=${format}` : ''}`);
}

describe.skipIf(!TEST_DATABASE_URL)('note export API', () => {
  it('exports Markdown by default, with the title and the censored placeholder', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, {
      title: 'Quarterly plan',
      body: `# Heading\n\nHello **world** and ${CENSOR}.\n`,
    });
    const response = await exportNote(alice, id);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(response.headers['content-disposition']).toContain('attachment; filename="note.md"');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    const body = response.rawPayload.toString('utf8');
    expect(body.startsWith('# Quarterly plan\n')).toBe(true);
    expect(body).toContain('Hello **world**');
    expect(body).toContain('█████');
    expect(body).not.toContain('censored');
  });

  it('exports a DOCX whose document part has the note text', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, {
      title: 'Plan',
      body: 'Hello **world**\n\n- one\n- two\n',
    });
    const response = await exportNote(alice, id, 'docx');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(response.headers['content-disposition']).toContain('filename="note.docx"');
    const xml = zipText(response.rawPayload, 'word/document.xml');
    expect(xml).toContain('Plan');
    expect(xml).toContain('Hello');
    expect(xml).toContain('world');
  });

  it('exports a PDF', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { title: 'Plan', body: 'Hello world\n' });
    const response = await exportNote(alice, id, 'pdf');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toContain('filename="note.pdf"');
    expect(response.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('never discloses another owner’s note, in any format', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const id = await createNote(alice, { title: 'Private', body: 'secret' });
    for (const format of ['md', 'docx', 'pdf']) {
      const response = await exportNote(bob, id, format);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('exports archived and trashed notes for their owner', async () => {
    const alice = await person('alice');
    const archived = await createNote(alice, { title: 'Archived', body: 'old' });
    await t.db.db.update(notes).set({ state: 'archived' }).where(eq(notes.id, archived));
    expect((await exportNote(alice, archived)).statusCode).toBe(200);
    const trashed = await createNote(alice, { title: 'Trash', body: 'gone' });
    await t.db.db.update(notes).set({ trashedAt: new Date() }).where(eq(notes.id, trashed));
    expect((await exportNote(alice, trashed)).statusCode).toBe(200);
  });

  it('refuses project-limited tokens and tokens without notes:read', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { title: 'Plan', body: 'Hello' });
    const sync = new SyncUser(t.app.services.sync, alice.id);
    await sync.run();
    const projectId = newId();
    await sync.ok(cmd('project_add', { id: projectId, name: 'P' }));
    const limited = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'limited',
      scopes: ['notes:read'],
      expiresInDays: 1,
      projectIds: [projectId],
    });
    const limitedResponse = await exportNote(bearer(limited.token), id);
    expect(limitedResponse.statusCode).toBe(403);
    expect(limitedResponse.json()).toEqual({ error: 'project_limited_token' });

    const wrongScope = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'tasks only',
      scopes: ['tasks:read'],
      expiresInDays: 1,
    });
    expect((await exportNote(bearer(wrongScope.token), id)).statusCode).toBe(403);

    const readOnly = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'notes read',
      scopes: ['notes:read'],
      expiresInDays: 1,
    });
    const allowed = await exportNote(bearer(readOnly.token), id);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['content-type']).toBe('text/markdown; charset=utf-8');
  });

  it('keeps a hostile title out of the header and the filename', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, {
      title: '../"evil"\r\nSet-Cookie: x=1',
      body: 'Hello',
    });
    const response = await exportNote(alice, id);
    expect(response.statusCode).toBe(200);
    const header = response.headers['content-disposition'] ?? '';
    expect(header).toContain('filename="note.md"');
    const encoded = header.slice(header.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length);
    expect(encoded).not.toMatch(/["\r\n']/);
    expect(decodeURIComponent(encoded)).toBe('_"evil" Set-Cookie: x=1.md');
    expect(decodeURIComponent(encoded)).not.toContain('/');
  });

  it('zips a note that references its own files, rewriting the links', async () => {
    const alice = await person('alice');
    const noteId = randomUUID();
    const fileId = randomUUID();
    await t.db.db.insert(notes).values({
      id: noteId,
      ownerUserId: alice.id,
      title: 'Files',
      body: `[doc.pdf](/api/v1/note-files/${fileId})\n\n![shot](/api/v1/note-files/${fileId}?inline=1)\n`,
    });
    await mkdir(store.dir, { recursive: true });
    await writeFile(path.join(store.dir, fileId), PNG_1X1);
    await t.db.db.insert(noteFiles).values({
      id: fileId,
      noteId,
      ownerUserId: alice.id,
      filename: 'shot.png',
      contentType: 'image/png',
      size: PNG_1X1.length,
      sha256: 'b'.repeat(64),
      status: 'ready',
      referenced: true,
    });

    const response = await exportNote(alice, noteId, 'md');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toContain('filename="note.zip"');
    const entries = readZipEntries(response.rawPayload);
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining(['Files.md', `files/${fileId}-shot.png`]),
    );
    const markdown = zipText(response.rawPayload, 'Files.md');
    expect(markdown).toContain(`[doc.pdf](files/${fileId}-shot.png)`);
    expect(markdown).toContain(`![shot](files/${fileId}-shot.png)`);
    expect(markdown).not.toContain('/api/v1/note-files/');
  });

  it('does not zip a link to another note’s file', async () => {
    const alice = await person('alice');
    const other = await createNote(alice, { title: 'Other', body: '' });
    const fileId = await addFile(alice, other, PNG_1X1, 'shot.png', 'image/png');
    const noteId = await createNote(alice, {
      title: 'Borrowed',
      body: `![shot](/api/v1/note-files/${fileId}?inline=1)\n`,
    });
    const response = await exportNote(alice, noteId, 'md');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(response.rawPayload.toString('utf8')).toContain('[image: shot]');
  });

  it('refuses a note with more blocks than the export limit', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { body: 'a\n\n'.repeat(50_001) });
    const response = await exportNote(alice, id);
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: 'too_large' });
  });

  it('rejects an unknown format and a malformed id', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { body: 'Hello' });
    expect((await exportNote(alice, id, 'html')).statusCode).toBe(400);
    expect((await exportNote(alice, 'not-a-uuid')).statusCode).toBe(400);
  });
});
