import type { HabitPeriod, HabitSummary } from '@bokydo/shared';

export interface HabitRow {
  id: string;
  name: string;
  period: HabitPeriod;
  target: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Date-only check-ins are local calendar dates, deliberately independent of task timestamps. */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function dateValue(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function dateText(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value.startsWith('0000-')) return false; // PostgreSQL DATE has no year zero.
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(date: string, amount: number): string {
  return dateText(dateValue(date) + amount * 86_400_000);
}

const WEEKDAY = { sunday: 0, monday: 1, saturday: 6 } as const;
type WeekStart = keyof typeof WEEKDAY;

export function weekPeriodStart(date: string, weekStart: WeekStart): string {
  const weekday = new Date(dateValue(date)).getUTCDay();
  const daysBack = (weekday - WEEKDAY[weekStart] + 7) % 7;
  return addDays(date, -daysBack);
}

function periodBounds(date: string, period: HabitPeriod, weekStart: WeekStart) {
  const start = period === 'day' ? date : weekPeriodStart(date, weekStart);
  return { start, end: period === 'day' ? date : addDays(start, 6) };
}

function previousPeriod(start: string, period: HabitPeriod): string {
  return addDays(start, period === 'day' ? -1 : -7);
}

/**
 * Summarize from check-in date strings. Streak work is bounded by the number of represented
 * successful periods: each loop consumes a map entry and stops at the first gap.
 */
export function summariseHabit(
  habit: HabitRow,
  checkInDates: readonly string[],
  opts: { today: string; weekStart: WeekStart },
): HabitSummary {
  const unique = new Set(checkInDates.filter((date) => date <= opts.today));
  const counts = new Map<string, number>();
  for (const date of unique) {
    const key = periodBounds(date, habit.period, opts.weekStart).start;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const bounds = periodBounds(opts.today, habit.period, opts.weekStart);
  const completed = counts.get(bounds.start) ?? 0;
  const meets = (start: string) => (counts.get(start) ?? 0) >= habit.target;
  let cursor = meets(bounds.start) ? bounds.start : previousPeriod(bounds.start, habit.period);
  let streak = 0;
  // At most one pass per successful period; an ancient single check-in never causes date walking.
  while (meets(cursor)) {
    streak++;
    cursor = previousPeriod(cursor, habit.period);
  }

  const history: HabitSummary['history'] = [];
  for (let i = 13; i >= 0; i--) {
    const date = addDays(opts.today, -i);
    history.push({ date, completed: unique.has(date) });
  }

  return {
    id: habit.id,
    name: habit.name,
    period: habit.period,
    target: habit.target,
    createdAt: habit.createdAt.toISOString(),
    updatedAt: habit.updatedAt.toISOString(),
    todayCompleted: unique.has(opts.today),
    progress: { completed, target: habit.target, ...bounds },
    streak: { current: streak, unit: habit.period },
    history,
  };
}
