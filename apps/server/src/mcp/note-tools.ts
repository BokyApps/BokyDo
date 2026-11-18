import {
  CENSOR_TOKEN,
  noteCreateRequestSchema,
  noteListQuerySchema,
  notePatchSchema,
  parseCensorToken,
  redactCensored,
  scopesAllow,
  type Note,
  type NotePatch,
} from '@bokydo/shared';
import { z } from 'zod';
import {
  createNote,
  getNote,
  linkNoteToTask,
  listNotes,
  unlinkNoteFromTask,
  updateNote,
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
 * What MCP may see of a note: the body with every censored span replaced by `█████`. The
 * ciphertext tokens are never sent to a client, so an AI cannot copy them elsewhere, and the
 * server holds no key to the cleartext either.
 */
function present(note: Note): Omit<Note, 'body'> & { body: string } {
  return { ...note, body: redactCensored(note.body) };
}

/** A write-only token may change a note but must not read one back, as over REST. */
function presentFor(ctx: ToolContext, note: Note) {
  return scopesAllow(ctx.scopes, ['notes:read'])
    ? { note: present(note) }
    : { note: { id: note.id, updatedAt: note.updatedAt } };
}

async function apply(
  ctx: ToolContext,
  noteId: string,
  patch: NotePatch,
  checkCensored = false,
): Promise<Note> {
  if (checkCensored && patch.body !== undefined) {
    const body = patch.body;
    const current = await getNote(ctx.db, ctx.userId, noteId);
    if (!current) throw new ToolError('Note not found');
    // A censor token cannot be re-created by an AI: it has no password and no key. Dropping one
    // would destroy text the user can never get back, so refuse rather than silently lose it.
    const missing = (current.body.match(CENSOR_TOKEN) ?? []).filter(
      (token) => parseCensorToken(token) !== null && !body.includes(token),
    );
    if (missing.length)
      fail(
        'The new body would remove censored text, which cannot be re-created by an AI client. ' +
          'Keep every {{censored:v1:…}} token exactly as it is, or ask the user to uncensor it in the web editor first.',
      );
  }
  const result = await updateNote(ctx.db, ctx.userId, noteId, patch);
  if (!result.ok)
    throw new ToolError(
      result.error === 'not_found' ? 'Note not found' : `Note not updated: ${result.error}`,
    );
  await ctx.publishNoteChange?.(ctx.userId);
  return result.value;
}

const noteId = { id: { type: 'string', format: 'uuid' } };
const createArgs = noteCreateRequestSchema.pick({ title: true, body: true, tags: true });
const listArgs = noteListQuerySchema.omit({ cursor: true });
const updateArgs = z
  .object({ id: uuid, ...notePatchSchema.shape })
  .strict()
  .refine(
    ({ id: _id, ...patch }) => Object.keys(patch).length > 0,
    'At least one field is required',
  );
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
      return result.value;
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
        (await getNote(ctx.db, ctx.userId, a.id, {
          // A token without `tasks:read` must not read task text through a note.
          linkedTasks: scopesAllow(ctx.scopes, ['tasks:read']),
        })) ?? fail('Note not found'),
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
      const result = await createNote(ctx.db, ctx.userId, a);
      if (!result.ok) throw new ToolError(`Note not created: ${result.error}`);
      if (result.value.created) await ctx.publishNoteChange?.(ctx.userId);
      return presentFor(ctx, result.value.note);
    },
  },
  {
    name: 'update_note',
    title: 'Update a note',
    description:
      'Change a note’s title, body, tags, pin, archived state or trashed state. Only the fields you send change. A body that drops censored text is refused, because an AI client cannot re-create it.',
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
      },
      ['id'],
    ),
    annotations: write,
    args: updateArgs,
    run: async (ctx, a: { id: string } & NotePatch) => {
      const { id, ...patch } = a;
      return presentFor(ctx, await apply(ctx, id, patch, true));
    },
  },
  {
    name: 'archive_note',
    title: 'Archive a note',
    description:
      'Move a note to the archive, or back to the active list with `archived: false`. Archiving is not deleting.',
    scopes: ['notes:write'],
    accountWide: true,
    inputSchema: schema({ ...noteId, archived: { type: 'boolean', description: 'Default true' } }, [
      'id',
    ]),
    annotations: write,
    args: z.object({ id: uuid, archived: z.boolean().default(true) }).strict(),
    run: async (ctx, a: { id: string; archived: boolean }) =>
      presentFor(ctx, await apply(ctx, a.id, { state: a.archived ? 'archived' : 'active' })),
  },
  {
    name: 'trash_note',
    title: 'Trash a note',
    description:
      'Move a note to the trash (purged after 30 days), or restore it with `trashed: false`. Use the web editor or REST to delete a note forever.',
    scopes: ['notes:write'],
    accountWide: true,
    inputSchema: schema({ ...noteId, trashed: { type: 'boolean', description: 'Default true' } }, [
      'id',
    ]),
    annotations: destructive,
    args: z.object({ id: uuid, trashed: z.boolean().default(true) }).strict(),
    run: async (ctx, a: { id: string; trashed: boolean }) =>
      presentFor(ctx, await apply(ctx, a.id, { trashed: a.trashed })),
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
