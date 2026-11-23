import {
  noteCreateRequestSchema,
  noteListQuerySchema,
  notePatchSchema,
  notePatchWrites,
  redactCensored,
  scopesAllow,
  type Note,
  type NotePatch,
  type NoteSummary,
} from '@bokydo/shared';
import { z } from 'zod';
import {
  createNote,
  getNote,
  linkNoteToTask,
  listNotes,
  unlinkNoteFromTask,
  updateNote,
  type NoteReadOptions,
  type NoteUpdateOptions,
} from '../notes/service.js';
import type { ToolContext, ToolDefinition } from './tools.js';
import { ToolError } from './tools.js';

const uuid = z.uuid();
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const add = { ...write, idempotentHint: false } as const;
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const fail = (error: string): never => {
  throw new ToolError(error);
};

/**
 * What MCP may see of a note: every free-text field with censor-like spans replaced by `█████`.
 * The ciphertext tokens are never sent to a client, so an AI cannot copy them elsewhere, and the
 * server holds no key to the cleartext either. Titles, tags, snippets, backlink titles, file
 * names and linked task text are redacted too, not just the body: any of them is free text and
 * any of them could carry a token.
 */
function present(note: Note): Note {
  return {
    ...note,
    title: redactCensored(note.title),
    body: redactCensored(note.body),
    snippet: redactCensored(note.snippet),
    tags: note.tags.map(redactCensored),
    backlinks: note.backlinks.map((backlink) => ({
      ...backlink,
      title: redactCensored(backlink.title),
    })),
    linkedTasks: note.linkedTasks.map((task) => ({
      ...task,
      content: redactCensored(task.content),
    })),
    files: note.files.map((file) => ({ ...file, filename: redactCensored(file.filename) })),
  };
}

/** The list shape: the same free-text fields as a note, minus body, links and files. */
function presentSummary({ preview: _preview, ...note }: NoteSummary): NoteSummary {
  // The card preview is for the web list; an AI already gets the snippet.
  void _preview;
  return {
    ...note,
    title: redactCensored(note.title),
    snippet: redactCensored(note.snippet),
    tags: note.tags.map(redactCensored),
  };
}

/** A write-only token may change a note but must not read one back, as over REST. */
function presentFor(ctx: ToolContext, note: Note) {
  return scopesAllow(ctx.scopes, ['notes:read'])
    ? { note: present(note) }
    : { note: { id: note.id, updatedAt: note.updatedAt } };
}

/** The scope-derived read options `get_note` and the REST routes use: no task data without it. */
const readOptions = (ctx: ToolContext): NoteReadOptions => ({
  linkedTasks: scopesAllow(ctx.scopes, ['tasks:read']),
});

