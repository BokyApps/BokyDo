import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Transform, type Readable } from 'node:stream';
import { z } from 'zod';
import type { AttachmentStore } from '../attachments/store.js';
import type { Database } from '../db/client.js';
import { requireUser } from '../http/access.js';
import {
  ExportBusyError,
  ExportNotFoundError,
  exportFilename,
  runNoteExport,
  type NoteExportFormat,
} from './export.js';
import {
  DEFAULT_EXPORT_LIMITS,
  ExportTimeoutError,
  TooLargeError,
  type ExportLimits,
} from './limits.js';

/**
 * Per-note export (ADR 0025): Markdown (zipped when the note has files), DOCX and PDF, rendered
 * on the server so API clients get the same output as the web app. Only the owner can export,
 * in any state including the trash; project-limited tokens are refused like the notes routes.
 *
 * This module is only the HTTP edge: it maps the pipeline's errors to status codes, wraps the
 * response stream in the byte cap, and makes sure nothing a renderer emits can escape as an
 * uncaught exception or an unhandled `'error'` event.
 */

export interface NoteExportRouteDeps {
  db: Database;
  /** `<dataDir>/note-files`: note files live apart from comment attachments. */
  store: AttachmentStore;
  limits?: Partial<ExportLimits>;
}

const idParams = z.object({ id: z.uuid() }).strict();
const exportQuery = z.object({ format: z.enum(['md', 'docx', 'pdf']).default('md') });

export function registerNoteExportRoutes(app: FastifyInstance, deps: NoteExportRouteDeps): void {
  const accountWide = {
    config: { access: 'user' as const, scopes: ['notes:read'] as const },
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.token?.projectIds) return reply.status(403).send({ error: 'project_limited_token' });
    },
  };

  app.get('/api/v1/notes/:id/export', accountWide, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const query = exportQuery.safeParse(req.query);
    if (!params.success || !query.success)
      return reply.status(400).send({ error: 'validation_failed' });
    const format: NoteExportFormat = query.data.format;
    const userId = requireUser(req).id;

    let output: Awaited<ReturnType<typeof runNoteExport>>;
    try {
      output = await runNoteExport(
        { db: deps.db, store: deps.store, ...(deps.limits ? { limits: deps.limits } : {}) },
        { noteId: params.data.id, userId, format },
      );
    } catch (err) {
      if (err instanceof ExportNotFoundError) return reply.status(404).send({ error: 'not_found' });
      if (err instanceof ExportBusyError) return reply.status(429).send({ error: 'export_busy' });
      if (err instanceof ExportTimeoutError)
        return reply.status(503).send({ error: 'export_timeout' });
      if (err instanceof TooLargeError) return reply.status(413).send({ error: 'too_large' });
      throw err;
    }

    const maxBytes = deps.limits?.maxOutputBytes ?? DEFAULT_EXPORT_LIMITS.maxOutputBytes;
    // A buffered body can still be refused with a status, before any header is committed.
    if (typeof output.body === 'string') {
      const body = Buffer.from(output.body, 'utf8');
      if (body.length > maxBytes) {
        output.done();
        return reply.status(413).send({ error: 'too_large' });
      }
      setHeaders(reply, output);
      output.done();
      return reply.send(body);
    }

    setHeaders(reply, output);
    sendStream(reply, output.body, output.done, maxBytes);
    return reply;
  });
}

/** The headers every export carries, whatever the format. */
function setHeaders(
  reply: FastifyReply,
  output: { contentType: string; extension: string; title: string },
): void {
  reply
    .header('content-type', output.contentType)
    .header('content-disposition', exportFilename(output.title, output.extension))
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'no-store');
}

/**
 * Pass `source` through, counting bytes and failing once `maxBytes` is passed: the size of a
 * streamed export is only known while it is being written, so the only way to enforce it is to
 * break the response. Exported for its own test.
 */
export function capOutputBytes(source: Readable, maxBytes: number): Transform {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new TooLargeError(`export exceeded ${maxBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
  source.on('error', (err: Error) => limiter.destroy(err));
  source.pipe(limiter);
  return limiter;
}

/**
 * Send a render stream under a byte cap, and close it down cleanly:
 *
 * - every error on the source, the limiter and the raw response has a listener, so a renderer
 *   that throws from a callback cannot take the process with it;
 * - past the byte cap the response is destroyed (the size is only known while streaming);
 * - when the client disconnects, the source is destroyed so a zip producer stops instead of
 *   waiting for a `'drain'` that will never come.
 */
function sendStream(
  reply: FastifyReply,
  source: Readable,
  done: () => void,
  maxBytes: number,
): void {
  const finishOnce = once(done);
  // The client may already be gone by the time a slow render is ready; a producer started now
  // would wait on a response nobody reads.
  if (reply.raw.destroyed) {
    source.destroy();
    finishOnce();
    return;
  }
  const limiter = capOutputBytes(source, maxBytes);
  limiter.on('error', () => {
    // The archive is already broken; a half-written response is worse than none.
    reply.raw.destroy();
    if (!source.destroyed) source.destroy();
    finishOnce();
  });
  limiter.on('end', finishOnce);
  limiter.on('close', finishOnce);
  reply.raw.on('close', () => {
    if (!source.destroyed) source.destroy();
    limiter.destroy();
    finishOnce();
  });

  try {
    reply.send(limiter);
  } catch (err) {
    // The reply was already committed: stop the producer and give the slot back.
    if (!source.destroyed) source.destroy();
    finishOnce();
    throw err;
  }
}

/** Wrap a callback so it runs at most once, whatever ends the response first. */
function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
