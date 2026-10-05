import { and, count, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { attachments, comments } from '../db/schema.js';
import { requireSession } from '../http/access.js';
import type { SettingsService } from '../settings/settings-service.js';
import { can, projectAccess } from '../sync/policy.js';
import { cleanFilename, INLINE_TYPES, sniff, type AttachmentStore } from './store.js';

const idParams = z.object({ id: z.uuid() }).strict();
const download = z.object({ inline: z.enum(['1']).optional() }).strict();

export const MAX_ATTACHMENTS_PER_PROJECT = 5000;
const PENDING_TTL_MS = 24 * 3600 * 1000;

/**
 * Attachments: upload first (to a project you can comment in), then name the upload in a
 * comment. Downloads re-check project access every time, so removed members lose access at once.
 */
export async function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: { db: Database; settings: SettingsService; store: AttachmentStore },
): Promise<() => Promise<void>> {
  const { db, settings, store } = deps;
  const uploads = new RateLimiter({
    windowMs: 3600_000,
    maxPerWindow: 120,
    freeFailures: 0,
    maxBackoffMs: 0,
  });

  await app.register(async (scoped) => {
    // Raw bodies stream straight to disk; nothing is buffered in memory. No other parser is
    // allowed here: the large body limit must not let a JSON body be buffered whole.
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
      done(null, payload),
    );

    scoped.post(
      '/api/v1/projects/:id/attachments',
      { config: { access: 'user' }, bodyLimit: 101 * 1024 * 1024 },
      async (req, reply) => {
        const params = idParams.safeParse(req.params);
        if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
        if (req.headers['content-type'] !== 'application/octet-stream')
          return reply.status(415).send({ error: 'unsupported_media_type' });
        const maxMb = settings.get('attachments.maxSizeMb');
        if (maxMb === 0) return reply.status(403).send({ error: 'uploads_disabled' });
        const me = requireSession(req).user;
        if (!uploads.attempt(me.id).allowed)
          return reply.status(429).send({ error: 'rate_limited' });
        const access = await projectAccess(db, me.id, params.data.id);
        if (!access) return reply.status(404).send({ error: 'not_found' });
        if (!can(access.role, 'comment') || access.project.isArchived)
          return reply.status(403).send({ error: 'forbidden' });
        const [n] = await db
          .select({ n: count() })
          .from(attachments)
          .where(and(eq(attachments.projectId, access.project.id), isNull(attachments.deletedAt)));
        if ((n?.n ?? 0) >= MAX_ATTACHMENTS_PER_PROJECT)
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
        await db.insert(attachments).values({
          id,
          projectId: access.project.id,
          uploaderId: me.id,
          filename,
          contentType: type,
          size: written.size,
          sha256: written.sha256,
        });
        return reply.status(201).send({ id, filename, contentType: type, size: written.size });
      },
    );
  });

  app.get('/api/v1/attachments/:id', { config: { access: 'user' } }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const query = download.safeParse(req.query);
    if (!params.success || !query.success)
      return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    const [row] = await db
      .select({ file: attachments, commentDeleted: comments.deletedAt })
      .from(attachments)
      .leftJoin(comments, eq(comments.id, attachments.commentId))
      .where(and(eq(attachments.id, params.data.id), isNull(attachments.deletedAt)));
    // Pending uploads are visible to their uploader only; attached ones to project members.
    const visible =
      row &&
      (row.file.commentId ? row.commentDeleted === null : row.file.uploaderId === me.id) &&
      (await projectAccess(db, me.id, row.file.projectId)) !== null;
    if (!row || !visible) return reply.status(404).send({ error: 'not_found' });
    const inline = query.data.inline === '1' && INLINE_TYPES.has(row.file.contentType);
    const encoded = encodeURIComponent(row.file.filename).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16)}`,
    );
    return reply
      .header('content-type', row.file.contentType)
      .header('content-length', String(row.file.size))
      .header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encoded}`,
      )
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('x-content-type-options', 'nosniff')
      .send(store.read(row.file.id));
  });

  /**
   * Clean up files: unclaimed uploads past their TTL and attachments of deleted comments are
   * marked deleted, then every deleted attachment's file is removed and its row dropped.
   * Finally, stray files with no row (e.g. after a project was deleted) are removed.
   */
  const purge = async () => {
    await db
      .update(attachments)
      .set({ deletedAt: new Date() })
      .where(
        and(
          isNull(attachments.deletedAt),
          or(
            and(
              isNull(attachments.commentId),
              lt(attachments.createdAt, new Date(Date.now() - PENDING_TTL_MS)),
            ),
            sql`exists (select 1 from comments c where c.id = "attachments"."comment_id" and c.deleted_at is not null)`,
          ),
        ),
      );
    const gone = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(isNotNull(attachments.deletedAt));
    for (const a of gone) {
      await store.remove(a.id);
      await db.delete(attachments).where(eq(attachments.id, a.id));
    }
    const onDisk = await store.list(PENDING_TTL_MS);
    if (onDisk.length === 0) return;
    const live = new Set(
      (await db.select({ id: attachments.id }).from(attachments)).map((r) => r.id),
    );
    for (const name of onDisk)
      if (!live.has(name.replace(/\.part$/, ''))) await store.removeName(name);
  };
  const timer = setInterval(
    () => void purge().catch((err: unknown) => app.log.warn({ err }, 'attachment purge failed')),
    3600_000,
  );
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
  return purge;
}
