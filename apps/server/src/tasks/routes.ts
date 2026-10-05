import type { Task } from '@bokydo/shared';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { tasks } from '../db/schema.js';
import { requireSession } from '../http/access.js';
import { visibleProjects } from '../sync/policy.js';
import { taskToWire } from '../sync/serialize.js';
import { runFilter } from './filter-sql.js';

const completedQuery = z
  .object({
    projectId: z.uuid().optional(),
    before: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const filterQuery = z
  .object({
    query: z.string().max(1024),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

const searchQuery = z
  .object({
    q: z.string().trim().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/**
 * Turn user text into a safe prefix tsquery: only letters and digits survive, so tsquery
 * operators (& | ! : ( ) <->) in the input can't alter the query.
 */
export function toPrefixQuery(q: string): string | null {
  const words = (q.match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, 8)
    .map((w) => w.toLowerCase().slice(0, 64));
  return words.length ? words.map((w) => `${w}:*`).join(' & ') : null;
}

/** Reads outside the sync stream: completed-task history, full-text search and filters. */
export function registerTaskRoutes(
  app: FastifyInstance,
  db: Database,
  defaultTimeZone: () => string,
): void {
  const user = { config: { access: 'user' } } as const;

  app.get('/api/v1/tasks/completed', user, async (req, reply) => {
    const parsed = completedQuery.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_failed' });
    const { projectId, before, limit } = parsed.data;
    const userId = requireSession(req).user.id;
    return db.transaction(async (tx) => {
      const visible = [...(await visibleProjects(tx, userId)).keys()];
      const scope = projectId ? visible.filter((id) => id === projectId) : visible;
      if (scope.length === 0) return { tasks: [] as Task[], nextBefore: null };
      const rows = await tx
        .select()
        .from(tasks)
        .where(
          and(
            inArray(tasks.projectId, scope),
            eq(tasks.isCompleted, true),
            isNull(tasks.deletedAt),
            before ? lt(tasks.completedAt, new Date(before)) : undefined,
          ),
        )
        .orderBy(desc(tasks.completedAt))
        .limit(limit);
      const last = rows.at(-1);
      return {
        tasks: rows.map(taskToWire),
        nextBefore:
          rows.length === limit && last?.completedAt ? last.completedAt.toISOString() : null,
      };
    });
  });

  /** Run a filter query (`today | overdue`, `#Work & p1`…) over the caller's open tasks. */
  app.get('/api/v1/tasks/filter', user, async (req, reply) => {
    const parsed = filterQuery.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireSession(req).user.id;
    const result = await db.transaction((tx) =>
      runFilter(tx, userId, parsed.data.query, {
        limit: parsed.data.limit,
        defaultTimeZone: defaultTimeZone(),
      }),
    );
    if (!result.ok) return reply.status(400).send({ error: 'invalid_filter', ...result.error });
    return { lists: result.lists, warnings: result.warnings };
  });

  app.get('/api/v1/search', user, async (req, reply) => {
    const parsed = searchQuery.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_failed' });
    const tsquery = toPrefixQuery(parsed.data.q);
    if (!tsquery) return { tasks: [] as Task[] };
    const userId = requireSession(req).user.id;
    return db.transaction(async (tx) => {
      const visible = [...(await visibleProjects(tx, userId)).keys()];
      if (visible.length === 0) return { tasks: [] as Task[] };
      const vector = sql`to_tsvector('simple', ${tasks.content} || ' ' || ${tasks.description})`;
      const query = sql`to_tsquery('simple', ${tsquery})`;
      const rows = await tx
        .select()
        .from(tasks)
        .where(
          and(
            inArray(tasks.projectId, visible),
            isNull(tasks.deletedAt),
            sql`${vector} @@ ${query}`,
          ),
        )
        .orderBy(tasks.isCompleted, desc(sql`ts_rank(${vector}, ${query})`), desc(tasks.updatedAt))
        .limit(parsed.data.limit);
      return { tasks: rows.map(taskToWire) };
    });
  });
}
