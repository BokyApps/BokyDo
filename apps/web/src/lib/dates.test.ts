import { describe, expect, it } from 'vitest';
import {
  addDays,
  dueLabel,
  makeDue,
  describeDate,
  diffDays,
  formatTime,
  monthGrid,
  startOfWeek,
  todayIn,
  weekday,
} from './dates.js';

const prefs = { timeFormat: '24h', dateFormat: 'dmy' } as const;

describe('dates', () => {
  it('computes "today" in the user’s zone, not the machine’s', () => {
    const instant = new Date('2026-10-04T20:30:00Z');
    expect(todayIn('Asia/Phnom_Penh', instant)).toBe('2026-10-05'); // 03:30 next day
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-10-04');
  });

  it('does calendar arithmetic across DST and month ends', () => {
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-11-02', '2026-10-31')).toBe(2);
  });

  it('respects the week start', () => {
    expect(weekday('2026-10-04')).toBe(0); // Sunday
    expect(startOfWeek('2026-10-04', 'monday')).toBe('2026-09-28');
    expect(startOfWeek('2026-10-04', 'sunday')).toBe('2026-10-04');
    expect(startOfWeek('2026-10-04', 'saturday')).toBe('2026-10-03');
    const grid = monthGrid('2026-10-15', 'monday');
    expect(grid).toHaveLength(6);
    expect(grid[0]?.[0]).toBe('2026-09-28');
  });

  it('describes due dates like Todoist', () => {
    const today = '2026-10-04';
    expect(describeDate('2026-10-04', null, today, prefs)).toEqual({
      label: 'Today',
      tone: 'today',
    });
    expect(describeDate('2026-10-05', '14:00', today, prefs)).toEqual({
      label: 'Tomorrow 14:00',
      tone: 'tomorrow',
    });
    expect(describeDate('2026-10-03', null, today, prefs)).toEqual({
      label: 'Yesterday',
      tone: 'overdue',
    });
    expect(describeDate('2026-10-08', null, today, prefs).tone).toBe('week');
    expect(describeDate('2026-10-20', null, today, prefs).label).toMatch(/^20 Oct$/);
    expect(describeDate('2027-01-20', null, today, prefs).label).toMatch(/2027/);
    expect(
      describeDate('2026-10-20', null, today, { timeFormat: '24h', dateFormat: 'mdy' }).label,
    ).toMatch(/^Oct 20$/);
  });

  it('formats 12-hour times', () => {
    expect(formatTime('00:00', { timeFormat: '12h' })).toBe('12am');
    expect(formatTime('13:30', { timeFormat: '12h' })).toBe('1:30pm');
    expect(formatTime('12:00', { timeFormat: '12h' })).toBe('12pm');
  });
});

describe('makeDue / dueLabel', () => {
  const prefs = { timeFormat: '24h', dateFormat: 'dmy' } as const;
  it('stores an absolute phrase but shows a relative one', () => {
    const due = makeDue('2026-10-06', '17:00', '2026-10-05', prefs);
    expect(due.string).toBe(
      `6 ${new Date('2026-10-06T00:00:00Z').toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })} 17:00`,
    );
    expect(dueLabel(due, '2026-10-05', prefs)).toBe('Tomorrow 17:00');
    expect(dueLabel(due, '2026-10-06', prefs)).toBe('Today 17:00');
  });
  it('shows recurring phrases as typed', () => {
    const due = {
      ...makeDue('2026-10-12', null, '2026-10-05', prefs),
      string: 'every mon',
      recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=MO', anchor: 'scheduled' as const },
    };
    expect(dueLabel(due, '2026-10-05', prefs)).toBe('every mon');
  });
});
