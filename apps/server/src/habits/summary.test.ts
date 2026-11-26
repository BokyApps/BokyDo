import { describe, expect, it } from 'vitest';
import { localDate, summariseHabit, validCalendarDate, weekPeriodStart } from './summary.js';

const habit = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Read',
  period: 'day' as const,
  target: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('habit summaries', () => {
  it('uses the owner timezone near a date boundary', () => {
    const now = new Date('2026-11-04T23:30:00Z');
    expect(localDate(now, 'Asia/Phnom_Penh')).toBe('2026-11-05');
    expect(localDate(now, 'America/New_York')).toBe('2026-11-04');
  });
  it('counts today once and ignores dates ahead after a timezone change', () => {
    const summary = summariseHabit(habit, ['2026-11-04', '2026-11-04', '2026-11-05'], {
      today: '2026-11-04',
      weekStart: 'monday',
    });
    expect(summary.progress.completed).toBe(1);
    expect(summary.streak.current).toBe(1);
    const weekly = summariseHabit(
      { ...habit, period: 'week', target: 2 },
      ['2026-11-04', '2026-11-05'],
      { today: '2026-11-04', weekStart: 'monday' },
    );
    expect(weekly.progress.completed).toBe(1);
    expect(weekly.streak.current).toBe(0);
  });

  it('validates strict real Gregorian dates', () => {
    expect(validCalendarDate('2024-02-29')).toBe(true);
    expect(validCalendarDate('2025-02-29')).toBe(false);
    expect(validCalendarDate('2025-2-03')).toBe(false);
  });

  it('honors all supported week starts', () => {
    expect(weekPeriodStart('2026-11-04', 'monday')).toBe('2026-11-02');
    expect(weekPeriodStart('2026-11-04', 'sunday')).toBe('2026-11-01');
    expect(weekPeriodStart('2026-11-04', 'saturday')).toBe('2026-10-31');
  });

  it('does not let an incomplete current day break the prior streak and returns 14 dates', () => {
    const s = summariseHabit(habit, ['2026-11-02', '2026-11-03'], {
      today: '2026-11-04',
      weekStart: 'monday',
    });
    expect(s.streak).toEqual({ current: 2, unit: 'day' });
    expect(s.todayCompleted).toBe(false);
    expect(s.progress).toEqual({ completed: 0, target: 1, start: '2026-11-04', end: '2026-11-04' });
    expect(s.history).toHaveLength(14);
    expect(s.history[13]).toEqual({ date: '2026-11-04', completed: false });
  });

  it('counts consecutive successful weeks and skips an unfinished current week', () => {
    const weekly = { ...habit, period: 'week' as const, target: 2 };
    const s = summariseHabit(weekly, ['2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28'], {
      today: '2026-11-04',
      weekStart: 'monday',
    });
    expect(s.streak).toEqual({ current: 2, unit: 'week' });
    expect(s.progress).toEqual({ completed: 0, target: 2, start: '2026-11-02', end: '2026-11-08' });
  });

  it('handles a very old isolated check-in with work bounded by supplied data', () => {
    const s = summariseHabit(habit, ['0001-01-01'], { today: '9999-12-31', weekStart: 'monday' });
    expect(s.streak.current).toBe(0);
  });
});
