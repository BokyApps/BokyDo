import type { Task } from '@bokydo/shared';
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { newToken, tokenId } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { calendarFeeds, filters, projects, tasks, users } from '../db/schema.js';
import { requireSession } from '../http/access.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { Tx } from '../sync/context.js';
import { projectAccess, visibleProjects } from '../sync/policy.js';
import { taskToWire } from '../sync/serialize.js';
import { runFilter } from '../tasks/filter-sql.js';
import { renderCalendar, type FeedTask } from './ics.js';

const MAX_FEEDS_PER_USER = 25;
/** Upper bounds keep one feed fetch cheap however large the project is. */
const MAX_EVENTS = 2000;
const FILTER_LIMIT = 500;
/** `last used` is bookkeeping for the owner, not worth a write on every poll. */
const TOUCH_INTERVAL_MS = 10 * 60_000;
const TOKEN_PURPOSE = 'calendar-feed';
/** A feed file is exactly a 256-bit base64url token plus `.ics`. */
const FEED_FILE = /^([A-Za-z0-9_-]{43})\.ics$/;

const idParams = z.object({ id: z.uuid() }).strict();
const createBody = z
  .object({
    kind: z.enum(['project', 'filter']),
    targetId: z.uuid(),
    showDescriptions: z.boolean().default(false),
  })
  .strict();

export interface CalendarRouteDeps {
  db: Database;
  settings: SettingsService;
  sessionKey: Buffer;
}

type FeedRow = typeof calendarFeeds.$inferSelect;
type Out = { status: number; body?: unknown };

/** What a feed shows: a calendar name, the tasks with a due date, and their project names. */
interface FeedContent {
  name: string;
  tasks: Task[];
  projectNames: Map<string, string>;
}

