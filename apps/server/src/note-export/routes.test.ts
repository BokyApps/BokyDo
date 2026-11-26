import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../attachments/store.js';
import { noteFiles, notes } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id as newId, SyncUser } from '../test/sync.js';
import { ExportBusyError, runNoteExport } from './export.js';
import {
  ExportSemaphore,
  ExportTimeoutError,
  exportSemaphore,
  type ExportLimits,
} from './limits.js';
import { capOutputBytes, registerNoteExportRoutes } from './routes.js';
import type { NoteExportInternal } from './runner.js';
import { PNG_1X1, PNG_RGB, collect, makePng, readZipEntries, zipText } from './test-support.js';

let t: TestApp;
let store: AttachmentStore;
type Person = { id: string; http: Client };

const SALT = 'A'.repeat(22);
const IV = 'B'.repeat(16);
const CENSOR = `{{censored:v1:${SALT}:${IV}:c2VjcmV0cGhyYXNl}}`;
const CIPHERTEXT = 'c2VjcmV0cGhyYXNl';

beforeEach(async () => {
  t = await testApp({
    // The app registers the export route; the test only needs the same note-files directory.
    configureForTest: (_app, deps) => {
      store = new AttachmentStore(deps.dataDir, 'note-files');
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

/** A row without bytes on disk: the file was purged between the row and the export. */
async function addMissingFile(owner: Person, noteId: string, filename: string): Promise<string> {
  const id = randomUUID();
  await t.db.db.insert(noteFiles).values({
    id,
    noteId,
    ownerUserId: owner.id,
    filename,
    contentType: 'application/pdf',
    size: 1024,
    sha256: 'c'.repeat(64),
    status: 'ready',
    referenced: true,
  });
  return id;
}

function exportNote(who: Person | Client, id: string, format?: string) {
  const client = 'http' in who ? who.http : who;
  return client.get(`/api/v1/notes/${id}/export${format ? `?format=${format}` : ''}`);
}

/**
 * A bare Fastify app carrying only the export route, with the caller already "signed in". It is
 * how the runtime limits are tested: the route otherwise always runs with the production values.
 */
async function limitedApp(
  userId: string,
  limits: Partial<ExportLimits>,
  internal?: NoteExportInternal,
  memory?: { memoryLimitBytes?: () => number; rssBytes?: () => number },
): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('session', null);
  app.decorateRequest('token', null);
  app.addHook('onRequest', async (req) => {
    req.session = { user: { id: userId } } as never;
  });
  registerNoteExportRoutes(app, {
    db: t.db.db,
    store,
    limits,
    ...(internal ? { internal } : {}),
    ...(memory?.memoryLimitBytes ? { memoryLimitBytes: memory.memoryLimitBytes } : {}),
    ...(memory?.rssBytes ? { rssBytes: memory.rssBytes } : {}),
  });
  await app.ready();
  return app;
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

  it('redacts a censor token in the title and in a filename, in every format', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, {
      title: `Plan ${CENSOR}`,
      body: '',
    });
    const fileId = await addFile(alice, noteId, PNG_1X1, `shot ${CENSOR}.png`, 'image/png');
    await t.db.db
      .update(notes)
      .set({
        body: `![shot](/api/v1/note-files/${fileId}?inline=1)\n\n[shot](/api/v1/note-files/${fileId})\n`,
      })
      .where(eq(notes.id, noteId));

    for (const format of ['md', 'docx', 'pdf'] as const) {
      const response = await exportNote(alice, noteId, format);
      expect(response.statusCode).toBe(200);
      const header = response.headers['content-disposition'] ?? '';
      expect(header).not.toContain('censored');
      expect(header).not.toContain(SALT);
      const marker = "filename*=UTF-8''";
      const encoded = header.includes(marker)
        ? decodeURIComponent(header.slice(header.indexOf(marker) + marker.length))
        : '';
      expect(encoded).not.toContain('censored');
      expect(encoded).not.toContain(SALT);
      expect(encoded).not.toContain(CIPHERTEXT);
      if (format === 'md') {
        const entries = readZipEntries(response.rawPayload);
        const [markdownName, imageName] = [...entries.keys()];
        expect(markdownName).toBe('Plan █████.md');
        expect(imageName).toContain('shot █████.png');
        expect(imageName).not.toContain('censored');
        const markdown = zipText(response.rawPayload, markdownName ?? '');
        expect(markdown).toContain('# Plan █████');
        expect(markdown).not.toContain('censored');
        expect(markdown).not.toContain(CIPHERTEXT);
      } else if (format === 'docx') {
        for (const entry of readZipEntries(response.rawPayload).values()) {
          expect(entry.toString('latin1')).not.toContain('censored');
          expect(entry.toString('latin1')).not.toContain(SALT);
        }
        expect(zipText(response.rawPayload, 'docProps/core.xml')).toContain('Plan █████');
      } else {
        const raw = response.rawPayload.toString('latin1');
        expect(raw).not.toContain('censored');
        expect(raw).not.toContain(SALT);
        expect(raw).not.toContain(CIPHERTEXT);
        // The title is in the Info dictionary; pdfkit writes non-ASCII text as UTF-16 hex.
        expect(raw).toContain('/Title');
      }
    }
  });

  it('names a file whose bytes are gone and leaves it out of the zip', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, { title: 'Mixed', body: '' });
    const present = await addFile(alice, noteId, PNG_1X1, 'present.png', 'image/png');
    const gone = await addMissingFile(alice, noteId, 'gone.pdf');
    await t.db.db
      .update(notes)
      .set({
        body: `[present](/api/v1/note-files/${present})\n\n[gone](/api/v1/note-files/${gone})\n`,
      })
      .where(eq(notes.id, noteId));

    const response = await exportNote(alice, noteId, 'md');
    expect(response.statusCode).toBe(200);
    const entries = readZipEntries(response.rawPayload);
    const names = [...entries.keys()];
    expect(names).toContain(`files/${present}-present.png`);
    expect(names.some((name) => name.includes(gone))).toBe(false);
    const markdown = zipText(response.rawPayload, 'Mixed.md');
    expect(markdown).toContain('file unavailable: gone.pdf');
    expect(markdown).toContain(`[present](files/${present}-present.png)`);

    // When every referenced file is gone the export is a plain Markdown file, not an empty zip.
    const onlyGone = await createNote(alice, { title: 'Gone', body: '' });
    const goneToo = await addMissingFile(alice, onlyGone, 'gone.pdf');
    await t.db.db
      .update(notes)
      .set({ body: `[gone](/api/v1/note-files/${goneToo})\n` })
      .where(eq(notes.id, onlyGone));
    const plain = await exportNote(alice, onlyGone, 'md');
    expect(plain.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(plain.rawPayload.toString('utf8')).toContain('file unavailable: gone.pdf');
  });

  it('aborts the archive when a file read fails after its entry started', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, { title: 'Broken', body: '' });
    const fileId = await addFile(alice, noteId, PNG_1X1, 'shot.png', 'image/png');
    // The row and path are there, but a directory sits where the file was: `open` succeeds and
    // the first read gives EISDIR, after the entry header has already gone out.
    await rm(path.join(store.dir, fileId), { force: true });
    await mkdir(path.join(store.dir, fileId), { recursive: true });
    await t.db.db
      .update(notes)
      .set({ body: `[shot](/api/v1/note-files/${fileId})\n` })
      .where(eq(notes.id, noteId));

    const output = await runNoteExport(
      { db: t.db.db, store },
      { noteId, userId: alice.id, format: 'md' },
    );
    expect(output.extension).toBe('zip');
    if (typeof output.body === 'string') throw new Error('expected a zip stream');
    const error = await collect(output.body).then(
      () => null,
      (err: Error) => err,
    );
    output.done();
    // A broken download, not a valid ZIP with the file quietly missing.
    expect(error).toBeInstanceOf(Error);
  });

  it('writes a remote image as a link and only zips the note’s own images', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, { title: 'Pictures', body: '' });
    const own = await addFile(alice, noteId, PNG_1X1, 'own.png', 'image/png');
    await t.db.db
      .update(notes)
      .set({
        body: `![own](/api/v1/note-files/${own}?inline=1)\n\n![remote](https://example.com/x.png)\n`,
      })
      .where(eq(notes.id, noteId));

    const response = await exportNote(alice, noteId, 'md');
    const markdown = zipText(response.rawPayload, 'Pictures.md');
    expect(markdown).toContain(`![own](files/${own}-own.png)`);
    expect(markdown).toContain('[remote](https://example.com/x.png)');
    expect(markdown).not.toContain('![remote]');
  });

  it('sanitises archive paths for Windows and bounds each component', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, { title: 'Paths', body: '' });
    const fileId = await addFile(alice, noteId, PNG_1X1, 'C:\\temp\\CON. .png', 'image/png');
    await t.db.db
      .update(notes)
      .set({ body: `[x](/api/v1/note-files/${fileId})\n` })
      .where(eq(notes.id, noteId));
    const response = await exportNote(alice, noteId, 'md');
    const names = [...readZipEntries(response.rawPayload).keys()];
    const entry = names.find((name) => name.startsWith('files/')) ?? '';
    expect(entry).toMatch(/^files\/[0-9a-f-]{36}-/);
    // No drive designator, no backslash, and every component fits Windows' 200-byte budget.
    expect(entry).not.toContain(':');
    expect(entry).not.toContain('\\');
    for (const name of names)
      for (const part of name.split('/')) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(200);
  });

  it('renders every PNG class pdfkit would decode as text, without crashing', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, { title: 'Hostile images', body: '' });
    const hostile: [string, Buffer][] = [
      ['alpha', makePng({ colorType: 6 })],
      ['interlaced', makePng({ colorType: 2, interlace: 1 })],
      ['16-bit', makePng({ colorType: 2, bitDepth: 16 })],
      ['bad-crc', makePng({ colorType: 2, corruptIdatCrc: true })],
      ['transparent', makePng({ colorType: 2, transparency: true })],
    ];
    const blocks: string[] = [];
    for (const [name, bytes] of hostile) {
      const fileId = await addFile(alice, noteId, bytes, `${name}.png`, 'image/png');
      blocks.push(`![${name}](/api/v1/note-files/${fileId}?inline=1)`);
    }
    await t.db.db
      .update(notes)
      .set({ body: `${blocks.join('\n\n')}\n` })
      .where(eq(notes.id, noteId));

    // The process must survive a PDF that was handed all of them; the alpha class is the one
    // pdfkit decodes inside a zlib callback, where a throw would be uncaught.
    const pdf = await exportNote(alice, noteId, 'pdf');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.rawPayload.toString('latin1')).not.toContain('/Subtype /Image');

    // DOCX copies the original bytes, so the structurally valid ones are embedded and the
    // corrupt-CRC file (which Word might parse differently) is not.
    const docx = await exportNote(alice, noteId, 'docx');
    expect(docx.statusCode).toBe(200);
    const names = [...readZipEntries(docx.rawPayload).keys()];
    expect(names.filter((name) => name.startsWith('word/media/'))).toHaveLength(4);
  });

  it('embeds a valid RGB PNG in the PDF and the DOCX', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, { title: 'Picture', body: '' });
    const fileId = await addFile(alice, noteId, PNG_RGB, 'shot.png', 'image/png');
    await t.db.db
      .update(notes)
      .set({ body: `![shot](/api/v1/note-files/${fileId}?inline=1)\n` })
      .where(eq(notes.id, noteId));

    const pdf = await exportNote(alice, noteId, 'pdf');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.toString('latin1')).toContain('/Subtype /Image');

    const docx = await exportNote(alice, noteId, 'docx');
    expect(
      [...readZipEntries(docx.rawPayload).keys()].some((name) => name.startsWith('word/media/')),
    ).toBe(true);
  });

  it('answers 429 export_busy while this user already has an export running', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { body: 'Hello' });
    const release = exportSemaphore.tryAcquire(alice.id);
    expect(release).not.toBeNull();
    try {
      const response = await exportNote(alice, id);
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ error: 'export_busy' });
    } finally {
      release?.();
    }
    expect((await exportNote(alice, id)).statusCode).toBe(200);
  });

  it('answers 429 export_busy once one DOCX/PDF export is running in the process', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { body: 'Hello' });
    // DOCX/PDF are the heavy pool: one globally, whatever the user.
    const heavy = exportSemaphore.tryAcquire('u1', 'file');
    expect(heavy).not.toBeNull();
    try {
      expect((await exportNote(alice, id, 'pdf')).statusCode).toBe(429);
      expect((await exportNote(alice, id, 'docx')).statusCode).toBe(429);
      // Markdown is a separate pool, so it still runs (one per user is respected separately).
      expect((await exportNote(alice, id, 'md')).statusCode).toBe(200);
    } finally {
      heavy?.();
    }
  });

  it('allows two Markdown exports in the process but not a third', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { body: 'Hello' });
    const others = ['u1', 'u2'].map((name) => exportSemaphore.tryAcquire(name, 'markdown'));
    expect(others.every((release) => release !== null)).toBe(true);
    try {
      // Two Markdown exports are already running, so Alice's Markdown is refused…
      expect((await exportNote(alice, id, 'md')).statusCode).toBe(429);
      // …while the heavy pool is untouched.
      expect((await exportNote(alice, id, 'pdf')).statusCode).toBe(200);
    } finally {
      for (const release of others) release?.();
    }
  });

  it('answers 503 export_busy with Retry-After when the memory headroom is gone', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { body: 'Hello' });
    const lowMemory = await limitedApp(alice.id, {}, undefined, {
      // 400 MiB planned peak + 512 MiB RSS against an 800 MiB limit: 912 > 680.
      memoryLimitBytes: () => 800 * 1024 * 1024,
      rssBytes: () => 512 * 1024 * 1024,
    });
    try {
      const response = await lowMemory.inject({
        method: 'GET',
        url: `/api/v1/notes/${id}/export?format=pdf`,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'export_busy' });
      expect(response.headers['retry-after']).toBe('30');
    } finally {
      await lowMemory.close();
    }

    const roomy = await limitedApp(alice.id, {}, undefined, {
      memoryLimitBytes: () => 16 * 1024 * 1024 * 1024,
      rssBytes: () => 256 * 1024 * 1024,
    });
    try {
      const response = await roomy.inject({
        method: 'GET',
        url: `/api/v1/notes/${id}/export?format=pdf`,
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await roomy.close();
    }
  });

  it('applies the Windows device-name check to the Content-Disposition filename too', async () => {
    const alice = await person('alice');
    for (const [title, expected] of [
      ['CON', '_CON.md'],
      ['com¹', '_com¹.md'],
      ['ＣＯＮ', '_ＣＯＮ.md'],
    ] as const) {
      const id = await createNote(alice, { title, body: 'Hello' });
      const response = await exportNote(alice, id, 'md');
      expect(response.statusCode).toBe(200);
      const header = response.headers['content-disposition'] ?? '';
      const marker = "filename*=UTF-8''";
      const encoded = header.slice(header.indexOf(marker) + marker.length);
      expect(decodeURIComponent(encoded)).toBe(expected);
    }
  });

  it('holds the Markdown zip slot until the archive has been read', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, { title: 'Zip slot', body: '' });
    const fileId = await addFile(alice, noteId, PNG_1X1, 'shot.png', 'image/png');
    await t.db.db
      .update(notes)
      .set({ body: `[shot](/api/v1/note-files/${fileId})\n` })
      .where(eq(notes.id, noteId));

    const semaphore = new ExportSemaphore();
    const deps = { db: t.db.db, store, semaphore };
    const first = await runNoteExport(deps, { noteId, userId: alice.id, format: 'md' });
    if (typeof first.body === 'string') throw new Error('expected a zip stream');
    expect(semaphore.running).toBe(1);
    // The render worker has exited, but the archive has not been read: the slot is still held.
    const busy = await runNoteExport(deps, { noteId, userId: alice.id, format: 'md' }).then(
      () => null,
      (err: Error) => err,
    );
    expect(busy).toBeInstanceOf(ExportBusyError);

    await collect(first.body);
    // The zip's `end` released the slot, without the caller having to call `done()`.
    expect(semaphore.running).toBe(0);
    const next = await runNoteExport(deps, { noteId, userId: alice.id, format: 'md' });
    next.done();
    expect(semaphore.running).toBe(0);
  });

  it('destroys a stalled Markdown zip at the deadline and frees the slot', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, { title: 'Slow zip', body: '' });
    const fileId = await addFile(alice, noteId, PNG_1X1, 'shot.png', 'image/png');
    await t.db.db
      .update(notes)
      .set({ body: `[shot](/api/v1/note-files/${fileId})\n` })
      .where(eq(notes.id, noteId));

    const semaphore = new ExportSemaphore();
    const deps = { db: t.db.db, store, semaphore, limits: { deadlineMs: 2500 } };
    const output = await runNoteExport(deps, { noteId, userId: alice.id, format: 'md' });
    const body = output.body;
    if (typeof body === 'string') throw new Error('expected a zip stream');
    // Nobody reads the archive: the producer finishes writing into its buffer and waits. The
    // deadline timer aborts it and destroys the stream rather than leaving the slot held.
    const error = await new Promise<Error>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('zip was not aborted at the deadline')),
        6000,
      );
      body.once('error', (err: Error) => {
        clearTimeout(timer);
        resolve(err);
      });
    });
    expect(error).toBeInstanceOf(ExportTimeoutError);
    for (let attempt = 0; attempt < 100 && semaphore.running > 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(semaphore.running).toBe(0);
  });

  it('stops reading a Markdown zip’s files when the request disconnects', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, { title: 'Disconnect', body: '' });
    const fileId = await addFile(
      alice,
      noteId,
      Buffer.alloc(4 * 1024 * 1024, 0x61),
      'big.bin',
      'application/octet-stream',
    );
    await t.db.db
      .update(notes)
      .set({ body: `[big](/api/v1/note-files/${fileId})\n` })
      .where(eq(notes.id, noteId));

    const semaphore = new ExportSemaphore();
    const abort = new AbortController();
    let reads = 0;
    const output = await runNoteExport(
      {
        db: t.db.db,
        store,
        semaphore,
        internal: {
          onZipRead: () => {
            reads++;
            if (reads === 1) abort.abort(new Error('client went away'));
          },
        },
      },
      { noteId, userId: alice.id, format: 'md', signal: abort.signal },
    );
    if (typeof output.body === 'string') throw new Error('expected a zip stream');
    const error = await collect(output.body).then(
      () => null,
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(Error);
    // The first 64 KiB chunk was read; the abort stopped the remaining 4 MiB.
    expect(reads).toBe(1);
    for (let attempt = 0; attempt < 100 && semaphore.running > 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(semaphore.running).toBe(0);
  });

  it('answers 503 export_timeout when rendering runs past the deadline', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { title: 'Slow', body: '# One\n\nTwo\n' });
    const app = await limitedApp(alice.id, { deadlineMs: 0 });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/notes/${id}/export?format=pdf`,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'export_timeout' });
    } finally {
      await app.close();
    }
  });

  it('refuses a body over the token cap before building a document', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { body: '- a\n'.repeat(2_000) });
    const app = await limitedApp(alice.id, { maxTokens: 500 });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/notes/${id}/export` });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({ error: 'too_large' });
    } finally {
      await app.close();
    }
  });

  it('refuses a document with too many image placements or inline runs', async () => {
    const alice = await person('alice');
    const pictures = await createNote(alice, { title: 'Many', body: '' });
    const fileId = await addFile(alice, pictures, PNG_1X1, 'shot.png', 'image/png');
    const images = Array.from(
      { length: 3 },
      () => `![shot](/api/v1/note-files/${fileId}?inline=1)`,
    ).join('\n\n');
    await t.db.db
      .update(notes)
      .set({ body: `${images}\n` })
      .where(eq(notes.id, pictures));

    const runs = await createNote(alice, { title: 'Runs', body: '**a** *b* c\n' });

    for (const [noteId, limits] of [
      [pictures, { maxImagePlacements: 2 }],
      [runs, { maxInlineRuns: 2 }],
    ] as const) {
      const app = await limitedApp(alice.id, limits);
      try {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/notes/${noteId}/export?format=docx`,
        });
        expect(response.statusCode, JSON.stringify(limits)).toBe(413);
      } finally {
        await app.close();
      }
    }
  });

  it('aborts a streamed response that passes the byte cap', async () => {
    const source = Readable.from([Buffer.alloc(60, 0x61), Buffer.alloc(60, 0x61)]);
    const error = await collect(capOutputBytes(source, 100)).then(
      () => null,
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/exceeded 100 bytes/);
  });

  it('refuses a response that would pass the output byte cap', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { body: 'Hello there, this is a note body.\n' });
    const app = await limitedApp(alice.id, { maxOutputBytes: 8 });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/notes/${id}/export` });
      expect(response.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });

  it('does not percent-decode a title or filename into a live censor token', async () => {
    const alice = await person('alice');
    const noteId = await createNote(alice, {
      // Stored percent-encoded: decoding it after redaction would create the token again.
      title: `%7B%7Bcensored:v1:${SALT}:${IV}:${CIPHERTEXT}%7D%7D`,
      body: '',
    });
    const fileId = await addFile(alice, noteId, PNG_1X1, `shot ${CENSOR}.png`, 'image/png');
    await t.db.db
      .update(notes)
      .set({
        body: `![shot](/api/v1/note-files/${fileId}?inline=1)\n\n[shot](/api/v1/note-files/${fileId})\n`,
      })
      .where(eq(notes.id, noteId));

    const leaked = (text: string) =>
      text.includes('censored') || text.includes(SALT) || text.includes(CIPHERTEXT);
    for (const format of ['md', 'docx', 'pdf'] as const) {
      const response = await exportNote(alice, noteId, format);
      expect(response.statusCode).toBe(200);
      const header = response.headers['content-disposition'] ?? '';
      expect(header).not.toContain('censored');
      expect(header).not.toContain(SALT);
      const marker = "filename*=UTF-8''";
      const encoded = header.includes(marker)
        ? decodeURIComponent(header.slice(header.indexOf(marker) + marker.length))
        : '';
      expect(leaked(encoded)).toBe(false);
      if (format === 'md') {
        const entries = readZipEntries(response.rawPayload);
        for (const [name, body] of entries) {
          expect(leaked(name), name).toBe(false);
          expect(leaked(body.toString('utf8')), name).toBe(false);
        }
        // The title and filename become the placeholder, not the literal percent text.
        expect([...entries.keys()].some((name) => name.includes('█████'))).toBe(true);
      } else if (format === 'docx') {
        for (const entry of readZipEntries(response.rawPayload).values()) {
          expect(leaked(entry.toString('latin1'))).toBe(false);
        }
      } else {
        expect(leaked(response.rawPayload.toString('latin1'))).toBe(false);
      }
    }
  });

  it('answers a worker out-of-memory with 413 and lets the next export run', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { title: 'Big', body: 'Hello\n' });
    const app = await limitedApp(alice.id, {}, { testRenderer: 'oom' });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/notes/${id}/export?format=docx`,
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({ error: 'too_large' });
    } finally {
      await app.close();
    }
    expect(exportSemaphore.running).toBe(0);

    const again = await limitedApp(alice.id, {});
    try {
      const response = await again.inject({
        method: 'GET',
        url: `/api/v1/notes/${id}/export?format=pdf`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    } finally {
      await again.close();
    }
  });

  it('answers an unrelated worker failure with 500 internal_error, and survives', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { title: 'Broken', body: 'Hello\n' });
    const app = await limitedApp(alice.id, {}, { testRenderer: 'throw' });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/notes/${id}/export?format=docx`,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'internal_error' });
    } finally {
      await app.close();
    }
    expect(exportSemaphore.running).toBe(0);

    const again = await limitedApp(alice.id, {});
    try {
      expect(
        (await again.inject({ method: 'GET', url: `/api/v1/notes/${id}/export?format=md` }))
          .statusCode,
      ).toBe(200);
    } finally {
      await again.close();
    }
  });

  it('refuses a sparse-table bomb fast, without spawning a renderer', async () => {
    const alice = await person('alice');
    const row = `|${' |'.repeat(1800)}a|\n`;
    const id = await createNote(alice, { body: row.repeat(30) });
    const started = performance.now();
    const response = await exportNote(alice, id, 'pdf');
    const elapsed = performance.now() - started;
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: 'too_large' });
    expect(elapsed).toBeLessThan(2000);
  });

  it('refuses a 512 KiB list body without crashing, or renders it within the limits', async () => {
    const alice = await person('alice');
    const body = '- a\n'.repeat(131_072);
    expect(body.length).toBe(524_288);
    const id = await createNote(alice, { title: 'Huge list', body });
    const response = await exportNote(alice, id, 'docx');
    expect([200, 413]).toContain(response.statusCode);
    // The process is still serving after whatever the limits decided.
    expect((await exportNote(alice, await createNote(alice, { body: 'ok\n' }))).statusCode).toBe(
      200,
    );
  });

  it('kills the worker when the client disconnects before the first chunk', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { title: 'Slow start', body: 'Hello\n' });
    let exited!: () => void;
    const workerExited = new Promise<void>((resolve) => {
      exited = resolve;
    });
    // A 15 s deadline, far longer than this test: only the disconnect can end the worker.
    const app = await limitedApp(
      alice.id,
      { deadlineMs: 15_000 },
      { testRenderer: 'slow', onWorkerExit: exited },
    );
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const request = http.get(`http://127.0.0.1:${port}/api/v1/notes/${id}/export?format=pdf`);
      request.on('error', () => undefined);
      // The worker is spawned and parsing/rendering; no headers exist yet.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      request.destroy();
      await Promise.race([
        workerExited,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('worker did not exit after early disconnect')), 3000),
        ),
      ]);
      for (let attempt = 0; attempt < 100 && exportSemaphore.running > 0; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(exportSemaphore.running).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('kills the worker and frees the slot when the client disconnects mid-render', async () => {
    const alice = await person('alice');
    const id = await createNote(alice, { title: 'Slow', body: 'Hello\n' });
    let exited!: () => void;
    const workerExited = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const app = await limitedApp(
      alice.id,
      {},
      { testRenderer: 'slow-stream', onWorkerExit: exited },
    );
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/api/v1/notes/${id}/export?format=docx`,
          (res) => {
            // Headers are out, the worker is mid-render: drop the connection like a browser tab.
            res.destroy();
            resolve();
          },
        );
        req.on('error', reject);
        req.setTimeout(5000, () => reject(new Error('request timed out')));
      });
      await Promise.race([
        workerExited,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('worker did not exit after disconnect')), 5000),
        ),
      ]);
      for (let attempt = 0; attempt < 100 && exportSemaphore.running > 0; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(exportSemaphore.running).toBe(0);
    } finally {
      await app.close();
    }
  });
});
