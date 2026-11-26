import {
  habitCheckInSchema,
  habitCreateRequestSchema,
  habitFieldsSchema,
  habitPatchSchema,
  resolvePreferences,
  type HabitSummary,
} from '@bokydo/shared';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { habitCheckIns, habits, users } from '../db/schema.js';
import { newId } from '../db/ids.js';
import { localDate, summariseHabit, validCalendarDate, type HabitRow } from './summary.js';

export type HabitFailure = 'validation_failed' | 'not_found' | 'id_conflict' | 'future_check_in';
export type HabitResult<T> = { ok: true; value: T } | { ok: false; error: HabitFailure };

async function preferences(db: Database, userId: string) {
  const [row] = await db
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, userId));
  return resolvePreferences(row?.preferences);
}

export async function habitToday(db: Database, userId: string, defaultTimeZone: string) {
  const prefs = await preferences(db, userId);
  return {
    prefs,
    today: localDate(new Date(), prefs.timezone ?? defaultTimeZone),
  };
}

export async function listHabits(db: Database, userId: string, defaultTimeZone: string) {
  const { prefs, today } = await habitToday(db, userId, defaultTimeZone);
  const owned = await db
    .select()
    .from(habits)
    .where(eq(habits.ownerUserId, userId))
    .orderBy(asc(habits.createdAt), asc(habits.id));
  const dates = owned.length
    ? await db
        .select({ habitId: habitCheckIns.habitId, date: habitCheckIns.date })
        .from(habitCheckIns)
        .innerJoin(habits, eq(habitCheckIns.habitId, habits.id))
        .where(eq(habits.ownerUserId, userId))
    : [];
  const byHabit = new Map<string, string[]>();
  for (const row of dates)
    byHabit.set(row.habitId, [...(byHabit.get(row.habitId) ?? []), row.date]);
  return {
    today,
    habits: owned.map((h) =>
      summariseHabit(h, byHabit.get(h.id) ?? [], { today, weekStart: prefs.weekStart }),
    ),
  };
}

export async function getHabit(
  db: Database,
  userId: string,
  habitId: string,
  defaultTimeZone: string,
): Promise<HabitSummary | null> {
  const [row] = await db
    .select()
    .from(habits)
    .where(and(eq(habits.id, habitId), eq(habits.ownerUserId, userId)));
  return row ? summaryFor(db, row, userId, defaultTimeZone) : null;
}

export async function createHabit(
  db: Database,
  userId: string,
  input: unknown,
  defaultTimeZone: string,
): Promise<HabitResult<{ habit: HabitSummary; created: boolean }>> {
  const parsed = habitCreateRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation_failed' };
  const id = parsed.data.id ?? newId();
  const [created] = await db
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
    return {
      ok: true,
      value: { habit: await summaryFor(db, created, userId, defaultTimeZone), created: true },
    };
  const [existing] = await db.select().from(habits).where(eq(habits.id, id));
  if (!existing || existing.ownerUserId !== userId) return { ok: false, error: 'not_found' };
  if (
    existing.name !== parsed.data.name ||
    existing.period !== parsed.data.period ||
    existing.target !== parsed.data.target
  )
    return { ok: false, error: 'id_conflict' };
  return {
    ok: true,
    value: { habit: await summaryFor(db, existing, userId, defaultTimeZone), created: false },
  };
}

export async function updateHabit(
  db: Database,
  userId: string,
  habitId: string,
  input: unknown,
  defaultTimeZone: string,
): Promise<HabitResult<HabitSummary>> {
  const patch = habitPatchSchema.safeParse(input);
  if (!patch.success || !zUuid(habitId)) return { ok: false, error: 'validation_failed' };
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.ownerUserId, userId)))
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
  if (updated === 'invalid') return { ok: false, error: 'validation_failed' };
  if (!updated) return { ok: false, error: 'not_found' };
  return { ok: true, value: await summaryFor(db, updated, userId, defaultTimeZone) };
}

export async function deleteHabit(db: Database, userId: string, habitId: string): Promise<boolean> {
  if (!zUuid(habitId)) return false;
  return (
    (
      await db
        .delete(habits)
        .where(and(eq(habits.id, habitId), eq(habits.ownerUserId, userId)))
        .returning({ id: habits.id })
    ).length > 0
  );
}

export async function setHabitCheckIn(
  db: Database,
  userId: string,
  habitId: string,
  date: string,
  input: unknown,
  defaultTimeZone: string,
): Promise<HabitResult<HabitSummary>> {
  const body = habitCheckInSchema.safeParse(input);
  if (!zUuid(habitId) || !body.success || !validCalendarDate(date))
    return { ok: false, error: 'validation_failed' };
  const { prefs, today } = await habitToday(db, userId, defaultTimeZone);
  if (date > today) return { ok: false, error: 'future_check_in' };
  const outcome = await db.transaction(async (tx) => {
    const [habit] = await tx
      .select()
      .from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.ownerUserId, userId)))
      .for('update');
    if (!habit) return null;
    if (body.data.completed)
      await tx.insert(habitCheckIns).values({ habitId: habit.id, date }).onConflictDoNothing();
    else
      await tx
        .delete(habitCheckIns)
        .where(and(eq(habitCheckIns.habitId, habit.id), eq(habitCheckIns.date, date)));
    const dates = await tx
      .select({ date: habitCheckIns.date })
      .from(habitCheckIns)
      .where(eq(habitCheckIns.habitId, habit.id));
    return summariseHabit(
      habit,
      dates.map((r) => r.date),
      { today, weekStart: prefs.weekStart },
    );
  });
  return outcome ? { ok: true, value: outcome } : { ok: false, error: 'not_found' };
}

async function summaryFor(
  db: Database,
  habit: HabitRow,
  userId: string,
  defaultTimeZone: string,
): Promise<HabitSummary> {
  const { prefs, today } = await habitToday(db, userId, defaultTimeZone);
  const dates = await db
    .select({ date: habitCheckIns.date })
    .from(habitCheckIns)
    .innerJoin(habits, eq(habitCheckIns.habitId, habits.id))
    .where(and(eq(habits.id, habit.id), eq(habits.ownerUserId, userId)));
  return summariseHabit(
    habit,
    dates.map((r) => r.date),
    { today, weekStart: prefs.weekStart },
  );
}

function zUuid(value: string): boolean {
  return z.uuid().safeParse(value).success;
}
