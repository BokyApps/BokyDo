import type { ApiScope } from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../db/ids.js';
import { notes, oauthClients, oauthGrants } from '../db/schema.js';
import { createUser, TEST_HOST, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

const BASE = 'https://tasks.example.com';
/** A syntactically valid v1 span; its ciphertext is not a word anyone could search for. */
const censorToken = `{{censored:v1:${'A'.repeat(22)}:${'B'.repeat(16)}:c2VjcmV0cGhyYXNl}}`;
let t: TestApp;
let alice: string;
let bob: string;
let limitedProject: string;
let taskId: string;
let seq = 0;

async function token(userId: string, scopes: ApiScope[], projectIds: string[] | null = null) {
  return (
    await t.app.services.apiTokens.createPat(userId, {
      name: 'note-test',
      scopes,
      projectIds,
      expiresInDays: 1,
    })
  ).token;
}

async function oauthToken(userId: string, scopes: ApiScope[]) {
  const clientId = `bkdc_${'c'.repeat(22)}`;
  await t.db.db
    .insert(oauthClients)
    .values({
      id: clientId,
      name: 'note client',
      redirectUris: ['https://client.example/callback'],
      registeredVia: 'dynamic',
    })
    .onConflictDoNothing();
  const grantId = newId();
  await t.db.db
    .insert(oauthGrants)
    .values({ id: grantId, clientId, userId, scopes, audience: 'mcp' });
  const issued = await t.db.db.transaction((tx) =>
    t.app.services.apiTokens.issue(tx, { id: grantId, userId, scopes, audience: 'mcp' }),
  );
  return issued.access_token;
}

async function rpc(bearer: string, method: string, params: Record<string, unknown> = {}) {
  return t.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      host: TEST_HOST,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    payload: { jsonrpc: '2.0', id: ++seq, method, params },
  });
}

async function call(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(bearer, 'tools/call', { name, arguments: args });
  expect(response.statusCode).toBe(200);
  return response.json().result as {
    content: { text: string }[];
    isError?: boolean;
    structuredContent?: unknown;
  };
}

const text = (result: { content: { text: string }[] }) => result.content[0]?.text ?? '';

