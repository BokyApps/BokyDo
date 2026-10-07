import { z } from 'zod';

/**
 * Points a completed task is worth, by priority (1 = highest). Finishing something that mattered
 * is worth more than clearing a someday item, which is the whole point of the number.
 */
export const KARMA_POINTS: Record<number, number> = { 1: 5, 2: 3, 3: 2, 4: 1 };

/** Karma needed for each level, lowest first. The top level has no ceiling. */
export const KARMA_LEVELS = [
  { name: 'Novice', at: 0 },
  { name: 'Beginner', at: 500 },
  { name: 'Intermediate', at: 2_500 },
  { name: 'Professional', at: 5_000 },
  { name: 'Expert', at: 10_000 },
  { name: 'Master', at: 20_000 },
  { name: 'Grandmaster', at: 35_000 },
  { name: 'Enlightened', at: 50_000 },
] as const;

export const productivityPrefsSchema = z
  .object({
    /** Completions per day that count as a good day. 0 switches daily goals off. */
    dailyGoal: z.number().int().min(0).max(100),
    /** Completions per week that count as a good week. 0 switches weekly goals off. */
    weeklyGoal: z.number().int().min(0).max(700),
    /**
     * Last day of vacation, inclusive. While it covers today, goals are not missed and the streak
     * holds: the point of vacation mode is that nobody should be punished for not working.
     */
    vacationUntil: z.iso.date().nullable(),
  })
  .strict();
export type ProductivityPrefs = z.infer<typeof productivityPrefsSchema>;

export const DEFAULT_PRODUCTIVITY_PREFS: ProductivityPrefs = {
  dailyGoal: 5,
  weeklyGoal: 30,
  vacationUntil: null,
};

/** One day of the productivity view. `date` is a local calendar date in the user's zone. */
export interface ProductivityDay {
  date: string;
  completed: number;
  goal: number;
  met: boolean;
}

export interface ProductivitySummary {
  karma: number;
  level: {
    name: string;
    /** Karma at which this level began. */
    at: number;
    /** Karma needed for the next level, or null at the top. */
    next: number | null;
    /** 0–1 progress towards the next level; 0 at the top level. */
    progress: number;
  };
  today: ProductivityDay;
  week: { start: string; completed: number; goal: number; met: boolean };
  streak: { current: number; best: number };
  vacation: { until: string | null; active: boolean };
  /** Oldest first, ending today. */
  days: ProductivityDay[];
  totals: { completed: number };
}
