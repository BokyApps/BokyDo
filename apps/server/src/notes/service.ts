import {
  NOTE_REF_LIMIT,
  noteCreateRequestSchema,
  noteListQuerySchema,
  notePatchSchema,
  noteSnippet,
  normaliseNoteTags,
  toSearchText,
  type Note,
  type NoteListResponse,
  type NoteState,
  type NoteSummary,
  type NoteTagsResponse,
} from '@bokydo/shared';
import { extractNoteRefs } from '@bokydo/shared/notes-refs';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import type { AttachmentStore } from '../attachments/store.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  noteFiles,
  noteLinks,
  notes,
  noteTaskLinks,
  projectMembers,
  projects,
  tasks,
} from '../db/schema.js';
import type { Tx } from '../sync/context.js';

export type NoteFailure =
  | 'validation_failed'
  | 'not_found'
  | 'id_conflict'
  | 'too_many_links'
  /** The caller's `expectedUpdatedAt` is not the note's current revision; nothing was written. */
  | 'stale_revision'
  /** MCP only: the note's current body contains censored text a client cannot re-create. */
  | 'censored_content';
export type NoteResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: NoteFailure;
      /**
       * `stale_revision` only: the note's current `updated_at`, exactly as the API returns it, so
       * a caller with `notes:read` can show what to reload or merge against.
       */
      updatedAt?: string;
    };

export const NOTE_PENDING_TTL_MS = 24 * 3600 * 1000;
export const NOTE_TRASH_TTL_MS = 30 * 24 * 3600 * 1000;
/** A reservation older than this is a dropped upload; it and its bytes are removed. */
export const NOTE_UPLOADING_TTL_MS = 3600 * 1000;

const uuid = (value: string) => z.uuid().safeParse(value).success;

type NoteRow = typeof notes.$inferSelect;

/** A body named more distinct notes/tasks than the table will hold. */
class TooManyLinksError extends Error {}

/** A precondition or caller-supplied guard refused the update after the row was locked. */
class NoteGuardError extends Error {
  constructor(
    readonly code: NoteFailure,
    /** For `stale_revision`: the locked row's current revision. */
    readonly updatedAt?: string,
  ) {
    super(code);
  }
}

export interface NoteReadOptions {
  /** False for a bearer token without `tasks:read`: the response carries no task data. */
  linkedTasks?: boolean;
}

export interface NoteUpdateOptions extends NoteReadOptions {
  /**
   * Called with the row as it is locked, inside the update's transaction and before any write.
   * Returning an error code aborts the update with that code and leaves the note untouched.
   * MCP uses it to refuse body changes and trashing for a note with censored text, under the
   * same lock that protects the write: a pre-read outside the transaction could see a stale
   * body if a save commits in between.
   */
  guard?: (current: { body: string }) => NoteFailure | null;
}

interface NoteCursor {
  pinned: boolean;
  updatedAt: string;
  id: string;
}

function encodeCursor(row: { pinned: boolean; updatedAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ p: row.pinned, u: row.updatedAt.toISOString(), i: row.id }),
  ).toString('base64url');
}

/** Canonical unpadded base64url: the alphabet, and at least one character. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Decode a `nextCursor` strictly, so a supplied cursor means exactly the page it was issued for:
 * canonical unpadded base64url (re-encoding it must give the input back), a JSON object with only
 * `p`, `u` and `i`, a boolean, a canonical ISO instant and a UUID. Anything else is a 400, never a
 * lenient decode that pages from an instant the caller did not ask for.
 */
function decodeCursor(raw: string): NoteCursor | null {
  if (!BASE64URL.test(raw)) return null;
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).sort().join(',') !== 'i,p,u') return null;
  const { p, u, i } = parsed as Record<string, unknown>;
  if (typeof p !== 'boolean' || typeof u !== 'string' || typeof i !== 'string') return null;
  const date = new Date(u);
  // Only the canonical ISO string a cursor was issued with: a lenient date would page from a
  // different instant than the caller asked for, and `toISOString` round-trips exactly.
  if (Number.isNaN(date.getTime()) || date.toISOString() !== u || !uuid(i)) return null;
  return { pinned: p, updatedAt: u, id: i };
}