async function toolNames(bearer: string): Promise<string[]> {
  const listed = await rpc(bearer, 'tools/list');
  return (listed.json().result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
}

describe.skipIf(!TEST_DATABASE_URL)('MCP notes', () => {
  beforeEach(async () => {
    t = await testApp();
    await t.app.services.settings.update(
      { 'instance.publicUrl': BASE, 'instance.defaultTimezone': 'UTC' },
      { userId: null, ip: null },
    );
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    alice = await createUser(t.db, { username: 'note-alice', password: 'x'.repeat(12) });
    bob = await createUser(t.db, { username: 'note-bob', password: 'x'.repeat(12) });
    limitedProject = id();
    taskId = id();
    await new SyncUser(t.app.services.sync, alice).ok(
      cmd('project_add', { id: limitedProject, name: 'Limited' }),
      cmd('task_add', { id: taskId, projectId: limitedProject, content: 'Linked task' }),
    );
  });
  afterEach(async () => t.close());

  it('lists, reads, creates, updates, archives and trashes, with owner isolation', async () => {
    const rw = await token(alice, ['notes:read', 'notes:write', 'tasks:read']);
    const created = await call(rw, 'create_note', {
      title: 'First note',
      body: `Visible ${censorToken}`,
      tags: ['Work'],
    });
    expect(created.isError).toBeFalsy();
    const noteId = (created.structuredContent as { note: { id: string } }).note.id;
    // An MCP client gets the placeholder, never the ciphertext token.
    expect(text(created)).toContain('█████');
    expect(text(created)).not.toContain('{{censored:v1');
    expect(text(created)).not.toContain('c2VjcmV0cGhyYXNl');
    expect(JSON.stringify(created.structuredContent)).not.toContain('{{censored:v1');

    const got = await call(rw, 'get_note', { id: noteId });
    expect(got.isError).toBeFalsy();
    expect(text(got)).toContain('"tags": [');
    expect(text(got)).toContain('"work"');
    expect(text(got)).toContain('█████');
    expect(text(got)).not.toContain('{{censored:v1');

    // MCP may not change a censored body, but a title change is fine.
    expect((await call(rw, 'update_note', { id: noteId, title: 'Renamed' })).isError).toBeFalsy();
    const dropped = await call(rw, 'update_note', { id: noteId, body: 'Visible only' });
    expect(dropped.isError).toBe(true);
    expect(text(dropped)).toContain('censored');
    expect((await call(rw, 'update_note', { id: noteId, tags: ['Ideas'] })).isError).toBeFalsy();

    const listed = await call(rw, 'list_notes', { q: 'Renamed' });
    expect(text(listed)).toContain('Renamed');
    expect(text(listed)).toContain('"snippet"');
    expect(text(listed)).not.toContain('{{censored:v1');
    expect((await call(rw, 'list_notes', { tag: 'ideas' })).isError).toBeFalsy();
    expect(text(await call(rw, 'list_notes', { tag: 'no-such-tag' }))).not.toContain(noteId);

    // Archiving and unarchiving stay allowed even with censored text in the body.
    expect((await call(rw, 'archive_note', { id: noteId })).isError).toBeFalsy();
    expect(text(await call(rw, 'list_notes', { state: 'archived' }))).toContain(noteId);
    expect(text(await call(rw, 'list_notes'))).not.toContain(noteId);
    expect((await call(rw, 'archive_note', { id: noteId, archived: false })).isError).toBeFalsy();

    // Trashing a note with censored text is MCP-specific: REST with notes:write may do it.
    const trashedFromMcp = await call(rw, 'trash_note', { id: noteId });
    expect(trashedFromMcp.isError).toBe(true);
    expect(text(trashedFromMcp)).toContain('censored');
    const rest = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${noteId}`,
      headers: { host: TEST_HOST, authorization: `Bearer ${rw}` },
      payload: { body: 'Uncensored now' },
    });
    expect(rest.statusCode).toBe(200);
    expect((await call(rw, 'trash_note', { id: noteId })).isError).toBeFalsy();
    expect(text(await call(rw, 'list_notes', { state: 'trashed' }))).toContain(noteId);
    expect((await call(rw, 'trash_note', { id: noteId, trashed: false })).isError).toBeFalsy();

    const bobToken = await token(bob, ['notes:read', 'notes:write', 'tasks:read']);
    expect((await call(bobToken, 'get_note', { id: noteId })).isError).toBe(true);
    expect(text(await call(bobToken, 'list_notes'))).not.toContain(noteId);

    // Manual note ↔ task links, limited to tasks the caller can still see.
    expect((await call(rw, 'link_note_to_task', { noteId, taskId })).isError).toBeFalsy();
    expect(text(await call(rw, 'get_note', { id: noteId }))).toContain(taskId);
    // A notes-only token reads the note but never task text through it.
    const notesOnly = await token(alice, ['notes:read']);
    expect(text(await call(notesOnly, 'get_note', { id: noteId }))).not.toContain(taskId);
    expect((await call(bobToken, 'link_note_to_task', { noteId, taskId })).isError).toBe(true);
    expect((await call(rw, 'unlink_note_from_task', { noteId, taskId })).isError).toBeFalsy();
    expect(text(await call(rw, 'get_note', { id: noteId }))).not.toContain(taskId);

    expect(await t.db.db.select().from(notes)).toHaveLength(1);
  });

  it('passes expectedUpdatedAt through and reports a stale revision clearly', async () => {
    const rw = await token(alice, ['notes:read', 'notes:write']);
    const created = await call(rw, 'create_note', { title: 'Rev', body: 'one' });
    const note = (created.structuredContent as { note: { id: string; updatedAt: string } }).note;

    const saved = await call(rw, 'update_note', {
      id: note.id,
      body: 'two',
      expectedUpdatedAt: note.updatedAt,
    });
    expect(saved.isError).toBeFalsy();
    const revision = (saved.structuredContent as { note: { updatedAt: string } }).note.updatedAt;
    expect(revision).not.toBe(note.updatedAt);

    const stale = await call(rw, 'update_note', {
      id: note.id,
      body: 'three',
      expectedUpdatedAt: note.updatedAt,
    });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain('stale revision');
    expect(text(await call(rw, 'get_note', { id: note.id }))).toContain('"body": "two"');

    // The same canonical-instant rule as REST, and a precondition alone is not a change.
    const bad = await call(rw, 'update_note', {
      id: note.id,
      body: 'three',
      expectedUpdatedAt: '2026-11-18T12:00:00Z',
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('canonical ISO-8601');
    expect(
      (await call(rw, 'update_note', { id: note.id, expectedUpdatedAt: revision })).isError,
    ).toBe(true);

    // Omitting the precondition keeps the old unconditional behaviour.
    expect((await call(rw, 'update_note', { id: note.id, body: 'four' })).isError).toBeFalsy();
  });

  it('requires note scopes and never exposes account-wide tools to project-limited tokens', async () => {
    const readOnly = await token(alice, ['notes:read']);
    const names = await toolNames(readOnly);
    expect(names).toContain('list_notes');
    expect(names).toContain('get_note');
    expect(names).not.toContain('create_note');
    expect((await call(readOnly, 'create_note', { title: 'nope' })).isError).toBe(true);

    const taskOnly = await token(alice, ['tasks:read']);
    expect((await call(taskOnly, 'list_notes')).isError).toBe(true);

    // A write-only token may create a note, but the answer is not a note body it cannot read.
    const writeOnly = await token(alice, ['notes:write']);
    const writeOnlyNames = await toolNames(writeOnly);
    expect(writeOnlyNames).toContain('create_note');
    // Linking reveals whether a task is visible, so it needs task read access too.
    expect(writeOnlyNames).not.toContain('link_note_to_task');
    const created = await call(writeOnly, 'create_note', { title: 'Write only', body: 'body' });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain('"id"');
    expect(text(created)).not.toContain('"body"');
    // Whether a body is censored is itself something only a reader may learn.
    const createdId = /"id":\s*"([0-9a-f-]{36})"/.exec(text(created))?.[1] ?? '';
    expect(createdId).not.toBe('');
    for (const [tool, args] of [
      ['update_note', { id: createdId, body: 'changed' }],
      ['trash_note', { id: createdId }],
    ] as const) {
      const refused = await call(writeOnly, tool, args);
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('notes:read');
    }
    // Metadata changes stay open to a write-only token.
    expect(
      (await call(writeOnly, 'update_note', { id: createdId, title: 'Renamed' })).isError,
    ).toBeFalsy();

    // `sync` covers every scope, notes included, and gets the full note back.
    const sync = await token(alice, ['sync']);
    expect(
      text(await call(sync, 'create_note', { title: 'Sync note', body: 'Sync body' })),
    ).toContain('Sync body');

    const limited = await token(alice, ['notes:read', 'notes:write'], [limitedProject]);
    expect(await toolNames(limited)).not.toContain('list_notes');
    expect((await call(limited, 'list_notes')).isError).toBe(true);
    // The REST routes refuse project-limited tokens the same way habits do.
    const rest = await t.app.inject({
      method: 'GET',
      url: '/api/v1/notes',
      headers: { host: TEST_HOST, authorization: `Bearer ${limited}` },
    });
    expect(rest.statusCode).toBe(403);
    expect(rest.json()).toEqual({ error: 'project_limited_token' });
  });

  it('supports OAuth note scopes and denies task-only tokens', async () => {
    const read = await oauthToken(alice, ['notes:read']);
    const names = await toolNames(read);
    expect(names).toContain('list_notes');
    expect(names).not.toContain('create_note');

    const write = await oauthToken(alice, ['notes:read', 'notes:write']);
    const created = await call(write, 'create_note', { title: 'From OAuth', body: 'Hello' });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain('From OAuth');
  });

  it('never returns task content to a token without tasks:read, on any note-returning tool', async () => {
    // notes:read+notes:write, deliberately without tasks:read.
    const rw = await token(alice, ['notes:read', 'notes:write']);
    const created = await call(rw, 'create_note', {
      title: 'Scope note',
      body: `Linked [the task](bokydo:task/${taskId})`,
    });
    expect(created.isError).toBeFalsy();
    const noteId = (created.structuredContent as { note: { id: string } }).note.id;

    const answers = [
      created,
      await call(rw, 'update_note', { id: noteId, title: 'Scope note renamed' }),
      await call(rw, 'archive_note', { id: noteId }),
      await call(rw, 'archive_note', { id: noteId, archived: false }),
      await call(rw, 'trash_note', { id: noteId }),
    ];
    for (const answer of answers) {
      expect(answer.isError).toBeFalsy();
      // The task's text may not appear, in either channel, and the link list must be empty.
      expect(text(answer)).not.toContain('Linked task');
      expect(JSON.stringify(answer.structuredContent)).not.toContain('Linked task');
      expect(
        (answer.structuredContent as { note: { linkedTasks: unknown[] } }).note.linkedTasks,
      ).toEqual([]);
    }

    // The link really exists: a token that may read tasks sees it.
    const withTasks = await token(alice, ['notes:read', 'tasks:read']);
    const seen = await call(withTasks, 'get_note', { id: noteId });
    expect(text(seen)).toContain('Linked task');
    expect(
      (seen.structuredContent as { note: { linkedTasks: { id: string }[] } }).note.linkedTasks[0]
        ?.id,
    ).toBe(taskId);
  });

  it('redacts censor-like text in every free-text field, in text and structuredContent', async () => {
    const rw = await token(alice, ['notes:read', 'notes:write', 'tasks:read']);
    const censoredTask = id();
    await new SyncUser(t.app.services.sync, alice).ok(
      cmd('task_add', {
        id: censoredTask,
        projectId: limitedProject,
        content: 'Task {{ censored }} title',
      }),
    );
    const created = await call(rw, 'create_note', {
      title: 'Title {{censored}}',
      body: `Body {{CENSORED}} here\n[task](bokydo:task/${censoredTask})`,
      tags: ['tag{{censored}}'],
    });
    expect(created.isError).toBeFalsy();
    const noteId = (created.structuredContent as { note: { id: string } }).note.id;

    const upload = await t.app.inject({
      method: 'POST',
      url: `/api/v1/notes/${noteId}/files`,
      headers: {
        host: TEST_HOST,
        authorization: `Bearer ${rw}`,
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('{{censored}}.txt'),
      },
      payload: Buffer.from('file bytes'),
    });
    expect(upload.statusCode).toBe(201);
    const backlink = await call(rw, 'create_note', {
      title: 'Backlink {{censored}}',
      body: `[see](bokydo:note/${noteId})`,
    });
    expect(backlink.isError).toBeFalsy();

    const got = await call(rw, 'get_note', { id: noteId });
    expect(got.isError).toBeFalsy();
    const note = (
      got.structuredContent as {
        note: {
          title: string;
          body: string;
          snippet: string;
          tags: string[];
          backlinks: { title: string }[];
          files: { filename: string }[];
          linkedTasks: { content: string }[];
        };
      }
    ).note;
    expect(note.title).toBe('Title █████');
    expect(note.body).toContain('Body █████ here');
    expect(note.snippet).toContain('█████');
    expect(note.tags).toEqual(['tag█████']);
    expect(note.backlinks).toEqual([expect.objectContaining({ title: 'Backlink █████' })]);
    expect(note.files).toEqual([expect.objectContaining({ filename: '█████.txt' })]);
    expect(note.linkedTasks).toEqual([expect.objectContaining({ content: 'Task █████ title' })]);
    for (const channel of [text(got), JSON.stringify(got.structuredContent)]) {
      expect(channel).not.toMatch(/censored/i);
      expect(channel).not.toContain('{{');
    }

    // The list shape redacts the same free-text fields it carries.
    const listed = await call(rw, 'list_notes', {});
    expect(text(listed)).toContain('█████');
    expect(text(listed)).not.toMatch(/censored/i);
    expect(JSON.stringify(listed.structuredContent)).not.toMatch(/censored/i);
  });

  it('runs the censored-body guard under the row lock, on the latest committed body', async () => {
    const rw = await token(alice, ['notes:read', 'notes:write']);
    const created = await call(rw, 'create_note', { title: 'Race', body: 'clean body' });
    const noteId = (created.structuredContent as { note: { id: string } }).note.id;

    // Another connection takes the row lock and writes a censored body, then holds the lock.
    // The MCP update waits there, and must see that committed body when it finally gets the lock.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const other = t.db.sql.begin(async (tx) => {
      await tx`update notes set body = ${`Visible ${censorToken}`} where id = ${noteId}`;
      locked();
      await held;
    });
    await lockTaken;

    const pending = call(rw, 'update_note', { id: noteId, body: 'Visible only' });
    release();
    await other;
    const refused = await pending;

    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('censored');
    const [row] = await t.db.db.select().from(notes).where(eq(notes.id, noteId));
    expect(row?.body).toBe(`Visible ${censorToken}`);
  });
});
