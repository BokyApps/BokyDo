import { DEFAULT_PRODUCTIVITY_PREFS, type ProductivityPrefs } from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import { levelFor, summariseProductivity, type Completion } from './summary.js';

/** A Wednesday, so the week tests have a mid-week "today". */
const NOW = new Date('2026-07-15T12:00:00Z');

const prefs = (over: Partial<ProductivityPrefs> = {}): ProductivityPrefs => ({
  ...DEFAULT_PRODUCTIVITY_PREFS,
  dailyGoal: 2,
  weeklyGoal: 10,
  ...over,
});

const done = (iso: string, priority = 4): Completion => ({ at: new Date(iso), priority });

const run = (completions: Completion[], over: Partial<ProductivityPrefs> = {}, timeZone = 'UTC') =>
  summariseProductivity({
    completions,
    karma: 0,
    prefs: prefs(over),
    timeZone,
    weekStart: 'monday',
    now: NOW,
  });

describe('levelFor', () => {
  it('places karma in the right level and measures progress to the next', () => {
    expect(levelFor(0)).toEqual({ name: 'Novice', at: 0, next: 500, progress: 0 });
    expect(levelFor(250).progress).toBeCloseTo(0.5);
    expect(levelFor(500).name).toBe('Beginner');
  });

  it('tops out with nowhere left to climb', () => {
    expect(levelFor(50_000)).toEqual({
      name: 'Enlightened',
      at: 50_000,
      next: null,
      progress: 0,
    });
    // Above the last threshold stays at the top rather than falling off the end.
    expect(levelFor(999_999).name).toBe('Enlightened');
  });
});

describe('day bucketing', () => {
  it('counts a completion for the local day, not the UTC one', () => {
    // 00:30 on the 15th in Berlin, which is still the 14th in UTC.
    const completions = [done('2026-07-14T22:30:00Z')];

    expect(run(completions, {}, 'Europe/Berlin').today.completed).toBe(1);
    expect(run(completions, {}, 'Europe/Berlin').today.date).toBe('2026-07-15');

    const utc = run(completions, {}, 'UTC');
    expect(utc.today.completed).toBe(0);
    expect(utc.days.at(-2)).toMatchObject({ date: '2026-07-14', completed: 1 });
  });
});

describe('streaks', () => {
  it('counts consecutive days that reached the goal', () => {
    const summary = run([
      done('2026-07-13T09:00:00Z'),
      done('2026-07-13T10:00:00Z'),
      done('2026-07-14T09:00:00Z'),
      done('2026-07-14T10:00:00Z'),
      done('2026-07-15T09:00:00Z'),
      done('2026-07-15T10:00:00Z'),
    ]);
    expect(summary.streak.current).toBe(3);
  });

  it('stops at the first day that fell short', () => {
    const summary = run([
      done('2026-07-13T09:00:00Z'),
      done('2026-07-13T10:00:00Z'),
      // The 14th is missed, so the run ends there even though today is done.
      done('2026-07-15T09:00:00Z'),
      done('2026-07-15T10:00:00Z'),
    ]);
    expect(summary.streak.current).toBe(1);
  });

  it('is zero when yesterday was missed and today is not done yet', () => {
    const summary = run([done('2026-07-13T09:00:00Z'), done('2026-07-15T09:00:00Z')]);
    expect(summary.streak.current).toBe(0);
  });

  it('does not break while today is still in progress', () => {
    const summary = run([
      done('2026-07-13T09:00:00Z'),
      done('2026-07-14T09:00:00Z'),
      done('2026-07-14T09:30:00Z'),
    ]);
    expect(summary.streak.current).toBe(1);
    expect(summary.today.met).toBe(false);
  });

  it('tracks nothing when the daily goal is switched off', () => {
    const summary = run([done('2026-07-15T09:00:00Z')], { dailyGoal: 0 });
    expect(summary.streak.current).toBe(0);
    expect(summary.today).toMatchObject({ completed: 1, goal: 0, met: false });
  });
});

describe('vacation', () => {
  it('holds the streak across the break without extending it, and terminates', () => {
    // Vacation covers the 13th and 14th; the 11th and 12th were worked, so the streak is those
    // two days plus today's. The loop must walk past the vacation days rather than around them.
    const summary = run(
      [
        done('2026-07-11T09:00:00Z'),
        done('2026-07-11T10:00:00Z'),
        done('2026-07-12T09:00:00Z'),
        done('2026-07-12T10:00:00Z'),
        done('2026-07-15T09:00:00Z'),
        done('2026-07-15T10:00:00Z'),
      ],
      { vacationFrom: '2026-07-13', vacationUntil: '2026-07-14' },
    );
    expect(summary.streak.current).toBe(3);
    expect(summary.vacation).toEqual({
      from: '2026-07-13',
      until: '2026-07-14',
      active: false,
    });
  });

  it('counts a vacation day as met so the view does not call it missed', () => {
    const summary = run([], {
      vacationFrom: '2026-07-13',
      vacationUntil: '2026-07-20',
    });
    expect(summary.vacation.active).toBe(true);
    expect(summary.today.met).toBe(true);
    const during = summary.days.find((d) => d.date === '2026-07-14');
    expect(during).toMatchObject({ completed: 0, met: true, vacation: true });
  });

  it('does not treat a day outside the range as vacation', () => {
    // Regression: with only an end date every earlier day looked like vacation, and the streak
    // walk never ended. The 12th is before the range, so it must break the streak normally.
    const summary = run([done('2026-07-15T09:00:00Z'), done('2026-07-15T10:00:00Z')], {
      vacationFrom: '2026-07-13',
      vacationUntil: '2026-07-14',
    });
    const before = summary.days.find((d) => d.date === '2026-07-12');
    expect(before?.vacation).toBe(false);
    expect(summary.streak.current).toBe(1);
  });
});

describe('week and series', () => {
  it('sums only the current week, starting where the preference says', () => {
    const completions = [
      done('2026-07-12T09:00:00Z'), // Sunday: last week under a Monday start
      done('2026-07-13T09:00:00Z'),
      done('2026-07-15T09:00:00Z'),
    ];
    const monday = run(completions);
    expect(monday.week).toMatchObject({ start: '2026-07-13', completed: 2 });

    const sunday = summariseProductivity({
      completions,
      karma: 0,
      prefs: prefs(),
      timeZone: 'UTC',
      weekStart: 'sunday',
      now: NOW,
    });
    expect(sunday.week).toMatchObject({ start: '2026-07-12', completed: 3 });
  });

  it('returns a series ending today, oldest first', () => {
    const summary = run([]);
    expect(summary.days).toHaveLength(14);
    expect(summary.days.at(-1)?.date).toBe('2026-07-15');
    expect(summary.days[0]?.date).toBe('2026-07-02');
  });
});