export function registerCalendarRoutes(app: FastifyInstance, deps: CalendarRouteDeps): void {
  const { db, settings } = deps;
  const user = { config: { access: 'user' } } as const;
  /** Guesses only: valid fetches are never counted, so a shared fetcher IP can't be throttled. */
  const misses = new RateLimiter({
    windowMs: 3600_000,
    maxPerWindow: 60,
    freeFailures: 1_000_000,
    maxBackoffMs: 0,
  });
  /** Calendar apps poll hourly or so; this only stops a runaway client or a leaked-link scraper. */
  const fetches = new RateLimiter({
    windowMs: 3600_000,
    maxPerWindow: 120,
    freeFailures: 1_000_000,
    maxBackoffMs: 0,
  });

  /** The instance's public URL without a trailing slash; empty when none is set. */
  const publicBase = (): string => {
    let base = settings.get('instance.publicUrl') ?? '';
    while (base.endsWith('/')) base = base.slice(0, -1);
    return base;
  };
  const feedUrl = (token: string): string => `${publicBase()}/api/v1/calendar/${token}.ics`;
  const send = (reply: FastifyReply, out: Out) =>
    out.body === undefined
      ? reply.status(out.status).send()
      : reply.status(out.status).send(out.body);

  // ---- Managing feeds (signed-in users) -----------------------------------------------------

  app.get('/api/v1/calendar-feeds', user, async (req) => {
    const me = requireSession(req).user;
    return db.transaction(async (tx) => {
      const visible = await visibleProjects(tx, me.id);
      const rows = await tx
        .select({
          feed: calendarFeeds,
          projectName: projects.name,
          projectDeletedAt: projects.deletedAt,
          filterName: filters.name,
          filterDeletedAt: filters.deletedAt,
        })
        .from(calendarFeeds)
        .leftJoin(projects, eq(projects.id, calendarFeeds.projectId))
        .leftJoin(filters, eq(filters.id, calendarFeeds.filterId))
        .where(eq(calendarFeeds.userId, me.id))
        .orderBy(asc(calendarFeeds.createdAt));
      return {
        feeds: rows.map((r) => ({
          id: r.feed.id,
          kind: r.feed.kind,
          targetId: r.feed.projectId ?? r.feed.filterId,
          // A target that was deleted, or a project the user can no longer see, has no name:
          // the feed itself no longer serves anything.
          targetName:
            r.feed.kind === 'project'
              ? r.feed.projectId && visible.has(r.feed.projectId) && !r.projectDeletedAt
                ? r.projectName
                : null
              : r.filterDeletedAt
                ? null
                : r.filterName,
          showDescriptions: r.feed.showDescriptions,
          createdAt: r.feed.createdAt.toISOString(),
          lastUsedAt: r.feed.lastUsedAt?.toISOString() ?? null,
        })),
      };
    });
  });

  /** The URL is returned once, here: afterwards only a hash of it exists on the server. */
  app.post('/api/v1/calendar-feeds', user, async (req, reply) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    const { kind, targetId, showDescriptions } = body.data;
    const out = await db.transaction(async (tx): Promise<Out> => {
      const [n] = await tx
        .select({ n: count() })
        .from(calendarFeeds)
        .where(eq(calendarFeeds.userId, me.id));
      if ((n?.n ?? 0) >= MAX_FEEDS_PER_USER)
        return { status: 429, body: { error: 'limit_exceeded' } };
      if (kind === 'project') {
        // Any role may read, so any role may subscribe; access is re-checked on every fetch.
        if (!(await projectAccess(tx, me.id, targetId)))
          return { status: 404, body: { error: 'not_found' } };
      } else {
        const [own] = await tx
          .select({ id: filters.id })
          .from(filters)
          .where(
            and(eq(filters.id, targetId), eq(filters.userId, me.id), isNull(filters.deletedAt)),
          );
        if (!own) return { status: 404, body: { error: 'not_found' } };
      }
      const token = newToken();
      const id = newId();
      await tx.insert(calendarFeeds).values({
        id,
        userId: me.id,
        tokenId: tokenId(deps.sessionKey, TOKEN_PURPOSE, token),
        kind,
        projectId: kind === 'project' ? targetId : null,
        filterId: kind === 'filter' ? targetId : null,
        showDescriptions,
      });
      await audit(tx, {
        action: 'calendar_feed.created',
        actorType: 'user',
        actorUserId: me.id,
        targetType: 'calendar_feed',
        targetId: id,
        ip: req.ip,
        meta: { kind, targetId },
      });
      return { status: 201, body: { id, url: feedUrl(token) } };
    });
    return send(reply, out);
  });

  /** A new link for the same feed; the old one stops working at once. */
  app.post('/api/v1/calendar-feeds/:id/rotate', user, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    const token = newToken();
    const out = await db.transaction(async (tx): Promise<Out> => {
      const [row] = await tx
        .update(calendarFeeds)
        .set({ tokenId: tokenId(deps.sessionKey, TOKEN_PURPOSE, token), lastUsedAt: null })
        .where(and(eq(calendarFeeds.id, params.data.id), eq(calendarFeeds.userId, me.id)))
        .returning({ id: calendarFeeds.id });
      if (!row) return { status: 404, body: { error: 'not_found' } };
      await audit(tx, {
        action: 'calendar_feed.rotated',
        actorType: 'user',
        actorUserId: me.id,
        targetType: 'calendar_feed',
        targetId: row.id,
        ip: req.ip,
      });
      return { status: 200, body: { id: row.id, url: feedUrl(token) } };
    });
    return send(reply, out);
  });

  app.delete('/api/v1/calendar-feeds/:id', user, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    const out = await db.transaction(async (tx): Promise<Out> => {
      const [row] = await tx
        .delete(calendarFeeds)
        .where(and(eq(calendarFeeds.id, params.data.id), eq(calendarFeeds.userId, me.id)))
        .returning({ id: calendarFeeds.id, kind: calendarFeeds.kind });
      if (!row) return { status: 404, body: { error: 'not_found' } };
      await audit(tx, {
        action: 'calendar_feed.revoked',
        actorType: 'user',
        actorUserId: me.id,
        targetType: 'calendar_feed',
        targetId: row.id,
        ip: req.ip,
        meta: { kind: row.kind },
      });
      return { status: 204 };
    });
    return send(reply, out);
  });

  // ---- The feed itself: public, authorized by the secret in the URL --------------------------

  app.get('/api/v1/calendar/:file', { config: { access: 'public' } }, async (req, reply) => {
    // Every way of not getting a calendar looks the same: a wrong, revoked or rotated link, a
    // disabled owner, a target that is gone and an owner who lost access are indistinguishable.
    const notFound = (countMiss: boolean) => {
      if (countMiss) {
        const attempt = misses.attempt(req.ip);
        if (!attempt.allowed)
          return reply
            .header('retry-after', String(attempt.retryAfterSeconds))
            .status(429)
            .send({ error: 'rate_limited' });
      }
      return reply.status(404).send({ error: 'not_found' });
    };

    const file = (req.params as { file?: string }).file ?? '';
    const match = FEED_FILE.exec(file);
    if (!match?.[1]) return notFound(true);

    const [found] = await db
      .select({ feed: calendarFeeds, disabledAt: users.disabledAt })
      .from(calendarFeeds)
      .innerJoin(users, eq(users.id, calendarFeeds.userId))
      .where(eq(calendarFeeds.tokenId, tokenId(deps.sessionKey, TOKEN_PURPOSE, match[1])));
    if (!found || found.disabledAt) return notFound(true);
    const feed = found.feed;

    const polled = fetches.attempt(feed.id);
    if (!polled.allowed)
      return reply
        .header('retry-after', String(polled.retryAfterSeconds))
        .status(429)
        .send({ error: 'rate_limited' });

    const publicUrl = publicBase();
    const content = await db.transaction((tx) =>
      loadContent(tx, feed, settings.get('instance.defaultTimezone')),
    );
    if (!content) return notFound(false);

    const events = content.tasks
      .map((t) => toFeedTask(t, content.projectNames.get(t.projectId) ?? null, publicUrl))
      .filter((t): t is FeedTask => t !== null);
    const body = renderCalendar({
      name: content.name,
      tasks: events,
      includeDescriptions: feed.showDescriptions,
    });

    await db
      .update(calendarFeeds)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(calendarFeeds.id, feed.id),
          or(
            isNull(calendarFeeds.lastUsedAt),
            lt(calendarFeeds.lastUsedAt, new Date(Date.now() - TOUCH_INTERVAL_MS)),
          ),
        ),
      );
    return reply
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('content-disposition', 'inline; filename="bokydo.ics"')
      .send(body);
  });
}

