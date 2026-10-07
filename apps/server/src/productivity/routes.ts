import { KARMA_POINTS, resolvePreferences } from '@bokydo/shared';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import { tasks, users } from '../db/schema.js';
import { requireSession } from '../http/access.js';
import type { SettingsService } from '../settings/settings-service.js';
import { summariseProductivity, type Completion } from './summary.js';

/** How far back the series and the streak walk go. A longer run than this is truncated. */
const WINDOW_DAYS = 400;
/** The chart the view draws. */
const SERIES_DAYS = 14;

/**
 * Karma is *derived* from the tasks you completed rather than kept as a ledger, so deleting a
 * completed task takes its points with it. Documented rather than hidden; a ledger is the upgrade
 * if that ever matters. The case is built from `KARMA_POINTS`, so the rule has one home.
 */
const KARMA_SUM = sql.raw(
  `case priority ${Object.entries(KARMA_POINTS)
    .map(([priority, points]) => `when ${Number(priority)} then ${Number(points)}`)
    .join(' ')} else 1 end`,
);

export interface ProductivityRouteDeps {
  db: Database;
  settings: SettingsService;
}

/**
 * The productivity view: karma, goals, the current streak and the daily series. Session-only —
 * the REST and MCP surfaces deliberately do not expose it.
 */
export function registerProductivityRoutes(
  app: FastifyInstance,
  deps: ProductivityRouteDeps,
): void {
  app.get('/api/v1/productivity', { config: { access: 'user' } }, async (req) => {
    const userId = requireSession(req).user.id;
    const now = new Date();

    const [row] = await deps.db
      .select({ preferences: users.preferences })
      .from(users)
      .where(eq(users.id, userId));
    const prefs = resolvePreferences(row?.preferences);

    // All-time, so karma does not depend on how far back `recent` reaches.
    const [totals] = await deps.db
      .select({ karma: sql<string>`coalesce(sum(${KARMA_SUM}), 0)::bigint` })
      .from(tasks)
      .where(and(eq(tasks.completedById, userId), isNotNull(tasks.completedAt)));

    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
    const recent = await deps.db
      .select({ at: tasks.completedAt, priority: tasks.priority })
      .from(tasks)
      .where(
        and(
          eq(tasks.completedById, userId),
          isNotNull(tasks.completedAt),
          gte(tasks.completedAt, since),
        ),
      );

    const completions: Completion[] = recent.map((r) => ({ at: r.at!, priority: r.priority }));
    return summariseProductivity({
      completions,
      karma: Number(totals?.karma ?? 0),
      prefs: prefs.productivity,
      timeZone: prefs.timezone ?? deps.settings.get('instance.defaultTimezone'),
      weekStart: prefs.weekStart,
      now,
      seriesDays: SERIES_DAYS,
    });
  });
}