function stateOf(row: { state: 'active' | 'archived'; trashedAt: Date | null }): NoteState {
  return row.trashedAt ? 'trashed' : row.state;
}

function summaryOf(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    snippet: noteSnippet(row.body),
    tags: row.tags,
    state: stateOf(row),
    pinned: row.pinned,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The caller's notes, pinned first and then newest first. Trashed notes are excluded unless
 * `state=trashed`. Search matches the generated vector OR a case-insensitive title substring;
 * LIKE wildcards in the query are escaped so `%` is a literal percent sign.
 */
export async function listNotes(
  db: Database,
  userId: string,
  input: unknown,
): Promise<NoteResult<NoteListResponse>> {
  const parsed = noteListQuerySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation_failed' };
  const { limit } = parsed.data;
  const q = parsed.data.q?.trim() ?? '';
  let tag: string | null = null;
  if (parsed.data.tag !== undefined) {
    const normalised = normaliseNoteTags([parsed.data.tag]);
    const first = normalised?.[0];
    if (!normalised || normalised.length !== 1 || !first)
      return { ok: false, error: 'validation_failed' };
    tag = first;
  }
  let cursor: NoteCursor | null = null;
  // Any supplied value, including the empty string, must decode: treating `cursor=` as "no
  // cursor" would silently return the first page to a caller that asked for another one.
  if (parsed.data.cursor !== undefined) {
    cursor = decodeCursor(parsed.data.cursor);
    if (!cursor) return { ok: false, error: 'validation_failed' };
  }

  const conditions: SQL[] = [eq(notes.ownerUserId, userId)];
  if (parsed.data.state === 'trashed') conditions.push(isNotNull(notes.trashedAt));
  else {
    conditions.push(isNull(notes.trashedAt), eq(notes.state, parsed.data.state));
  }
  if (tag) conditions.push(sql`${notes.tags} @> array[${tag}]::text[]`);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(
      sql`(${notes.search} @@ websearch_to_tsquery('simple', ${q}) or ${notes.title} ilike ${like} escape '\\')`,
    );
  }
  if (cursor) {
    conditions.push(
      sql`(${notes.pinned}, ${notes.updatedAt}, ${notes.id}) < (${cursor.pinned}::boolean, ${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await db
    .select()
    .from(notes)
    .where(and(...conditions))
    .orderBy(desc(notes.pinned), desc(notes.updatedAt), desc(notes.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    ok: true,
    value: {
      notes: page.map(summaryOf),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    },
  };
}

/** Distinct tags of the caller's non-trashed notes (archived included), with counts. */
export async function listNoteTags(db: Database, userId: string): Promise<NoteTagsResponse> {
  const rows = await db.execute<{ tag: string; count: number }>(sql`
    select t.tag as tag, count(*)::int as count
    from notes n, unnest(n.tags) as t(tag)
    where n.owner_user_id = ${userId} and n.trashed_at is null
    group by t.tag
    order by t.tag
  `);
  return { tags: rows.map((row) => ({ tag: row.tag, count: Number(row.count) })) };
}

/** One note with its body, backlinks, currently visible linked tasks and files. */
export async function getNote(
  db: Database,
  userId: string,
  noteId: string,
  options: NoteReadOptions = {},
): Promise<Note | null> {
  if (!uuid(noteId)) return null;
  const [row] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.ownerUserId, userId)));
  if (!row) return null;
  // Every detail query names the note by (id, owner_user_id = caller) in its own join, not only
  // in an earlier statement, so the data can only ever come from a note of the caller's — a
  // backlink from the source note, a task link held by this note, a file of this note. The extra
  // predicate costs one index lookup on `notes(id, owner_user_id)`.
  const [backlinks, linkedTasks, files] = await Promise.all([
    db
      .select({ id: notes.id, title: notes.title })
      .from(noteLinks)
      .innerJoin(notes, and(eq(notes.id, noteLinks.fromNoteId), eq(notes.ownerUserId, userId)))
      .where(and(eq(noteLinks.toNoteId, row.id), isNull(notes.trashedAt)))
      .orderBy(desc(notes.updatedAt), desc(notes.id)),
    options.linkedTasks === false
      ? Promise.resolve([])
      : db
          .selectDistinct({
            id: tasks.id,
            content: tasks.content,
            projectId: tasks.projectId,
            completed: tasks.isCompleted,
          })
          .from(noteTaskLinks)
          .innerJoin(notes, and(eq(notes.id, noteTaskLinks.noteId), eq(notes.ownerUserId, userId)))
          .innerJoin(tasks, eq(tasks.id, noteTaskLinks.taskId))
          .innerJoin(projects, eq(projects.id, tasks.projectId))
          .innerJoin(
            projectMembers,
            and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
          )
          .where(
            and(
              eq(noteTaskLinks.noteId, row.id),
              isNull(tasks.deletedAt),
              isNull(projects.deletedAt),
            ),
          )
          .orderBy(asc(tasks.content), asc(tasks.id)),
    db
      .select({
        id: noteFiles.id,
        filename: noteFiles.filename,
        contentType: noteFiles.contentType,
        size: noteFiles.size,
      })
      .from(noteFiles)
      .innerJoin(notes, and(eq(notes.id, noteFiles.noteId), eq(notes.ownerUserId, userId)))
      .where(
        and(
          eq(noteFiles.noteId, row.id),
          eq(noteFiles.ownerUserId, userId),
          eq(noteFiles.status, 'ready'),
        ),
      )
      .orderBy(asc(noteFiles.createdAt), asc(noteFiles.id)),
  ]);
  return {
    ...summaryOf(row),
    body: row.body,
    trashedAt: row.trashedAt?.toISOString() ?? null,
    backlinks,
    linkedTasks,
    files,
  };
}

export async function createNote(
  db: Database,
  userId: string,
  input: unknown,
  options: NoteReadOptions = {},
): Promise<NoteResult<{ note: Note; created: boolean }>> {
  const parsed = noteCreateRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation_failed' };
  const tags = normaliseNoteTags(parsed.data.tags);
  if (!tags) return { ok: false, error: 'validation_failed' };
  const id = parsed.data.id ?? newId();
  const { title, body, pinned } = parsed.data;
  let created: boolean;
  try {
    created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(notes)
        .values({
          id,
          ownerUserId: userId,
          title,
          body,
          tags,
          pinned,
          searchText: toSearchText(title, tags, body),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return false;
      if (!(await rebuildRefs(tx, row, userId))) throw new TooManyLinksError();
      return true;
    });
  } catch (err) {
    if (err instanceof TooManyLinksError) return { ok: false, error: 'too_many_links' };
    throw err;
  }
  if (created) {
    const note = await getNote(db, userId, id, options);
    return note ? { ok: true, value: { note, created: true } } : { ok: false, error: 'not_found' };
  }
  // A retry with the same client ID and the same content is the same create; anything else is a
  // conflict (a stable ID belongs to whoever created it first). Another owner's ID is a
  // conflict too, never a 404 or a hint that the ID is free.
  const [existing] = await db.select().from(notes).where(eq(notes.id, id));
  if (!existing) return { ok: false, error: 'not_found' };
  if (existing.ownerUserId !== userId) return { ok: false, error: 'id_conflict' };
  const same =
    existing.title === title &&
    existing.body === body &&
    existing.pinned === pinned &&
    existing.state === 'active' &&
    existing.trashedAt === null &&
    existing.tags.length === tags.length &&
    existing.tags.every((tag, index) => tag === tags[index]);
  if (!same) return { ok: false, error: 'id_conflict' };
  const note = await getNote(db, userId, id, options);
  return note ? { ok: true, value: { note, created: false } } : { ok: false, error: 'not_found' };
}

export async function updateNote(
  db: Database,
  userId: string,
  noteId: string,
  input: unknown,
  options: NoteUpdateOptions = {},
): Promise<NoteResult<Note>> {
  const patch = notePatchSchema.safeParse(input);
  if (!patch.success || !uuid(noteId)) return { ok: false, error: 'validation_failed' };
  let tags: string[] | undefined;
  if (patch.data.tags !== undefined) {
    const normalised = normaliseNoteTags(patch.data.tags);
    if (!normalised) return { ok: false, error: 'validation_failed' };
    tags = normalised;
  }
  let updated: NoteRow | null;
  try {
    updated = await db.transaction(async (tx) => {
      // The body save locks the note row here, in the same transaction that flips file
      // `referenced`/`unreferenced_at`, so a purge can never interleave with a claim.
      const [current] = await tx
        .select()
        .from(notes)
        .where(and(eq(notes.id, noteId), eq(notes.ownerUserId, userId)))
        .for('update');
      if (!current) return null;
      // Optimistic concurrency, decided under the lock and in the same transaction as the write:
      // two callers that send the same revision can never both write, because the second one
      // locks the row only after the first commits and then sees that revision has moved.
      // `notes.updated_at` is `timestamptz(3)`, so the row value has millisecond precision — the
      // exact precision of a JS `Date` and of the `toISOString` value `GET` returns — and integer
      // millisecond instants can be compared exactly, with no truncation on either side.
      if (
        patch.data.expectedUpdatedAt !== undefined &&
        new Date(patch.data.expectedUpdatedAt).getTime() !== current.updatedAt.getTime()
      )
        throw new NoteGuardError('stale_revision', current.updatedAt.toISOString());
      // The guard sees the body as it is now, under the lock: not a pre-read that another
      // committed save could have made stale.
      const refusal = options.guard?.({ body: current.body });
      if (refusal) throw new NoteGuardError(refusal);
      const merged = {
        title: patch.data.title ?? current.title,
        body: patch.data.body ?? current.body,
        tags: tags ?? current.tags,
        pinned: patch.data.pinned ?? current.pinned,
        state: patch.data.state ?? current.state,
        trashedAt:
          patch.data.trashed === undefined
            ? current.trashedAt
            : patch.data.trashed
              ? (current.trashedAt ?? new Date())
              : null,
      };
      // Every accepted write must move the revision forward, even when it lands in the same
      // millisecond as the save it replaces: otherwise a stale premise could still match it.
      const nextRevision = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
      const [row] = await tx
        .update(notes)
        .set({
          ...merged,
          searchText: toSearchText(merged.title, merged.tags, merged.body),
          updatedAt: nextRevision,
        })
        .where(and(eq(notes.id, current.id), eq(notes.ownerUserId, userId)))
        .returning();
      if (!row) return null;
      // Links and file claims are derived from the body, so only a body change rebuilds them.
      if (patch.data.body !== undefined && !(await rebuildRefs(tx, row, userId)))
        throw new TooManyLinksError();
      return row;
    });
  } catch (err) {
    if (err instanceof TooManyLinksError) return { ok: false, error: 'too_many_links' };
    if (err instanceof NoteGuardError)
      return err.updatedAt === undefined
        ? { ok: false, error: err.code }
        : { ok: false, error: err.code, updatedAt: err.updatedAt };
    throw err;
  }
  if (!updated) return { ok: false, error: 'not_found' };
  const note = await getNote(db, userId, noteId, options);
  return note ? { ok: true, value: note } : { ok: false, error: 'not_found' };
}

/** Delete forever: the note, its links and rows, and the IDs of files whose bytes to remove. */
export async function deleteNote(
  db: Database,
  userId: string,
  noteId: string,
): Promise<NoteResult<{ fileIds: string[] }>> {
  if (!uuid(noteId)) return { ok: false, error: 'not_found' };
  const fileIds = await db.transaction(async (tx) => {
    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerUserId, userId)))
      .for('update');
    if (!note) return null;
    const files = await tx
      .select({ id: noteFiles.id })
      .from(noteFiles)
      .where(and(eq(noteFiles.noteId, note.id), eq(noteFiles.ownerUserId, userId)));
    await tx.delete(notes).where(eq(notes.id, note.id));
    return files.map((file) => file.id);
  });
  return fileIds ? { ok: true, value: { fileIds } } : { ok: false, error: 'not_found' };
}

/**
 * A manual note → task link, allowed only while the task's project is visible to the caller.
 * The owner check and the link write share one transaction with the note row locked, and task
 * visibility is one join: a private task and a missing one take the same 404 path.
 */
export async function linkNoteToTask(
  db: Database,
  userId: string,
  noteId: string,
  taskId: string,
): Promise<NoteResult<true>> {
  if (!uuid(noteId) || !uuid(taskId)) return { ok: false, error: 'validation_failed' };
  const linked = await db.transaction(async (tx) => {
    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerUserId, userId), isNull(notes.trashedAt)))
      .for('update');
    if (!note) return false;
    const [task] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(
        projectMembers,
        and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
      )
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt), isNull(projects.deletedAt)));
    if (!task) return false;
    await tx
      .insert(noteTaskLinks)
      .values({ noteId: note.id, taskId: task.id, source: 'manual' })
      .onConflictDoNothing();
    return true;
  });
  return linked ? { ok: true, value: true } : { ok: false, error: 'not_found' };
}

/** Remove the manual link only; a body link stays until the body no longer names the task. */
export async function unlinkNoteFromTask(
  db: Database,
  userId: string,
  noteId: string,
  taskId: string,
): Promise<NoteResult<true>> {
  if (!uuid(noteId) || !uuid(taskId)) return { ok: false, error: 'validation_failed' };
  const removed = await db.transaction(async (tx) => {
    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerUserId, userId)))
      .for('update');
    if (!note) return false;
    await tx
      .delete(noteTaskLinks)
      .where(
        and(
          eq(noteTaskLinks.noteId, note.id),
          eq(noteTaskLinks.taskId, taskId),
          eq(noteTaskLinks.source, 'manual'),
        ),
      );
    return true;
  });
  return removed ? { ok: true, value: true } : { ok: false, error: 'not_found' };
}

/** The caller's own non-trashed notes linked to a task they can currently see. */
export async function notesForTask(
  db: Database,
  userId: string,
  taskId: string,
): Promise<NoteResult<NoteSummary[]>> {
  if (!uuid(taskId)) return { ok: false, error: 'not_found' };
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt), isNull(projects.deletedAt)));
  if (!task) return { ok: false, error: 'not_found' };
  const linkedNoteIds = db
    .select({ id: noteTaskLinks.noteId })
    .from(noteTaskLinks)
    .where(eq(noteTaskLinks.taskId, task.id));
  const rows = await db
    .select()
    .from(notes)
    .where(
      and(inArray(notes.id, linkedNoteIds), eq(notes.ownerUserId, userId), isNull(notes.trashedAt)),
    )
    .orderBy(desc(notes.pinned), desc(notes.updatedAt), desc(notes.id));
  return { ok: true, value: rows.map(summaryOf) };
}

/**
 * Derive `note_links`, the body half of `note_task_links` and file `referenced` flags from the
 * note's Markdown. Targets are resolved in batches and only when the user may see them now: their
 * own non-trashed notes, and tasks in projects they belong to. Returns false when the body names
 * more distinct notes/tasks than `NOTE_REF_LIMIT`.
 */
async function rebuildRefs(tx: Tx, note: NoteRow, userId: string): Promise<boolean> {
  const refs = extractNoteRefs(note.body);
  const noteIds = refs.noteIds.filter((id) => id !== note.id);
  const taskIds = refs.taskIds;
  const fileIds = refs.fileIds;
  if (noteIds.length + taskIds.length > NOTE_REF_LIMIT) return false;

  await tx.delete(noteLinks).where(eq(noteLinks.fromNoteId, note.id));
  if (noteIds.length) {
    const visible = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(inArray(notes.id, noteIds), eq(notes.ownerUserId, userId), isNull(notes.trashedAt)),
      );
    if (visible.length)
      await tx
        .insert(noteLinks)
        .values(visible.map((row) => ({ fromNoteId: note.id, toNoteId: row.id })))
        .onConflictDoNothing();
  }

  await tx
    .delete(noteTaskLinks)
    .where(and(eq(noteTaskLinks.noteId, note.id), eq(noteTaskLinks.source, 'body')));
  if (taskIds.length) {
    const visible = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(
        projectMembers,
        and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
      )
      .where(and(inArray(tasks.id, taskIds), isNull(tasks.deletedAt), isNull(projects.deletedAt)));
    if (visible.length)
      await tx
        .insert(noteTaskLinks)
        .values(
          visible.map((row) => ({ noteId: note.id, taskId: row.id, source: 'body' as const })),
        )
        .onConflictDoNothing();
  }

  // Claim only this note's and owner's ready files; another note's file id in this body is
  // ignored (the composite foreign key would also refuse to store it). Every referenced file is
  // claimed, with no cap: the id can only ever name a file of this note.
  if (fileIds.length)
    await tx
      .update(noteFiles)
      .set({ referenced: true, unreferencedAt: null })
      .where(
        and(
          eq(noteFiles.noteId, note.id),
          eq(noteFiles.ownerUserId, userId),
          eq(noteFiles.status, 'ready'),
          inArray(noteFiles.id, fileIds),
          eq(noteFiles.referenced, false),
        ),
      );
  // Files of this note the body no longer names go back to pending from now: the 24 h purge is
  // measured from the removal, not from the upload.
  await tx
    .update(noteFiles)
    .set({ referenced: false, unreferencedAt: new Date() })
    .where(
      and(
        eq(noteFiles.noteId, note.id),
        eq(noteFiles.ownerUserId, userId),
        eq(noteFiles.status, 'ready'),
        eq(noteFiles.referenced, true),
        fileIds.length ? notInArray(noteFiles.id, fileIds) : sql`true`,
      ),
    );
  return true;
}

export interface PurgeHooks {
  /**
   * Test seam, called inside the trash transaction after `FOR UPDATE SKIP LOCKED` selected the
   * notes and before their files/rows are deleted, so a restore can be simulated between the
   * select and the delete.
   */
  afterTrashSelected?: (tx: Tx) => Promise<void>;
}

/**
 * Remove expired note files and trashed notes, then stray bytes in the note-files directory.
 * Runs hourly and is returned so tests (and the account-deletion path) can call it directly.
 *
 * Every candidate is deleted by the statement that returns it, so a file or note that stops
 * qualifying between the check and the delete is never removed by a stale list. The trash purge
 * re-checks `trashed_at` under the row lock it already holds.
 */
export async function purgeNotes(
  db: Database,
  store: AttachmentStore,
  now = new Date(),
  hooks: PurgeHooks = {},
): Promise<void> {
  // Stale upload reservations (the client went away): row, final file and `.part`.
  const uploadingBefore = new Date(now.getTime() - NOTE_UPLOADING_TTL_MS);
  const stale = await db
    .delete(noteFiles)
    .where(and(eq(noteFiles.status, 'uploading'), lt(noteFiles.createdAt, uploadingBefore)))
    .returning({ id: noteFiles.id });
  for (const row of stale) {
    await store.remove(row.id);
    await store.removeName(`${row.id}.part`);
  }

  // Pending files: one DELETE decides and returns the ids, then only those are unlinked.
  const pendingBefore = new Date(now.getTime() - NOTE_PENDING_TTL_MS);
  const pending = await db
    .delete(noteFiles)
    .where(
      and(
        eq(noteFiles.referenced, false),
        eq(noteFiles.status, 'ready'),
        lt(noteFiles.unreferencedAt, pendingBefore),
      ),
    )
    .returning({ id: noteFiles.id });
  for (const row of pending) await store.remove(row.id);

  // Trashed notes: the select locks the rows, a second read re-checks the cutoff on those same
  // locked rows, and only then are the files of the still-expired notes and the notes deleted.
  // A restore that happens between the select and the delete (the test hook does exactly that)
  // therefore keeps the note *and* its bytes: the file delete only ever names rechecked ids.
  const trashBefore = new Date(now.getTime() - NOTE_TRASH_TTL_MS);
  const files = await db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(and(isNotNull(notes.trashedAt), lt(notes.trashedAt, trashBefore)))
      .for('update', { skipLocked: true });
    if (candidates.length === 0) return [];
    await hooks.afterTrashSelected?.(tx);
    const ids = candidates.map((row) => row.id);
    const expired = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(inArray(notes.id, ids), isNotNull(notes.trashedAt), lt(notes.trashedAt, trashBefore)),
      );
    const doomed = expired.map((row) => row.id);
    if (doomed.length === 0) return [];
    const removed = await tx
      .delete(noteFiles)
      .where(inArray(noteFiles.noteId, doomed))
      .returning({ id: noteFiles.id });
    await tx.delete(notes).where(inArray(notes.id, doomed));
    return removed.map((row) => row.id);
  });
  for (const id of files) await store.remove(id);

  const onDisk = await store.list(NOTE_PENDING_TTL_MS);
  if (onDisk.length === 0) return;
  const live = new Set(
    (await db.select({ id: noteFiles.id }).from(noteFiles)).map((row) => row.id),
  );
  for (const name of onDisk)
    if (!live.has(name.replace(/\.part$/, ''))) await store.removeName(name);
}
