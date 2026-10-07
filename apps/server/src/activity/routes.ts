import type { ActivityEntry } from '@bokydo/shared';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { activity, projects, users } from '../db/schema.js';
import { requireSession } from '../http/access.js';
import { visibleProjects } from '../sync/policy.js';
import { workspaceRole } from '../workspaces/access.js';

const query = z
  .object({
    projectId: z.uuid().optional(),
    taskId: z.uuid().optional(),
    workspaceId: z.uuid().optional(),
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (q) => [q.projectId, q.taskId, q.workspaceId].filter(Boolean).length === 1,
    'Give exactly one of projectId, taskId or workspaceId',
  );

/**
 * The activity log of a project, a task, or a whole workspace (team). Only entries from projects
 * the caller can currently see are returned, so leaving a project, losing access to it through a
 * team change, or a task moving out of view hides its history.
 */
export function registerActivityRoutes(app: FastifyInstance, db: Database): void {
  app.get('/api/v1/activity', { config: { access: 'user' } }, async (req, reply) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_failed' });
    const { projectId, taskId, workspaceId, before, limit } = parsed.data;
    const userId = requireSession(req).user.id;
    return db.transaction(async (tx) => {
      const visible = [...(await visibleProjects(tx, userId)).keys()];
      let scope = visible;
      if (projectId) {
        if (!visible.includes(projectId)) return reply.status(404).send({ error: 'not_found' });
        scope = [projectId];
      } else if (workspaceId) {
        // Same answer as any other invisible resource: don't confirm the team exists.
        if (!(await workspaceRole(tx, workspaceId, userId)))
          return reply.status(404).send({ error: 'not_found' });
        const inWorkspace = new Set(
          (
            await tx
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.workspaceId, workspaceId))
          ).map((p) => p.id),
        );
        // A team member may not see every project in it (restricted visibility, guests).
        scope = visible.filter((id) => inWorkspace.has(id));
      }
      if (scope.length === 0) return { entries: [], users: {}, nextBefore: null };
      const rows = await tx
        .select()
        .from(activity)
        .where(
          and(
            // Always intersect with what the caller can see: a taskId alone must not widen it.
            inArray(activity.projectId, scope),
            taskId ? eq(activity.taskId, taskId) : undefined,
            before ? lt(activity.id, before) : undefined,
          ),
        )
        .orderBy(desc(activity.id))
        .limit(limit);
      const ids = new Set<string>();
      for (const r of rows) {
        if (r.actorId) ids.add(r.actorId);
        for (const key of ['userId', 'assigneeId'] as const) {
          const v = (r.data as Record<string, unknown>)[key];
          if (typeof v === 'string') ids.add(v);
        }
      }
      const names = ids.size
        ? await tx
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(inArray(users.id, [...ids]))
        : [];
      const entries: ActivityEntry[] = rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        taskId: r.taskId,
        actorId: r.actorId,
        type: r.type,
        data: r.data as Record<string, unknown>,
        at: r.at.toISOString(),
      }));
      return {
        entries,
        users: Object.fromEntries(names.map((n) => [n.id, n.username])),
        nextBefore: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
      };
    });
  });
}
