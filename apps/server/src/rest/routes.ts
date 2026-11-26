import type { ApiScope, CommandError, CommandType } from '@bokydo/shared';
import {
  colorSchema,
  commandArgs,
  dueSchema,
  idSchema,
  habitPeriodSchema,
  habitCreateRequestSchema,
  habitPatchSchema,
  habitCheckInSchema,
  noteCreateRequestSchema,
  noteDisplayStateSchema,
  noteListQuerySchema,
  notePatchSchema,
  orderKeySchema,
  prioritySchema,
  projectVisibilitySchema,
  roleSchema,
  viewStyleSchema,
} from '@bokydo/shared';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { projects, tasks } from '../db/schema.js';
import { callerScope, requireUser } from '../http/access.js';
import { visibleProjects, type ProjectScope } from '../sync/policy.js';
import { projectToWire, taskToWire } from '../sync/serialize.js';
import type { SyncService } from '../sync/sync-service.js';

// ---------------------------------------------------------------------------------------------
// Wire shapes. These mirror the sync payloads (packages/shared model.ts) and exist so the
// OpenAPI document describes the real response bodies; the routes themselves do not re-parse
// what they just serialised.
// ---------------------------------------------------------------------------------------------

const taskResource = z.object({
  id: idSchema,
  projectId: idSchema,
  sectionId: idSchema.nullable(),
  parentId: idSchema.nullable(),
  content: z.string(),
  description: z.string(),
  priority: prioritySchema,
  due: dueSchema.nullable(),
  deadline: z.string().nullable(),
  durationMinutes: z.number().int().nullable(),
  /** Label names (labels are referenced by name, like in quick add). */
  labels: z.array(z.string()),
  assigneeId: idSchema.nullable(),
  assignedById: idSchema.nullable(),
  childOrder: orderKeySchema,
  isCompleted: z.boolean(),
  completedAt: z.iso.datetime().nullable(),
  /** Null once the creator's account has been deleted (ADR 0013). */
  createdById: idSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const projectResource = z.object({
  id: idSchema,
  name: z.string(),
  color: colorSchema,
  parentId: idSchema.nullable(),
  childOrder: orderKeySchema,
  viewStyle: viewStyleSchema,
  isInbox: z.boolean(),
  isArchived: z.boolean(),
  isFavorite: z.boolean(),
  role: roleSchema,
  workspaceId: idSchema.nullable(),
  folderId: idSchema.nullable(),
  visibility: projectVisibilitySchema,
  updatedAt: z.iso.datetime(),
});

const listTasksQuery = z
  .object({
    /** Only this project; without it, every project you can see. */
    projectId: idSchema.optional(),
    completed: z.enum(['true', 'false']).default('false'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Opaque `nextCursor` from the previous page. */
    cursor: idSchema.optional(),
  })
  .strict();

const taskList = z.object({ tasks: z.array(taskResource), nextCursor: idSchema.nullable() });
const taskSingle = z.object({ task: taskResource });
const projectList = z.object({ projects: z.array(projectResource) });
const projectSingle = z.object({ project: projectResource });

// Notes (ADR 0025). The response shapes mirror `packages/shared/src/notes.ts`; the request
// schemas are shared, so REST cannot accept a body the notes service would reject.
const noteSummaryResource = z.object({
  id: idSchema,
  title: z.string(),
  /** Plain text from the body, censored spans replaced, at most 200 characters. */
  snippet: z.string(),
  tags: z.array(z.string()),
  state: noteDisplayStateSchema,
  pinned: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const notePreviewRun = z.object({
  text: z.string(),
  bold: z.literal(true).optional(),
  italic: z.literal(true).optional(),
  strike: z.literal(true).optional(),
  code: z.literal(true).optional(),
  link: z.literal(true).optional(),
});
/** List entries also carry the formatted start of the body for note cards (redacted, bounded). */
const noteListEntryResource = noteSummaryResource.extend({
  preview: z.array(
    z.object({
      kind: z.enum([
        'paragraph',
        'h1',
        'h2',
        'h3',
        'quote',
        'bullet',
        'ordered',
        'task',
        'code',
        'blank',
      ]),
      runs: z.array(notePreviewRun),
      depth: z.number().int().optional(),
      number: z.number().int().optional(),
      checked: z.boolean().optional(),
    }),
  ),
});
const noteResource = noteSummaryResource.extend({
  body: z.string(),
  trashedAt: z.iso.datetime().nullable(),
  backlinks: z.array(z.object({ id: idSchema, title: z.string() })),
  linkedTasks: z.array(
    z.object({
      id: idSchema,
      content: z.string(),
      projectId: idSchema,
      completed: z.boolean(),
      sources: z.array(z.enum(['body', 'manual'])),
    }),
  ),
  files: z.array(
    z.object({
      id: idSchema,
      filename: z.string(),
      contentType: z.string(),
      size: z.number().int(),
    }),
  ),
});
const noteList = z.object({
  notes: z.array(noteListEntryResource),
  nextCursor: z.string().nullable(),
});
const noteSingle = z.object({ note: noteResource });
/** What a write-only token gets back: identity, without a body it may not read. */
const noteReceipt = z.object({
  note: z.object({ id: idSchema, updatedAt: z.iso.datetime() }),
});
const noteTags = z.object({
  tags: z.array(z.object({ tag: z.string(), count: z.number().int() })),
});
const taskNotes = z.object({
  notes: z.array(noteListEntryResource.extend({ sources: z.array(z.enum(['body', 'manual'])) })),
});
const noteFile = z.object({
  id: idSchema,
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
});

/** For tests: real responses must match what the OpenAPI document promises. */
export const RESPONSE_SCHEMAS = {
  taskList,
  taskSingle,
  projectList,
  projectSingle,
  noteList,
  noteSingle,
  noteReceipt,
  noteTags,
  taskNotes,
  noteFile,
};

/**
 * Write bodies are the sync command schemas minus the id the route supplies itself. Deriving them
 * from `commandArgs` means a REST write cannot accept something the command layer would reject, or
 * drift from it later.
 */
const createTaskBody = commandArgs.task_add.omit({ id: true });
const updateTaskBody = commandArgs.task_update.omit({ id: true });
const createProjectBody = commandArgs.project_add.omit({ id: true });
const updateProjectBody = commandArgs.project_update.omit({ id: true });

/** Command errors are the sync layer's vocabulary; this is how they surface over HTTP. */
const COMMAND_STATUS: Record<CommandError, number> = {
  invalid: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  limit_exceeded: 429,
};

// ---------------------------------------------------------------------------------------------
// Descriptors: one entry per REST operation, used both to build the OpenAPI document and to
// document the surface at /api/docs. Keeping them next to the routes is what stops the docs
// drifting from the code.
// ---------------------------------------------------------------------------------------------

interface RestOperation {
  method: 'get' | 'post' | 'patch' | 'delete' | 'put';
  /** Fastify path, with `:param` placeholders. */
  path: string;
  summary: string;
  tag: string;
  scopes: readonly ApiScope[];
  /** Overrides the default success status (204 for a DELETE, 201 for a POST). */
  status?: number;
  query?: z.ZodType;
  body?: z.ZodType;
  /** The body is raw bytes (an upload), not JSON. */
  rawBody?: true;
  /** Extra string header parameters, such as an upload's display filename. */
  headers?: Record<string, { description: string; required?: boolean }>;
  response?: z.ZodType;
  /** The success body is one of these schemas (a full note, or the write-only receipt). */
  responseOneOf?: z.ZodType[];
  /** The success response is raw bytes (a download), not JSON. */
  rawResponse?: true;
  /** Media types a raw response may use; defaults to `application/octet-stream`. */
  responseMediaTypes?: string[];
  /** Extra statuses, or overriding descriptions for the ones every operation has. */
  /**
   * Extra statuses, or overriding descriptions for the ones every operation has. `success: true`
   * gives the status the same body as the main success response (an idempotent retry's 200).
   */
  responses?: Record<string, { description: string; success?: true }>;
}

const habitResource = z.object({
  id: idSchema,
  name: z.string(),
  period: habitPeriodSchema,
  target: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  todayCompleted: z.boolean(),
  progress: z.object({
    completed: z.number().int(),
    target: z.number().int(),
    start: z.string(),
    end: z.string(),
  }),
  streak: z.object({ current: z.number().int(), unit: habitPeriodSchema }),
  history: z.array(z.object({ date: z.string(), completed: z.boolean() })),
});
const habitSingle = z.object({ habit: habitResource });

/** The notes routes refuse project-limited tokens the way habits do, with a distinct error. */
const notesForbidden = {
  description:
    'The token does not carry the required scope (`insufficient_scope`), or it is limited to projects (`project_limited_token`); notes are account-wide',
};

export const REST_OPERATIONS: RestOperation[] = [
  {
    method: 'get',
    path: '/api/v1/tasks',
    summary: 'List tasks you can see, newest first',
    tag: 'Tasks',
    scopes: ['tasks:read'],
    query: listTasksQuery,
    response: taskList,
  },
  {
    method: 'get',
    path: '/api/v1/tasks/:id',
    summary: 'One task',
    tag: 'Tasks',
    scopes: ['tasks:read'],
    response: taskSingle,
  },
  {
    method: 'post',
    path: '/api/v1/tasks',
    summary: 'Create a task',
    tag: 'Tasks',
    scopes: ['tasks:write'],
    body: createTaskBody,
    response: taskSingle,
  },
  {
    method: 'patch',
    path: '/api/v1/tasks/:id',
    summary: 'Update a task (only the fields you send change)',
    tag: 'Tasks',
    scopes: ['tasks:write'],
    body: updateTaskBody,
    response: taskSingle,
  },
  {
    method: 'post',
    path: '/api/v1/tasks/:id/complete',
    summary: 'Complete a task; a recurring task rolls forward to its next occurrence',
    tag: 'Tasks',
    scopes: ['tasks:write'],
    response: taskSingle,
  },
  {
    method: 'post',
    path: '/api/v1/tasks/:id/uncomplete',
    summary: 'Reopen a completed task',
    tag: 'Tasks',
    scopes: ['tasks:write'],
    response: taskSingle,
  },
  {
    method: 'delete',
    path: '/api/v1/tasks/:id',
    summary: 'Delete a task',
    tag: 'Tasks',
    scopes: ['tasks:write'],
  },
  {
    method: 'get',
    path: '/api/v1/projects',
    summary: 'List projects you can see',
    tag: 'Projects',
    scopes: ['projects:read'],
    response: projectList,
  },
  {
    method: 'get',
    path: '/api/v1/projects/:id',
    summary: 'One project',
    tag: 'Projects',
    scopes: ['projects:read'],
    response: projectSingle,
  },
  {
    method: 'post',
    path: '/api/v1/projects',
    summary: 'Create a project',
    tag: 'Projects',
    scopes: ['projects:write'],
    body: createProjectBody,
    response: projectSingle,
  },
  {
    method: 'patch',
    path: '/api/v1/projects/:id',
    summary: 'Update a project (name, colour, view, folder, visibility)',
    tag: 'Projects',
    scopes: ['projects:write'],
    body: updateProjectBody,
    response: projectSingle,
  },
  {
    method: 'delete',
    path: '/api/v1/projects/:id',
    summary: 'Delete a project',
    tag: 'Projects',
    scopes: ['projects:write'],
  },
  {
    method: 'get',
    path: '/api/v1/habits',
    summary: 'List your personal habits with progress, streaks and history',
    tag: 'Habits',
    scopes: ['habits:read'],
    response: z.object({ today: z.string(), habits: z.array(habitResource) }),
  },
  {
    method: 'post',
    path: '/api/v1/habits',
    summary: 'Create a personal habit (a stable id makes retries safe)',
    tag: 'Habits',
    scopes: ['habits:write'],
    body: habitCreateRequestSchema,
    response: habitSingle,
  },
  {
    method: 'patch',
    path: '/api/v1/habits/:id',
    summary: 'Update a personal habit',
    tag: 'Habits',
    scopes: ['habits:write'],
    body: habitPatchSchema,
    response: habitSingle,
  },
  {
    method: 'delete',
    path: '/api/v1/habits/:id',
    summary: 'Delete a personal habit and its check-ins',
    tag: 'Habits',
    scopes: ['habits:write'],
  },
  {
    method: 'put',
    path: '/api/v1/habits/:id/check-ins/:date',
    summary: 'Set a check-in on a local calendar date (not in the future)',
    tag: 'Habits',
    scopes: ['habits:write'],
    body: habitCheckInSchema,
    response: habitSingle,
  },
  {
    method: 'get',
    path: '/api/v1/notes',
    summary: 'List your notes, pinned first; search, tag and state filters',
    tag: 'Notes',
    scopes: ['notes:read'],
    query: noteListQuerySchema,
    response: noteList,
    responses: { '403': notesForbidden },
  },
  {
    method: 'get',
    path: '/api/v1/notes/tags',
    summary: 'Your distinct note tags with counts (trashed notes excluded)',
    tag: 'Notes',
    scopes: ['notes:read'],
    response: noteTags,
    responses: { '403': notesForbidden },
  },
  {
    method: 'post',
    path: '/api/v1/notes',
    summary: 'Create a note (a stable id makes retries safe)',
    tag: 'Notes',
    scopes: ['notes:write'],
    body: noteCreateRequestSchema,
    responseOneOf: [noteSingle, noteReceipt],
    responses: {
      '200': {
        description:
          'The note already exists with this id and exactly this content: an idempotent retry',
        success: true,
      },
      '409': {
        description:
          '`id_conflict`: this id belongs to another account, or to a note with different content',
      },
      '403': notesForbidden,
    },
  },
  {
    method: 'get',
    path: '/api/v1/notes/:id',
    summary: 'One note with its body, backlinks, linked tasks and files',
    tag: 'Notes',
    scopes: ['notes:read'],
    response: noteSingle,
    responses: { '403': notesForbidden },
  },
  {
    method: 'patch',
    path: '/api/v1/notes/:id',
    summary: 'Update a note (title, body, tags, pin, archive or trash)',
    tag: 'Notes',
    scopes: ['notes:write'],
    body: notePatchSchema,
    // A token without notes:read may write, but only gets the identity back.
    responseOneOf: [noteSingle, noteReceipt],
    responses: {
      '403': notesForbidden,
      '409': {
        description:
          '`stale_revision`: `expectedUpdatedAt` is not the current revision of the note, so nothing was written. The body is `{"error":"stale_revision"}` and, for a token with `notes:read`, the current `updatedAt` to reload and merge against.',
      },
    },
  },
  {
    method: 'delete',
    path: '/api/v1/notes/:id',
    summary: 'Delete a note forever, with its files and links',
    tag: 'Notes',
    scopes: ['notes:write'],
    status: 204,
    responses: { '403': notesForbidden },
  },
  {
    method: 'put',
    path: '/api/v1/notes/:id/tasks/:taskId',
    summary: 'Link a note to a task you can see (also needs tasks:read)',
    tag: 'Notes',
    scopes: ['notes:write', 'tasks:read'],
    status: 204,
    responses: { '403': notesForbidden },
  },
  {
    method: 'delete',
    path: '/api/v1/notes/:id/tasks/:taskId',
    summary: 'Remove a manual note-to-task link',
    tag: 'Notes',
    scopes: ['notes:write'],
    status: 204,
    responses: { '403': notesForbidden },
  },
  {
    method: 'get',
    path: '/api/v1/tasks/:taskId/notes',
    summary: 'Your own notes linked to a task you can see (also needs tasks:read)',
    tag: 'Notes',
    scopes: ['notes:read', 'tasks:read'],
    response: taskNotes,
    responses: { '403': notesForbidden },
  },
  {
    method: 'post',
    path: '/api/v1/notes/:id/files',
    summary: 'Upload a file to a note (raw bytes; filename in X-Filename)',
    tag: 'Notes',
    scopes: ['notes:write'],
    status: 201,
    rawBody: true,
    headers: {
      'X-Filename': {
        description: 'Display filename, URL-encoded; defaults to “file”. It never touches disk.',
      },
    },
    response: noteFile,
    responses: {
      '403': {
        description:
          '`uploads_disabled` when this instance disables uploads, `project_limited_token` for a project-limited token, or `insufficient_scope` without notes:write',
      },
      '413': {
        description:
          '`too_large`: the file is over `attachments.maxSizeMb`, or over the bytes left in your note-file quota',
      },
      '429': {
        description:
          '`rate_limited` (120 uploads an hour), or `limit_exceeded` when you already have the maximum number of note files or no quota bytes left',
      },
    },
  },
  {
    method: 'get',
    path: '/api/v1/note-files/:id',
    summary: 'Download a note file (?inline=1 renders PNG, JPEG, GIF and WebP inline)',
    tag: 'Notes',
    scopes: ['notes:read'],
    query: z.object({ inline: z.enum(['1']).optional() }).strict(),
    rawResponse: true,
    // Only raster images keep their detected type, and only when inline; everything else is
    // opaque binary so an SVG or HTML upload can never render as active content.
    responseMediaTypes: [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/octet-stream',
    ],
    responses: { '403': notesForbidden },
  },
];

/** Zod → JSON Schema 2020-12, which is the dialect OpenAPI 3.1 uses. */
function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function queryParameters(schema: z.ZodType): unknown[] {
  const json = toJsonSchema(schema, 'input') as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    name,
    in: 'query',
    required: (json.required ?? []).includes(name),
    schema: property,
  }));
}

const successStatus = (method: RestOperation['method']) =>
  method === 'post' ? '201' : method === 'delete' ? '204' : '200';

const binarySchema = { type: 'string', format: 'binary' };

export function buildOpenApiDocument(publicUrl: string | null): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of REST_OPERATIONS) {
    const parameters: unknown[] = [];
    for (const match of op.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
      parameters.push({
        name: match[1],
        in: 'path',
        required: true,
        schema: { type: 'string', format: match[1] === 'date' ? 'date' : 'uuid' },
      });
    }
    if (op.query) parameters.push(...queryParameters(op.query));
    for (const [name, header] of Object.entries(op.headers ?? {}))
      parameters.push({
        name,
        in: 'header',
        required: header.required ?? false,
        description: header.description,
        schema: { type: 'string' },
      });
    const path = op.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const ok = String(op.status ?? successStatus(op.method));
    const requestContent = op.rawBody
      ? { 'application/octet-stream': { schema: binarySchema } }
      : op.body
        ? { 'application/json': { schema: toJsonSchema(op.body, 'input') } }
        : null;
    const responseContent = op.rawResponse
      ? Object.fromEntries(
          (op.responseMediaTypes ?? ['application/octet-stream']).map((type) => [
            type,
            { schema: binarySchema },
          ]),
        )
      : op.responseOneOf
        ? {
            'application/json': {
              schema: { oneOf: op.responseOneOf.map((schema) => toJsonSchema(schema, 'output')) },
            },
          }
        : op.response
          ? { 'application/json': { schema: toJsonSchema(op.response, 'output') } }
          : null;
    paths[path] ??= {};
    paths[path][op.method] = {
      summary: op.summary,
      tags: [op.tag],
      security: [{ bearerAuth: [...op.scopes] }],
      ...(parameters.length ? { parameters } : {}),
      ...(op.method !== 'get' && requestContent
        ? { requestBody: { required: true, content: requestContent } }
        : {}),
      responses: {
        [ok]: {
          description: ok === '204' ? 'Deleted' : 'Success',
          ...(ok !== '204' && responseContent ? { content: responseContent } : {}),
        },
        '400': { description: 'Invalid body, query or path parameters' },
        '401': { description: 'Missing, malformed or unknown bearer token' },
        '403': { description: 'The token does not carry the required scope' },
        '404': { description: 'No such resource, or it is not visible to you' },
        ...Object.fromEntries(
          Object.entries(op.responses ?? {}).map(([status, { description, success }]) => [
            status,
            success && responseContent
              ? { description, content: responseContent }
              : { description },
          ]),
        ),
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'BokyDo REST API',
      version: '1.0.0',
      description:
        'Resource-oriented access to tasks, projects, personal habits and notes for integrations. Authenticate with a personal access token or an OAuth 2.1 access token as a bearer token; each operation needs the scope listed on it. Everything is scoped to what the token’s owner can see.',
    },
    ...(publicUrl ? { servers: [{ url: publicUrl }] } : {}),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A personal access token (Settings → API & MCP) or an OAuth 2.1 access token.',
        },
      },
    },
    paths,
  };
}

