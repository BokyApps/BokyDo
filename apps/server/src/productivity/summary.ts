import {
  KARMA_LEVELS,
  type ProductivityDay,
  type ProductivityPrefs,
  type ProductivitySummary,
} from '@bokydo/shared';
import { addDays, localNow, startOfWeek, type WeekStart } from '@bokydo/nlp';

/** One completion, as the route reads it from `tasks`. */
export interface Completion {
  at: Date;
  /** 1 (highest) to 4. */
  priority: number;
}

export interface ProductivityInput {
  /** Completions in the fetched window, in any order. */
  completions: Completion[];
  /** All-time karma, summed in SQL from `KARMA_POINTS` over every completion. */
  karma: number;
  prefs: ProductivityPrefs;
  timeZone: string;
  weekStart: WeekStart;
  now: Date;
  /** How many days the returned series covers, ending today. */
  seriesDays?: number;
  /**
   * How far back the streak walk may go (the window the caller read). Without a bound a vacation
   * spanning centuries would make every request walk millions of days.
   */
  maxStreakDays?: number;
}

/** The level `karma` sits in, and how far it is towards the next one. */
export function levelFor(karma: number): ProductivitySummary['level'] {
  let level: (typeof KARMA_LEVELS)[number] = KARMA_LEVELS[0];
  let next: (typeof KARMA_LEVELS)[number] | undefined;
  for (const candidate of KARMA_LEVELS) {
    if (karma >= candidate.at) level = candidate;
    else {
      next = candidate;
      break;
    }
  }
  return {
    name: level.name,
    at: level.at,
    next: next ? next.at : null,
    progress: next ? Math.min(1, (karma - level.at) / (next.at - level.at)) : 0,
  };
}

/**
 * Karma, goals, the current streak and the daily series, from completions the caller has already
 * read. Pure and time-zone aware: days are bucketed in `timeZone`, so a completion at 23:30 local
 * counts for that local day rather than the UTC one.
 *
 * Rules worth knowing:
 * - Karma is all-time and arrives as `input.karma`, so this never needs every completion.
 * - A day keeps the streak when it reaches the daily goal, or when the user is on vacation, which
 *   neither breaks nor extends it.
 * - Today only breaks the streak once it is over: while today is short of the goal, the streak
 *   stands on yesterday's run.
 * - A daily goal of 0 switches goal tracking and streaks off.
 */
export function summariseProductivity(input: ProductivityInput): ProductivitySummary {
  const { completions, karma, prefs, timeZone, weekStart, now } = input;
  const seriesDays = input.seriesDays ?? 14;
  const maxStreakDays = input.maxStreakDays ?? 400;
  const today = localNow(timeZone, now).date;

  // Local date -> completions that day. Bucketing here rather than in SQL is what makes the
  // time-zone and DST rules testable without a database.
  const counts = new Map<string, number>();
  for (const c of completions) {
    const date = localNow(timeZone, c.at).date;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const completedOn = (date: string) => counts.get(date) ?? 0;

  const dailyGoal = prefs.dailyGoal;
  const goalsOn = dailyGoal > 0;
  const vacationFrom = prefs.vacationFrom;
  const vacationUntil = prefs.vacationUntil;
  // Both ends required: with only an end date every earlier day satisfies `date <= until`, which
  // would make the streak walk below run for ever.
  const onVacation = (date: string) =>
    vacationFrom !== null &&
    vacationUntil !== null &&
    date >= vacationFrom &&
    date <= vacationUntil;

  const weekStartDate = startOfWeek(today, weekStart);
  let weekCompleted = 0;
  for (let date = weekStartDate; date <= today; date = addDays(date, 1)) {
    weekCompleted += completedOn(date);
  }

  const series: ProductivityDay[] = [];
  for (let i = seriesDays - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const completed = completedOn(date);
    series.push({
      date,
      completed,
      goal: dailyGoal,
      met: onVacation(date) || (goalsOn && completed >= dailyGoal),
      vacation: onVacation(date),
    });
  }

  // Walk back from today, or from yesterday while today is still in progress.
  let streak = 0;
  if (goalsOn) {
    const todayMet = completedOn(today) >= dailyGoal || onVacation(today);
    let cursor = todayMet ? today : addDays(today, -1);
    for (let walked = 0; walked < maxStreakDays; walked++) {
      if (onVacation(cursor)) {
        // Holds the streak without extending it.
      } else if (completedOn(cursor) >= dailyGoal) {
        streak++;
      } else {
        break;
      }
      cursor = addDays(cursor, -1);
    }
  }

  const todayCompleted = completedOn(today);
  return {
    karma,
    level: levelFor(karma),
    today: {
      date: today,
      completed: todayCompleted,
      goal: dailyGoal,
      met: onVacation(today) || (goalsOn && todayCompleted >= dailyGoal),
      vacation: onVacation(today),
    },
    week: {
      start: weekStartDate,
      completed: weekCompleted,
      goal: prefs.weeklyGoal,
      met: onVacation(today) || (prefs.weeklyGoal > 0 && weekCompleted >= prefs.weeklyGoal),
    },
    streak: { current: streak },
    vacation: { from: vacationFrom, until: vacationUntil, active: onVacation(today) },
    days: series,
  };
}