/**
 * What the feed shows right now, judged by the owner's access right now: a project the owner can
 * no longer see (or a deleted project or filter) yields nothing, whatever the URL once allowed.
 */
async function loadContent(
  tx: Tx,
  feed: FeedRow,
  defaultTimeZone: string,
): Promise<FeedContent | null> {
  if (feed.kind === 'project' && feed.projectId) {
    const access = await projectAccess(tx, feed.userId, feed.projectId);
    if (!access) return null;
    const { project } = access;
    const rows = project.isArchived
      ? []
      : await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.projectId, project.id),
              eq(tasks.isCompleted, false),
              isNull(tasks.deletedAt),
              isNotNull(tasks.dueDate),
            ),
          )
          .orderBy(asc(tasks.dueDate), asc(tasks.id))
          .limit(MAX_EVENTS);
    return {
      name: project.name,
      tasks: rows.map(taskToWire),
      projectNames: new Map([[project.id, project.name]]),
    };
  }
  if (feed.kind === 'filter' && feed.filterId) {
    const [filter] = await tx
      .select()
      .from(filters)
      .where(
        and(
          eq(filters.id, feed.filterId),
          eq(filters.userId, feed.userId),
          isNull(filters.deletedAt),
        ),
      );
    if (!filter) return null;
    // The saved query runs as its owner, over what the owner can see now. A query that has
    // become invalid just yields an empty calendar.
    const run = await runFilter(tx, feed.userId, filter.query, {
      limit: FILTER_LIMIT,
      defaultTimeZone,
    });
    const unique = new Map<string, Task>();
    if (run.ok) for (const list of run.lists) for (const t of list.tasks) unique.set(t.id, t);
    const list = [...unique.values()].filter((t) => t.due !== null);
    const ids = [...new Set(list.map((t) => t.projectId))];
    const names = ids.length
      ? await tx
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, ids))
      : [];
    return {
      name: filter.name,
      tasks: list.slice(0, MAX_EVENTS),
      projectNames: new Map(names.map((p) => [p.id, p.name])),
    };
  }
  return null;
}

function toFeedTask(task: Task, projectName: string | null, publicUrl: string): FeedTask | null {
  const due = task.due;
  if (!due) return null;
  return {
    id: task.id,
    summary: task.content,
    description: task.description,
    labels: task.labels,
    priority: task.priority,
    projectName,
    date: due.date,
    time: due.time,
    timeZone: due.timezone,
    durationMinutes: task.durationMinutes,
    // Completion-anchored series can't be written as a rule: their next date depends on when
    // the task is finished, so the feed shows only the current occurrence.
    rrule: due.recurrence?.anchor === 'scheduled' ? due.recurrence.rrule : null,
    updatedAt: new Date(task.updatedAt),
    url: publicUrl ? `${publicUrl}/task/${task.id}` : null,
  };
}