/** Plain, self-contained HTML: the CSP allows no inline script and no CDN, so no fancy UI here. */
function docsHtml(): string {
  const items = REST_OPERATIONS.map(
    (op) =>
      `<li><code>${op.method.toUpperCase()} ${op.path}</code> — ${op.summary} <em>needs <code>${op.scopes.join(' ')}</code></em></li>`,
  ).join('\n');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>BokyDo REST API</title></head>
<body>
<h1>BokyDo REST API</h1>
<p>Authenticate with <code>Authorization: Bearer &lt;token&gt;</code>. Each operation needs the scope shown.
Results are limited to what the token's owner can see (and, for a token limited to some projects, to those).</p>
<ul>
${items}
</ul>
<p><a href="/api/docs/openapi.json">OpenAPI 3.1 document</a></p>
</body>
</html>`;
}

/** Resource-oriented REST access for integrations (PLAN W10b). */
export function registerRestRoutes(
  app: FastifyInstance,
  db: Database,
  sync: SyncService,
  publicUrl: () => string | null,
): void {
  const tasksRead = { access: 'user', scopes: ['tasks:read'] } as const;
  const tasksWrite = { access: 'user', scopes: ['tasks:write'] } as const;
  const projectsRead = { access: 'user', scopes: ['projects:read'] } as const;
  const projectsWrite = { access: 'user', scopes: ['projects:write'] } as const;

  /** A task the caller can see, as it looks now: writes answer with the real resulting state. */
  const readTask = (userId: string, scope: ProjectScope, taskId: string) =>
    db.transaction(async (tx) => {
      const visible = await visibleProjects(tx, userId, scope);
      const row = (
        await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
          .limit(1)
      ).at(0);
      return row && visible.has(row.projectId) ? taskToWire(row) : null;
    });

  /** A project the caller can see, as it looks now. */
  const readProject = (userId: string, scope: ProjectScope, projectId: string) =>
    db.transaction(async (tx) => {
      const visible = await visibleProjects(tx, userId, scope);
      const member = visible.get(projectId);
      if (!member) return null;
      const row = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1)).at(
        0,
      );
      return row ? projectToWire(row, member) : null;
    });

  /** Apply one command through the sync engine and translate its vocabulary into HTTP. */
  const run = async (userId: string, scope: ProjectScope, type: CommandType, args: unknown) => {
    const result = await sync.apply(userId, type, newId(), args, scope);
    return result.ok ? null : result.error;
  };

  app.get('/api/v1/tasks', { config: tasksRead }, async (req, reply) => {
    const parsed = listTasksQuery.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_failed' });
    const { projectId, completed, limit, cursor } = parsed.data;
    const userId = requireUser(req).id;
    return db.transaction(async (tx) => {
      const visible = await visibleProjects(tx, userId, callerScope(req));
      if (projectId && !visible.has(projectId))
        return reply.status(404).send({ error: 'not_found' });
      const scope = projectId ? [projectId] : [...visible.keys()];
      if (scope.length === 0) return { tasks: [], nextCursor: null };
      const rows = await tx
        .select()
        .from(tasks)
        .where(
          and(
            inArray(tasks.projectId, scope),
            isNull(tasks.deletedAt),
            eq(tasks.isCompleted, completed === 'true'),
            cursor ? lt(tasks.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(tasks.id))
        .limit(limit);
      return {
        tasks: rows.map(taskToWire),
        nextCursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
      };
    });
  });

  app.get('/api/v1/tasks/:id', { config: tasksRead }, async (req, reply) => {
    const id = idSchema.safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.status(400).send({ error: 'validation_failed' });
    const task = await readTask(requireUser(req).id, callerScope(req), id.data);
    if (!task) return reply.status(404).send({ error: 'not_found' });
    return { task };
  });

  app.post('/api/v1/tasks', { config: tasksWrite }, async (req, reply) => {
    const body = createTaskBody.safeParse(req.body);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid', message: body.error.issues[0]?.message });
    const userId = requireUser(req).id;
    const taskId = newId();
    const failure = await run(userId, callerScope(req), 'task_add', { ...body.data, id: taskId });
    if (failure) return reply.status(COMMAND_STATUS[failure]).send({ error: failure });
    const task = await readTask(userId, callerScope(req), taskId);
    if (!task) return reply.status(404).send({ error: 'not_found' });
    return reply.status(201).send({ task });
  });

  app.patch('/api/v1/tasks/:id', { config: tasksWrite }, async (req, reply) => {
    const id = idSchema.safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.status(400).send({ error: 'validation_failed' });
    const body = updateTaskBody.safeParse(req.body);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid', message: body.error.issues[0]?.message });
    const userId = requireUser(req).id;
    const failure = await run(userId, callerScope(req), 'task_update', {
      id: id.data,
      ...body.data,
    });
    if (failure) return reply.status(COMMAND_STATUS[failure]).send({ error: failure });
    const task = await readTask(userId, callerScope(req), id.data);
    if (!task) return reply.status(404).send({ error: 'not_found' });
    return { task };
  });

  for (const [suffix, type] of [
    ['complete', 'task_complete'],
    ['uncomplete', 'task_uncomplete'],
  ] as const) {
    app.post(`/api/v1/tasks/:id/${suffix}`, { config: tasksWrite }, async (req, reply) => {
      const id = idSchema.safeParse((req.params as { id?: string }).id);
      if (!id.success) return reply.status(400).send({ error: 'validation_failed' });
      const userId = requireUser(req).id;
      const failure = await run(userId, callerScope(req), type, { id: id.data });
      if (failure) return reply.status(COMMAND_STATUS[failure]).send({ error: failure });
      const task = await readTask(userId, callerScope(req), id.data);
      if (!task) return reply.status(404).send({ error: 'not_found' });
      return { task };
    });
  }

  app.delete('/api/v1/tasks/:id', { config: tasksWrite }, async (req, reply) => {
    const id = idSchema.safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.status(400).send({ error: 'validation_failed' });
    const failure = await run(requireUser(req).id, callerScope(req), 'task_delete', {
      id: id.data,
    });
    if (failure) return reply.status(COMMAND_STATUS[failure]).send({ error: failure });
    return reply.status(204).send();
  });

  app.get('/api/v1/projects', { config: projectsRead }, async (req) => {
    const userId = requireUser(req).id;
    return db.transaction(async (tx) => {
      const visible = await visibleProjects(tx, userId, callerScope(req));
      const ids = [...visible.keys()];
      if (ids.length === 0) return { projects: [] };
      const rows = await tx.select().from(projects).where(inArray(projects.id, ids));
      return {
        projects: rows.flatMap((p) => {
          const member = visible.get(p.id);
          return member ? [projectToWire(p, member)] : [];
        }),
      };
    });
  });

  app.get('/api/v1/projects/:id', { config: projectsRead }, async (req, reply) => {
    const id = idSchema.safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.status(400).send({ error: 'validation_failed' });
    const project = await readProject(requireUser(req).id, callerScope(req), id.data);
    if (!project) return reply.status(404).send({ error: 'not_found' });
    return { project };
  });

  app.post('/api/v1/projects', { config: projectsWrite }, async (req, reply) => {
    const body = createProjectBody.safeParse(req.body);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid', message: body.error.issues[0]?.message });
    const userId = requireUser(req).id;
    const projectId = newId();
    const failure = await run(userId, callerScope(req), 'project_add', {
      ...body.data,
      id: projectId,
    });
    if (failure) return reply.status(COMMAND_STATUS[failure]).send({ error: failure });
    const project = await readProject(userId, callerScope(req), projectId);
    if (!project) return reply.status(404).send({ error: 'not_found' });
    return reply.status(201).send({ project });
  });

  app.patch('/api/v1/projects/:id', { config: projectsWrite }, async (req, reply) => {
    const id = idSchema.safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.status(400).send({ error: 'validation_failed' });
    const body = updateProjectBody.safeParse(req.body);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid', message: body.error.issues[0]?.message });
    const userId = requireUser(req).id;
    const failure = await run(userId, callerScope(req), 'project_update', {
      id: id.data,
      ...body.data,
    });
    if (failure) return reply.status(COMMAND_STATUS[failure]).send({ error: failure });
    const project = await readProject(userId, callerScope(req), id.data);
    if (!project) return reply.status(404).send({ error: 'not_found' });
    return { project };
  });

  app.delete('/api/v1/projects/:id', { config: projectsWrite }, async (req, reply) => {
    const id = idSchema.safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.status(400).send({ error: 'validation_failed' });
    const failure = await run(requireUser(req).id, callerScope(req), 'project_delete', {
      id: id.data,
    });
    if (failure) return reply.status(COMMAND_STATUS[failure]).send({ error: failure });
    return reply.status(204).send();
  });

  // The contract is public: a public API that hides its own documentation is not much use.
  app.get('/api/docs', { config: { access: 'public' } }, async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(docsHtml()),
  );
  app.get('/api/docs/openapi.json', { config: { access: 'public' } }, async () =>
    buildOpenApiDocument(publicUrl()),
  );
}
