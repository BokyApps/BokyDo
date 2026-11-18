import type { NoteSummary } from '@bokydo/shared';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { cleanFilename, INLINE_TYPES, sniff, type AttachmentStore } from '../attachments/store.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { noteFiles, notes } from '../db/schema.js';
import { requireUser } from '../http/access.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { EventBus } from '../sync/events.js';
import {
  createNote,
  deleteNote,
  getNote,
  linkNoteToTask,
  listNotes,
  listNoteTags,
  notesForTask,
  purgeNotes,
  unlinkNoteFromTask,
  updateNote,
} from './service.js';

/** Per-user limits for note files (ADR 0025): 1 GiB and 2,000 files in total. */
export const NOTE_FILES_QUOTA_BYTES = 1024 * 1024 * 1024;
export const NOTE_FILES_QUOTA_COUNT = 2000;

const idParams = z.object({ id: z.uuid() }).strict();
const noteTaskParams = z.object({ id: z.uuid(), taskId: z.uuid() }).strict();
const taskParams = z.object({ taskId: z.uuid() }).strict();
const downloadQuery = z.object({ inline: z.enum(['1']).optional() }).strict();

/**
 * Notes (ADR 0025): personal Markdown notes with tags, note/task links and files. Everything is
 * owner-scoped, uses the notes scopes, and refuses project-limited tokens like habits do. The
 * returned function is the purge job, also run hourly and exposed on `services.purgeNotes`.
 */
