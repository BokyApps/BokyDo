import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { cleanFilename, type AttachmentStore } from '../attachments/store.js';
import type { Database } from '../db/client.js';
import { noteFiles, notes } from '../db/schema.js';
import { requireUser } from '../http/access.js';
import { safeEntryName, ZipWriter } from '../zip/zip-writer.js';
import { countBlocks, documentFileIds, MAX_BLOCKS, parseNoteBody } from './ast.js';
import { buildDocx } from './docx.js';
import { loadNoteImages, type NoteFileRow } from './images.js';
import { renderNoteMarkdown } from './markdown.js';
import { buildPdf } from './pdf.js';

/**
 * Per-note export (ADR 0025): Markdown (zipped when the note has files), DOCX and PDF, rendered
 * on the server so API clients get the same output as the web app. Only the owner can export,
 * in any state including the trash; project-limited tokens are refused like the notes routes.
 */

export interface NoteExportDeps {
  db: Database;
  /** `<dataDir>/note-files`: note files live apart from comment attachments. */
  store: AttachmentStore;
}

const idParams = z.object({ id: z.uuid() }).strict();
const exportQuery = z.object({ format: z.enum(['md', 'docx', 'pdf']).default('md') });

const CONTENT_TYPES = {
  md: 'text/markdown; charset=utf-8',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
} as const;

type Format = 'md' | 'docx' | 'pdf';

/** A filename that is safe in a header: ASCII fallback plus RFC 5987 `filename*`. */
export function exportFilename(title: string, extension: string): string {
  const base = cleanedBase(title);
  const encoded = encodeURIComponent(`${base}.${extension}`).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="note.${extension}"; filename*=UTF-8''${encoded}`;
}

/** The cleaned title, or `note` when there is nothing usable (`../`, dot-only, blank). */
function cleanedBase(title: string): string {
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return 'note';
  const cleaned = cleanFilename(trimmed);
  return cleaned === 'file' ? 'note' : cleaned;
}

function sendFile(
  reply: FastifyReply,
  type: string,
  extension: string,
  title: string,
  body: string | Readable,
): FastifyReply {
  return reply
    .header('content-type', type)
    .header('content-disposition', exportFilename(title, extension))
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'no-store')
    .send(body);
}

export function registerNoteExportRoutes(app: FastifyInstance, deps: NoteExportDeps): void {
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
    const format: Format = query.data.format;
    const userId = requireUser(req).id;

    // Any state is exportable by its owner, including archived and trashed notes.
    const [note] = await deps.db
      .select({ id: notes.id, title: notes.title, body: notes.body })
      .from(notes)
      .where(and(eq(notes.id, params.data.id), eq(notes.ownerUserId, userId)));
    if (!note) return reply.status(404).send({ error: 'not_found' });

    const files = await deps.db
      .select({
        id: noteFiles.id,
        filename: noteFiles.filename,
        size: noteFiles.size,
        contentType: noteFiles.contentType,
        createdAt: noteFiles.createdAt,
      })
      .from(noteFiles)
      .where(
        and(
          eq(noteFiles.noteId, note.id),
          eq(noteFiles.ownerUserId, userId),
          eq(noteFiles.status, 'ready'),
        ),
      );

    const doc = parseNoteBody(note.body);
    if (countBlocks(doc.blocks) > MAX_BLOCKS) return reply.status(413).send({ error: 'too_large' });

    const fileNames = new Map(files.map((file) => [file.id, file.filename]));

    if (format === 'md') {
      const referenced = documentFileIds(doc.blocks);
      // The body may reference a file that was already purged; only real rows are exported.
      const exported = files.filter((file) => referenced.has(file.id));
      if (exported.length === 0) {
        const markdown = renderNoteMarkdown(note.title, doc, { fileNames });
        return sendFile(reply, CONTENT_TYPES.md, 'md', note.title, markdown);
      }
      return sendMarkdownZip(reply, deps, note.title, doc, exported);
    }

    const wanted = documentFileIds(doc.blocks);
    const { images, tooLarge } = await loadNoteImages(deps.store, files, wanted);
    if (tooLarge) return reply.status(413).send({ error: 'too_large' });
    const context = { images, fileNames };
    if (format === 'docx')
      return sendFile(
        reply,
        CONTENT_TYPES.docx,
        'docx',
        note.title,
        buildDocx(note.title, doc.blocks, context),
      );
    return sendFile(
      reply,
      CONTENT_TYPES.pdf,
      'pdf',
      note.title,
      buildPdf(note.title, doc.blocks, context),
    );
  });
}

/** A note that references files: `«title».md` plus `files/<id>-<name>`, links rewritten. */
function sendMarkdownZip(
  reply: FastifyReply,
  deps: NoteExportDeps,
  title: string,
  doc: ReturnType<typeof parseNoteBody>,
  files: readonly NoteFileRow[],
): FastifyReply {
  const entryNames = new Map<string, string>();
  for (const file of files) {
    entryNames.set(file.id, safeEntryName(`files/${file.id}-${cleanFilename(file.filename)}`));
  }
  // A URL for the link: each path segment escaped, so `#`, `?` and spaces in a filename work.
  const url = (entry: string) => entry.split('/').map(encodeURIComponent).join('/');
  const fileUrls = new Map([...entryNames].map(([id, entry]) => [id, url(entry)] as const));
  // Links the body no longer resolves to a file for keep their label, not a broken path.
  const fileNames = new Map(files.map((file) => [file.id, file.filename]));
  const markdown = renderNoteMarkdown(title, doc, { fileUrls, fileNames });
  const mdName = `${safeEntryName(cleanedBase(title))}.md`;

  const zip = new ZipWriter();
  void (async () => {
    await zip.add(mdName, markdown);
    for (const file of files) {
      const entry = entryNames.get(file.id);
      if (!entry) continue;
      try {
        await zip.add(entry, deps.store.read(file.id));
      } catch {
        // A note file missing from disk must not sink the whole export; the body still names it.
      }
    }
    await zip.finish();
  })().catch((err: unknown) => zip.abort(err instanceof Error ? err : new Error('export failed')));

  return sendFile(reply, CONTENT_TYPES.zip, 'zip', title, zip.stream);
}
