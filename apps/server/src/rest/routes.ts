import type { ApiScope, CommandError, CommandType } from '@bokydo/shared';
import {
  colorSchema,
  commandArgs,
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

/** For tests: real responses must match what the OpenAPI document promises. */
export const RESPONSE_SCHEMAS = { taskList, taskSingle, projectList, projectSingle };

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
  method: 'get' | 'post' | 'patch' | 'delete';
  /** Fastify path, with `:param` placeholders. */
  path: string;
  summary: string;
  tag: string;
  scopes: readonly ApiScope[];
  query?: z.ZodType;
  body?: z.ZodType;
  response?: z.ZodType;
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
    const ok = successStatus(op.method);
    paths[path] ??= {};
    paths[path][op.method] = {
      summary: op.summary,
      tags: [op.tag],
      security: [{ bearerAuth: [...op.scopes] }],
      ...(parameters.length ? { parameters } : {}),
      ...(op.body && op.method !== 'get'
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toJsonSchema(op.body, 'input') } },
            },
          }
        : {}),
      responses: {
        [ok]: {
          description: ok === '204' ? 'Deleted' : 'Success',
          ...(op.response && ok !== '204'
            ? { content: { 'application/json': { schema: toJsonSchema(op.response, 'output') } } }
            : {}),
        },
        '400': { description: 'Invalid body, query or path parameters' },
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
