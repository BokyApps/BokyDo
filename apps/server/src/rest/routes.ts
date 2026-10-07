import type { ApiScope } from '@bokydo/shared';
import {
  colorSchema,
  dueSchema,
  idSchema,
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
import { projects, tasks } from '../db/schema.js';
import { requireUser } from '../http/access.js';
import { visibleProjects } from '../sync/policy.js';
import { projectToWire, taskToWire } from '../sync/serialize.js';

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
  labels: z.array(idSchema),
  assigneeId: idSchema.nullable(),
  assignedById: idSchema.nullable(),
  childOrder: orderKeySchema,
  isCompleted: z.boolean(),
  completedAt: z.iso.datetime().nullable(),
  createdById: idSchema,
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

// ---------------------------------------------------------------------------------------------
// Descriptors: one entry per REST operation, used both to build the OpenAPI document and to
// document the surface at /api/docs. Keeping them next to the routes is what stops the docs
// drifting from the code.
// ---------------------------------------------------------------------------------------------

interface RestOperation {
  method: 'get';
  /** Fastify path, with `:param` placeholders. */
  path: string;
  summary: string;
  tag: string;
  scopes: readonly ApiScope[];
  query?: z.ZodType;
  response: z.ZodType;
}

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

export function buildOpenApiDocument(publicUrl: string | null): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of REST_OPERATIONS) {
    const parameters: unknown[] = [];
    for (const match of op.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
      parameters.push({
        name: match[1],
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      });
    }
    if (op.query) parameters.push(...queryParameters(op.query));
    const path = op.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    paths[path] ??= {};
    paths[path][op.method] = {
      summary: op.summary,
      tags: [op.tag],
      security: [{ bearerAuth: [...op.scopes] }],
      ...(parameters.length ? { parameters } : {}),
      responses: {
        '200': {
          description: 'Success',
          content: { 'application/json': { schema: toJsonSchema(op.response, 'output') } },
        },
        '400': { description: 'Invalid query or path parameters' },
        '401': { description: 'Missing, malformed or unknown bearer token' },
        '403': { description: 'The token does not carry the required scope' },
        '404': { description: 'No such resource, or it is not visible to you' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'BokyDo REST API',
      version: '1.0.0',
      description:
        'Resource-oriented access to tasks and projects for integrations. Authenticate with a personal access token or an OAuth 2.1 access token as a bearer token; each operation needs the scope listed on it. Everything is scoped to what the token’s owner can see.',
    },
    ...(publicUrl ? { servers: [{ url: publicUrl }] } : {}),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A personal access token (Settings → Apps & tokens) or an OAuth 2.1 access token.',
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
Results are limited to what the token's owner can see.</p>
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
  publicUrl: () => string | null,
): void {
  const tasksRead = { access: 'user', scopes: ['tasks:read'] } as const;
  const projectsRead = { access: 'user', scopes: ['projects:read'] } as const;

  app.get('/api/v1/tasks', { config: tasksRead }, async (req, reply) => {
    const parsed = listTasksQuery.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_failed' });
    const { projectId, completed, limit, cursor } = parsed.data;
    const userId = requireUser(req).id;
    return db.transaction(async (tx) => {
      const visible = await visibleProjects(tx, userId);
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
    const userId = requireUser(req).id;
    return db.transaction(async (tx) => {
      const visible = await visibleProjects(tx, userId);
      const row = (
        await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, id.data), isNull(tasks.deletedAt)))
          .limit(1)
      ).at(0);
      if (!row || !visible.has(row.projectId))
        return reply.status(404).send({ error: 'not_found' });
      return { task: taskToWire(row) };
    });
  });

  app.get('/api/v1/projects', { config: projectsRead }, async (req) => {
    const userId = requireUser(req).id;
    return db.transaction(async (tx) => {
      const visible = await visibleProjects(tx, userId);
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
    const userId = requireUser(req).id;
    return db.transaction(async (tx) => {
      const visible = await visibleProjects(tx, userId);
      const member = visible.get(id.data);
      if (!member) return reply.status(404).send({ error: 'not_found' });
      const row = (await tx.select().from(projects).where(eq(projects.id, id.data)).limit(1)).at(0);
      if (!row) return reply.status(404).send({ error: 'not_found' });
      return { project: projectToWire(row, member) };
    });
  });

  // The contract is public: a public API that hides its own documentation is not much use.
  app.get('/api/docs', { config: { access: 'public' } }, async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(docsHtml()),
  );
  app.get('/api/docs/openapi.json', { config: { access: 'public' } }, async () =>
    buildOpenApiDocument(publicUrl()),
  );
}