/** Censor-like text anywhere in a body, case-insensitive and lenient on purpose. */
const CENSORED_BODY = /\{\{\s*censored/i;

const CENSORED_MCP_ERROR =
  'This note contains censored text; change its body or move it to the trash in the BokyDo app.';

/**
 * MCP's censored-content policy: a client that cannot see or re-create a censored span may not
 * change the body or move the note to the trash. Title, tags, pin and archive/unarchive remain
 * allowed. The service runs this under the note's row lock, so it sees the body a concurrent
 * save has committed. REST clients are not restricted this way.
 */
function censorGuard(destructive: boolean): NoteUpdateOptions['guard'] {
  return destructive
    ? (current) => (CENSORED_BODY.test(current.body) ? 'censored_content' : null)
    : undefined;
}

async function apply(
  ctx: ToolContext,
  noteId: string,
  patch: NotePatch,
  /**
   * Whether this change could destroy censored text. Defaults to a body change or a move to
   * the trash; archiving passes false, and restoring from the trash is not destructive either.
   */
  destructive = patch.body !== undefined || patch.trashed === true,
): Promise<Note> {
  // The guard's answer reveals whether a body is censored, so only a reader may ask it.
  if (destructive && !scopesAllow(ctx.scopes, ['notes:read']))
    fail('Changing a note’s body or moving it to the trash over MCP also needs notes:read.');
  const guard = censorGuard(destructive);
  const result = await updateNote(ctx.db, ctx.userId, noteId, patch, {
    ...readOptions(ctx),
    ...(guard ? { guard } : {}),
  });
  if (!result.ok) {
    if (result.error === 'not_found') throw new ToolError('Note not found');
    if (result.error === 'censored_content') fail(CENSORED_MCP_ERROR);
    if (result.error === 'stale_revision')
      fail(
        'Note not updated: it changed after the expectedUpdatedAt you sent (stale revision). Read the note again and retry with its new updatedAt.',
      );
    throw new ToolError(`Note not updated: ${result.error}`);
  }
  await ctx.publishNoteChange?.(ctx.userId);
  return result.value;
}

const noteId = { id: { type: 'string', format: 'uuid' } };
const createArgs = noteCreateRequestSchema.pick({ title: true, body: true, tags: true });
const listArgs = noteListQuerySchema.omit({ cursor: true });
const updateArgs = z
  .object({ id: uuid, ...notePatchSchema.shape })
  .strict()
  .refine(({ id: _id, ...patch }) => notePatchWrites(patch), 'At least one field is required');
const linkArgs = z.object({ noteId: uuid, taskId: uuid }).strict();

export const NOTE_TOOLS: ToolDefinition[] = [
  {
    name: 'list_notes',
    title: 'List notes',
    description:
      'List your personal notes, pinned first and then newest first. `q` matches full words and title substrings; censored text is never searchable. Use `state` to see archived or trashed notes.',
    scopes: ['notes:read'],
    accountWide: true,
    inputSchema: schema({
      q: { type: 'string', description: 'Search words or a title substring' },
      tag: { type: 'string', description: 'Only notes carrying this tag' },
      state: {
        type: 'string',
        enum: ['active', 'archived', 'trashed'],
        description: 'Default active',
      },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 50' },
    }),
    annotations: read,
    args: listArgs,
    run: async (ctx, a: z.output<typeof listArgs>) => {
      const result = await listNotes(ctx.db, ctx.userId, a);
      if (!result.ok) throw new ToolError(`Notes not listed: ${result.error}`);
      return { ...result.value, notes: result.value.notes.map(presentSummary) };
    },
  },
  {
    name: 'get_note',
    title: 'Get a note',
    description:
      'One of your notes with its body, tags, files, backlinks and the tasks linked to it that you can see. Censored spans appear as █████.',
    scopes: ['notes:read'],
    accountWide: true,
    inputSchema: schema(noteId, ['id']),
    annotations: read,
    args: z.object({ id: uuid }).strict(),
    run: async (ctx, a: { id: string }) => ({
      note: present(
        (await getNote(ctx.db, ctx.userId, a.id, readOptions(ctx))) ?? fail('Note not found'),
      ),
    }),
  },
  {
    name: 'create_note',
    title: 'Create a note',
    description:
      'Create a personal Markdown note with an optional title, body and tags. Tags are lower-cased; a note holds at most 20.',
    scopes: ['notes:write'],
    accountWide: true,
    inputSchema: schema(
      {
        title: { type: 'string', description: 'At most 200 characters' },
        body: { type: 'string', description: 'Markdown, at most 512 KiB of UTF-8' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      [],
    ),
    annotations: add,
    args: createArgs,
    run: async (ctx, a: z.output<typeof createArgs>) => {
      const result = await createNote(ctx.db, ctx.userId, a, readOptions(ctx));
      if (!result.ok) throw new ToolError(`Note not created: ${result.error}`);
      if (result.value.created) await ctx.publishNoteChange?.(ctx.userId);
      return presentFor(ctx, result.value.note);
    },
  },
  {
    name: 'update_note',
    title: 'Update a note',
    description:
      'Change a note’s title, body, tags, pin, archived state or trashed state. Only the fields you send change. Send `expectedUpdatedAt` (the `updatedAt` you last saw) to make the write conditional: if the note has changed since, nothing is written and the call fails with a stale-revision error, so read it again and merge. MCP refuses a body change or a move to the trash when the note’s current body contains censored text, because a client cannot see or re-create it; change the body or trash it in the BokyDo app instead. REST clients with notes:write are not limited this way. Censored spans in the answer appear as █████.',
    scopes: ['notes:write'],
    accountWide: true,
    inputSchema: schema(
      {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        pinned: { type: 'boolean' },
        state: { type: 'string', enum: ['active', 'archived'] },
        trashed: { type: 'boolean', description: 'true moves it to the trash, false restores it' },
        expectedUpdatedAt: {
          type: 'string',
          format: 'date-time',
          description:
            'The `updatedAt` you last saw. The update is refused if the note has changed since.',
        },
      },
      ['id'],
    ),
    annotations: write,
    args: updateArgs,
    run: async (ctx, a: { id: string } & NotePatch) => {
      const { id, ...patch } = a;
      return presentFor(ctx, await apply(ctx, id, patch));
    },
  },
  {
    name: 'archive_note',
    title: 'Archive a note',
    description:
      'Move a note to the archive, or back to the active list with `archived: false`. Archiving is not deleting, and it is allowed even when the note has censored text.',
    scopes: ['notes:write'],
    accountWide: true,
    inputSchema: schema({ ...noteId, archived: { type: 'boolean', description: 'Default true' } }, [
      'id',
    ]),
    annotations: write,
    args: z.object({ id: uuid, archived: z.boolean().default(true) }).strict(),
    run: async (ctx, a: { id: string; archived: boolean }) =>
      presentFor(ctx, await apply(ctx, a.id, { state: a.archived ? 'archived' : 'active' }, false)),
  },
  {
    name: 'trash_note',
    title: 'Trash a note',
    description:
      'Move a note to the trash (purged after 30 days), or restore it with `trashed: false`. A note whose current body contains censored text cannot be trashed from MCP; move it to the trash in the BokyDo app. Use the web editor or REST to delete a note forever.',
    scopes: ['notes:write'],
    accountWide: true,
    inputSchema: schema({ ...noteId, trashed: { type: 'boolean', description: 'Default true' } }, [
      'id',
    ]),
    annotations: destructive,
    args: z.object({ id: uuid, trashed: z.boolean().default(true) }).strict(),
    run: async (ctx, a: { id: string; trashed: boolean }) =>
      presentFor(ctx, await apply(ctx, a.id, { trashed: a.trashed }, a.trashed)),
  },
  {
    name: 'link_note_to_task',
    title: 'Link a note to a task',
    description:
      'Link one of your notes to a task you can see. Repeating the same link is safe. The task’s detail panel shows it to you.',
    scopes: ['notes:write', 'tasks:read'],
    accountWide: true,
    inputSchema: schema(
      { noteId: { type: 'string', format: 'uuid' }, taskId: { type: 'string', format: 'uuid' } },
      ['noteId', 'taskId'],
    ),
    annotations: write,
    args: linkArgs,
    run: async (ctx, a: { noteId: string; taskId: string }) => {
      const result = await linkNoteToTask(ctx.db, ctx.userId, a.noteId, a.taskId);
      if (!result.ok)
        fail(
          result.error === 'not_found'
            ? 'Note or task not found'
            : `Note not linked: ${result.error}`,
        );
      await ctx.publishNoteChange?.(ctx.userId);
      return { linked: true, noteId: a.noteId, taskId: a.taskId };
    },
  },
  {
    name: 'unlink_note_from_task',
    title: 'Unlink a note from a task',
    description:
      'Remove the manual link between one of your notes and a task. A link written in the note body stays until the body changes.',
    scopes: ['notes:write'],
    accountWide: true,
    inputSchema: schema(
      { noteId: { type: 'string', format: 'uuid' }, taskId: { type: 'string', format: 'uuid' } },
      ['noteId', 'taskId'],
    ),
    annotations: write,
    args: linkArgs,
    run: async (ctx, a: { noteId: string; taskId: string }) => {
      const result = await unlinkNoteFromTask(ctx.db, ctx.userId, a.noteId, a.taskId);
      if (!result.ok)
        fail(
          result.error === 'not_found' ? 'Note not found' : `Note not unlinked: ${result.error}`,
        );
      await ctx.publishNoteChange?.(ctx.userId);
      return { unlinked: true, noteId: a.noteId, taskId: a.taskId };
    },
  },
];
