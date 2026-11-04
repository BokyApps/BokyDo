import {
  habitCheckInSchema,
  habitFieldsSchema,
  habitCreateRequestSchema,
  habitPatchSchema,
  resolvePreferences,
} from '@bokydo/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { habitCheckIns, habits, users } from '../db/schema.js';
import { newId } from '../db/ids.js';
import { requireSession } from '../http/access.js';
import type { SettingsService } from '../settings/settings-service.js';
import { localDate, summariseHabit, validCalendarDate, type HabitRow } from './summary.js';

const idParams = z.object({ id: z.uuid() }).strict();
const checkInParams = z.object({ id: z.uuid(), date: z.string() }).strict();

export function registerHabitRoutes(
  app: FastifyInstance,
  deps: { db: Database; settings: SettingsService },
): void {
  app.get('/api/v1/habits', { config: { access: 'user' } }, async (req) => {
    const userId = requireSession(req).user.id;
    const prefs = await ownerPreferences(deps.db, userId);
    const today = localDate(
      new Date(),
      prefs.timezone ?? deps.settings.get('instance.defaultTimezone'),
    );
    const owned = await deps.db
      .select()
      .from(habits)
      .where(eq(habits.ownerUserId, userId))
      .orderBy(asc(habits.createdAt), asc(habits.id));
    const checkIns = owned.length
      ? await deps.db
          .select({ habitId: habitCheckIns.habitId, date: habitCheckIns.date })
          .from(habitCheckIns)
          .innerJoin(habits, eq(habitCheckIns.habitId, habits.id))
          .where(eq(habits.ownerUserId, userId))
      : [];
    const byHabit = new Map<string, string[]>();
    for (const checkIn of checkIns) {
      const list = byHabit.get(checkIn.habitId) ?? [];
      list.push(checkIn.date);
      byHabit.set(checkIn.habitId, list);
    }
    return {
      today,
      habits: owned.map((habit) =>
        summariseHabit(habit, byHabit.get(habit.id) ?? [], {
          today,
          weekStart: prefs.weekStart,
        }),
      ),
    };
  });

  app.post('/api/v1/habits', { config: { access: 'user' } }, async (req, reply) => {
    const parsed = habitCreateRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireSession(req).user.id;
    const id = parsed.data.id ?? newId();
    const [created] = await deps.db
      .insert(habits)
      .values({
        id,
        ownerUserId: userId,
        name: parsed.data.name,
        period: parsed.data.period,
        target: parsed.data.target,
      })
      .onConflictDoNothing()
      .returning();
    if (created)
      return reply
        .status(201)
        .send({ habit: await summaryFor(deps.db, created, userId, deps.settings) });

    // Client-generated IDs make lost-response retries safe. Never reveal another owner's row.
    const [existing] = await deps.db.select().from(habits).where(eq(habits.id, id));
    if (!existing || existing.ownerUserId !== userId)
      return reply.status(404).send({ error: 'not_found' });
    if (
      existing.name !== parsed.data.name ||
      existing.period !== parsed.data.period ||
      existing.target !== parsed.data.target
    )
      return reply.status(409).send({ error: 'id_conflict' });
    return reply
      .status(200)
      .send({ habit: await summaryFor(deps.db, existing, userId, deps.settings) });
  });

  app.patch('/api/v1/habits/:id', { config: { access: 'user' } }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const patch = habitPatchSchema.safeParse(req.body);
    if (!params.success || !patch.success)
      return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireSession(req).user.id;
    const updated = await deps.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(habits)
        .where(and(eq(habits.id, params.data.id), eq(habits.ownerUserId, userId)))
        .for('update');
      if (!current) return null;
      const merged = {
        name: patch.data.name ?? current.name,
        period: patch.data.period ?? current.period,
        target: patch.data.target ?? current.target,
      };
      if (!habitFieldsSchema.safeParse(merged).success) return 'invalid' as const;
      const [row] = await tx
        .update(habits)
        .set({ ...merged, updatedAt: new Date() })
        .where(and(eq(habits.id, current.id), eq(habits.ownerUserId, userId)))
        .returning();
      return row ?? null;
    });
    if (updated === 'invalid') return reply.status(400).send({ error: 'validation_failed' });
    if (!updated) return reply.status(404).send({ error: 'not_found' });
    return { habit: await summaryFor(deps.db, updated, userId, deps.settings) };
  });

  app.delete('/api/v1/habits/:id', { config: { access: 'user' } }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireSession(req).user.id;
    const deleted = await deps.db
      .delete(habits)
      .where(and(eq(habits.id, params.data.id), eq(habits.ownerUserId, userId)))
      .returning({ id: habits.id });
    if (!deleted.length) return reply.status(404).send({ error: 'not_found' });
    return reply.status(204).send();
  });

  app.put(
    '/api/v1/habits/:id/check-ins/:date',
    { config: { access: 'user' } },
    async (req, reply) => {
      const params = checkInParams.safeParse(req.params);
      const body = habitCheckInSchema.safeParse(req.body);
      if (!params.success || !body.success || !validCalendarDate(params.data.date))
        return reply.status(400).send({ error: 'validation_failed' });
      const userId = requireSession(req).user.id;
      const prefs = await ownerPreferences(deps.db, userId);
      const today = localDate(
        new Date(),
        prefs.timezone ?? deps.settings.get('instance.defaultTimezone'),
      );
      if (params.data.date > today) return reply.status(400).send({ error: 'future_check_in' });
      const outcome = await deps.db.transaction(async (tx) => {
        const [habit] = await tx
          .select()
          .from(habits)
          .where(and(eq(habits.id, params.data.id), eq(habits.ownerUserId, userId)))
          .for('update');
        if (!habit) return null;
        if (body.data.completed) {
          await tx
            .insert(habitCheckIns)
            .values({ habitId: habit.id, date: params.data.date })
            .onConflictDoNothing();
        } else {
          await tx
            .delete(habitCheckIns)
            .where(
              and(eq(habitCheckIns.habitId, habit.id), eq(habitCheckIns.date, params.data.date)),
            );
        }
        const checkIns = await tx
          .select({ date: habitCheckIns.date })
          .from(habitCheckIns)
          .where(eq(habitCheckIns.habitId, habit.id));
        return summariseHabit(
          habit,
          checkIns.map((r) => r.date),
          {
            today,
            weekStart: prefs.weekStart,
          },
        );
      });
      if (!outcome) return reply.status(404).send({ error: 'not_found' });
      return { habit: outcome };
    },
  );
}

async function ownerPreferences(db: Database, userId: string) {
  const [row] = await db
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, userId));
  return resolvePreferences(row?.preferences);
}

async function summaryFor(
  db: Database,
  habit: HabitRow,
  userId: string,
  settings: SettingsService,
) {
  const prefs = await ownerPreferences(db, userId);
  const today = localDate(new Date(), prefs.timezone ?? settings.get('instance.defaultTimezone'));
  const checkIns = await db
    .select({ date: habitCheckIns.date })
    .from(habitCheckIns)
    .innerJoin(habits, eq(habitCheckIns.habitId, habits.id))
    .where(and(eq(habits.id, habit.id), eq(habits.ownerUserId, userId)));
  return summariseHabit(
    habit,
    checkIns.map((r) => r.date),
    { today, weekStart: prefs.weekStart },
  );
}