export async function registerNoteRoutes(
  app: FastifyInstance,
  deps: { db: Database; settings: SettingsService; events?: EventBus; store: AttachmentStore },
): Promise<() => Promise<void>> {
  const { db, settings, events, store } = deps;
  const accountWide = (scope: 'notes:read' | 'notes:write') => ({
    config: { access: 'user' as const, scopes: [scope] },
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.token?.projectIds) return reply.status(403).send({ error: 'project_limited_token' });
    },
  });
  const publish = (userId: string) =>
    events
      ?.publish({ projectIds: new Set(), userIds: new Set([userId]) })
      .catch((err: unknown) => app.log.warn({ err }, 'note event publish failed'));
  const uploads = new RateLimiter({
    windowMs: 3600_000,
    maxPerWindow: 120,
    freeFailures: 0,
    maxBackoffMs: 0,
  });

  app.get('/api/v1/notes', accountWide('notes:read'), async (req, reply) => {
    const result = await listNotes(db, requireUser(req).id, req.query);
    if (!result.ok) return reply.status(400).send({ error: result.error });
    return result.value;
  });

  app.get('/api/v1/notes/tags', accountWide('notes:read'), async (req) =>
    listNoteTags(db, requireUser(req).id),
  );

  app.post('/api/v1/notes', accountWide('notes:write'), async (req, reply) => {
    const userId = requireUser(req).id;
    const result = await createNote(db, userId, req.body);
    if (!result.ok)
      return reply
        .status(result.error === 'id_conflict' ? 409 : result.error === 'not_found' ? 404 : 400)
        .send({ error: result.error });
    if (result.value.created) await publish(userId);
    return reply.status(result.value.created ? 201 : 200).send({ note: result.value.note });
  });

  app.get('/api/v1/notes/:id', accountWide('notes:read'), async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const note = await getNote(db, requireUser(req).id, params.data.id);
    if (!note) return reply.status(404).send({ error: 'not_found' });
    return { note };
  });

  app.patch('/api/v1/notes/:id', accountWide('notes:write'), async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireUser(req).id;
    const result = await updateNote(db, userId, params.data.id, req.body);
    if (!result.ok)
      return reply.status(result.error === 'not_found' ? 404 : 400).send({ error: result.error });
    await publish(userId);
    return { note: result.value };
  });

  app.delete('/api/v1/notes/:id', accountWide('notes:write'), async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireUser(req).id;
    const result = await deleteNote(db, userId, params.data.id);
    if (!result.ok) return reply.status(404).send({ error: 'not_found' });
    for (const fileId of result.value.fileIds) await store.remove(fileId);
    await publish(userId);
    return reply.status(204).send();
  });

  app.put('/api/v1/notes/:id/tasks/:taskId', accountWide('notes:write'), async (req, reply) => {
    const params = noteTaskParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireUser(req).id;
    const result = await linkNoteToTask(db, userId, params.data.id, params.data.taskId);
    if (!result.ok)
      return reply.status(result.error === 'not_found' ? 404 : 400).send({ error: result.error });
    await publish(userId);
    return reply.status(204).send();
  });

  app.delete('/api/v1/notes/:id/tasks/:taskId', accountWide('notes:write'), async (req, reply) => {
    const params = noteTaskParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireUser(req).id;
    const result = await unlinkNoteFromTask(db, userId, params.data.id, params.data.taskId);
    if (!result.ok)
      return reply.status(result.error === 'not_found' ? 404 : 400).send({ error: result.error });
    await publish(userId);
    return reply.status(204).send();
  });

  app.get('/api/v1/tasks/:taskId/notes', accountWide('notes:read'), async (req, reply) => {
    const params = taskParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const result = await notesForTask(db, requireUser(req).id, params.data.taskId);
    if (!result.ok) return reply.status(404).send({ error: 'not_found' });
    return { notes: result.value } satisfies { notes: NoteSummary[] };
  });

  // Raw uploads stream straight to the note-files directory, like attachments. This plugin has
  // no JSON parser, so the large body limit cannot buffer a request in memory.
  await app.register(async (scoped) => {
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
      done(null, payload),
    );

    scoped.post(
      '/api/v1/notes/:id/files',
      { ...accountWide('notes:write'), bodyLimit: 101 * 1024 * 1024 },
      async (req, reply) => {
        const params = idParams.safeParse(req.params);
        if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
        if (req.headers['content-type'] !== 'application/octet-stream')
          return reply.status(415).send({ error: 'unsupported_media_type' });
        const maxMb = settings.get('attachments.maxSizeMb');
        if (maxMb === 0) return reply.status(403).send({ error: 'uploads_disabled' });
        const me = requireUser(req);
        if (!uploads.attempt(me.id).allowed)
          return reply.status(429).send({ error: 'rate_limited' });
        const [note] = await db
          .select({ id: notes.id })
          .from(notes)
          .where(
            and(
              eq(notes.id, params.data.id),
              eq(notes.ownerUserId, me.id),
              isNull(notes.trashedAt),
            ),
          );
        if (!note) return reply.status(404).send({ error: 'not_found' });
        const [usage] = await db
          .select({ files: count(), bytes: sql<string>`coalesce(sum(${noteFiles.size}), 0)` })
          .from(noteFiles)
          .where(eq(noteFiles.ownerUserId, me.id));
        if (
          Number(usage?.files ?? 0) >= NOTE_FILES_QUOTA_COUNT ||
          Number(usage?.bytes ?? 0) >= NOTE_FILES_QUOTA_BYTES
        )
          return reply.status(429).send({ error: 'limit_exceeded' });

        const id = newId();
        const written = await store.write(id, req.body as Readable, maxMb * 1024 * 1024);
        if (!written) return reply.status(413).send({ error: 'too_large', maxMb });
        if (written.size === 0) {
          await store.remove(id);
          return reply.status(400).send({ error: 'empty_file' });
        }
        const filename = cleanFilename(req.headers['x-filename'] as string | undefined);
        const { type } = sniff(written.head);
        await db.insert(noteFiles).values({
          id,
          noteId: note.id,
          ownerUserId: me.id,
          filename,
          contentType: type,
          size: written.size,
          sha256: written.sha256,
        });
        await publish(me.id);
        return reply.status(201).send({ id, filename, contentType: type, size: written.size });
      },
    );
  });

  app.get('/api/v1/note-files/:id', accountWide('notes:read'), async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const query = downloadQuery.safeParse(req.query);
    if (!params.success || !query.success)
      return reply.status(400).send({ error: 'validation_failed' });
    const me = requireUser(req);
    const [file] = await db
      .select({ file: noteFiles })
      .from(noteFiles)
      .innerJoin(notes, eq(notes.id, noteFiles.noteId))
      .where(
        and(
          eq(noteFiles.id, params.data.id),
          eq(noteFiles.ownerUserId, me.id),
          eq(notes.ownerUserId, me.id),
        ),
      );
    if (!file) return reply.status(404).send({ error: 'not_found' });
    const inline = query.data.inline === '1' && INLINE_TYPES.has(file.file.contentType);
    const encoded = encodeURIComponent(file.file.filename).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16)}`,
    );
    return reply
      .header('content-type', file.file.contentType)
      .header('content-length', String(file.file.size))
      .header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encoded}`,
      )
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('x-content-type-options', 'nosniff')
      .send(store.read(file.file.id));
  });

  const purge = () => purgeNotes(db, store);
  const timer = setInterval(
    () => void purge().catch((err: unknown) => app.log.warn({ err }, 'note purge failed')),
    3600_000,
  );
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
  return purge;
}
