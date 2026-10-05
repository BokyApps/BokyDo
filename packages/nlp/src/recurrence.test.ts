import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, dayOf, daysInMonth, monthOf, weekdayOf, yearOf } from './calendar.js';
import {
  formatRRule,
  nextOccurrence,
  occurrenceFrom,
  parseRRule,
  type ByDay,
  type RecurringDue,
  type Rule,
} from './recurrence.js';

const NOW = { date: '2026-10-05', time: '10:00' }; // Monday

const due = (
  date: string,
  rrule: string,
  time: string | null = null,
  anchor: 'scheduled' | 'completion' = 'scheduled',
): RecurringDue => ({ date, time, recurrence: { rrule, anchor } });

const next = (d: RecurringDue, now = NOW) => {
  const n = nextOccurrence(d, now);
  return n && (n.time ? `${n.date} ${n.time}` : n.date);
};

describe('parseRRule', () => {
  it.each([
    'FREQ=DAILY',
    'FREQ=DAILY;INTERVAL=3',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;UNTIL=20261201',
    'FREQ=MONTHLY;BYMONTHDAY=-1',
    'FREQ=MONTHLY;BYDAY=2MO',
    'FREQ=MONTHLY;BYDAY=-1FR',
    'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=27',
    'FREQ=HOURLY;INTERVAL=4',
    'FREQ=WEEKLY;BYDAY=SU;WKST=SU',
  ])('round-trips %s', (s) => {
    const r = parseRRule(s);
    expect(r).not.toBeNull();
    expect(formatRRule(r!)).toBe(s);
  });

  it.each([
    '',
    'FREQ=SECONDLY',
    'FREQ=DAILY;FREQ=DAILY',
    'FREQ=DAILY;COUNT=3',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;INTERVAL=1001',
    'FREQ=DAILY;INTERVAL=-1',
    'FREQ=WEEKLY;BYDAY=2MO',
    'FREQ=WEEKLY;BYDAY=MO,MO',
    'FREQ=WEEKLY;BYDAY=XX',
    'FREQ=MONTHLY;BYMONTH=1',
    'FREQ=MONTHLY;BYMONTHDAY=0',
    'FREQ=MONTHLY;BYMONTHDAY=32',
    'FREQ=MONTHLY;BYMONTHDAY=1;BYDAY=MO',
    'FREQ=MONTHLY;BYDAY=6MO',
    'FREQ=YEARLY;BYDAY=MO',
    'FREQ=HOURLY;BYDAY=MO',
    'FREQ=DAILY;UNTIL=20260230',
    'FREQ=DAILY;UNTIL=2026-10-01',
    'freq=daily',
    'FREQ=DAILY;',
    'FREQ=DAILY;=X',
    'FREQ=DAILY;WKST=XX',
    `FREQ=DAILY;${'X'.repeat(600)}`,
  ])('rejects %j', (s) => {
    expect(parseRRule(s)).toBeNull();
  });
});

describe('nextOccurrence (every)', () => {
  it.each([
    ['daily, completed on time', due('2026-10-05', 'FREQ=DAILY'), '2026-10-06'],
    ['daily, overdue: lands on today', due('2026-10-01', 'FREQ=DAILY'), '2026-10-05'],
    [
      'daily 9am, overdue: today 9am has passed',
      due('2026-10-01', 'FREQ=DAILY', '09:00'),
      '2026-10-06 09:00',
    ],
    ['daily 11am, overdue', due('2026-10-01', 'FREQ=DAILY', '11:00'), '2026-10-05 11:00'],
    ['completed early', due('2026-10-08', 'FREQ=DAILY'), '2026-10-09'],
    ['every 3 days keeps phase', due('2026-09-30', 'FREQ=DAILY;INTERVAL=3'), '2026-10-06'],
    ['mon/wed/fri', due('2026-10-05', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'), '2026-10-07'],
    ['mon/wed/fri from friday', due('2026-10-09', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'), '2026-10-12'],
    ['every other monday', due('2026-10-05', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'), '2026-10-19'],
    [
      'every other monday, 3 weeks overdue',
      due('2026-09-14', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'),
      '2026-10-12',
    ],
    ['31st clamps without drifting', due('2026-10-31', 'FREQ=MONTHLY;BYMONTHDAY=31'), '2026-11-30'],
    ['…and recovers', due('2026-11-30', 'FREQ=MONTHLY;BYMONTHDAY=31'), '2026-12-31'],
    ['last day', due('2026-10-31', 'FREQ=MONTHLY;BYMONTHDAY=-1'), '2026-11-30'],
    ['last friday', due('2026-10-30', 'FREQ=MONTHLY;BYDAY=-1FR'), '2026-11-27'],
    ['2nd monday', due('2026-10-12', 'FREQ=MONTHLY;BYDAY=2MO'), '2026-11-09'],
    ['quarterly', due('2026-10-15', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15'), '2027-01-15'],
    ['yearly', due('2026-12-25', 'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25'), '2027-12-25'],
    ['feb 29 clamps', due('2028-02-29', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29'), '2029-02-28'],
    ['until ends the series', due('2026-10-06', 'FREQ=DAILY;UNTIL=20261006'), null],
    ['until is inclusive', due('2026-10-05', 'FREQ=DAILY;UNTIL=20261006'), '2026-10-06'],
    ['hourly', due('2026-10-05', 'FREQ=HOURLY;INTERVAL=2', '09:00'), '2026-10-05 11:00'],
    ['hourly, long overdue', due('2026-10-01', 'FREQ=HOURLY', '09:30'), '2026-10-05 10:30'],
    ['unusable rule', due('2026-10-05', 'FREQ=NOPE'), null],
  ] as const)('%s', (_, d, expected) => {
    expect(next(d)).toBe(expected);
  });

  it('crosses midnight for hourly tasks', () => {
    expect(
      next(due('2026-10-05', 'FREQ=HOURLY', '23:00'), { date: '2026-10-05', time: '23:30' }),
    ).toBe('2026-10-06 00:00');
  });

  it('returns null for non-recurring tasks', () => {
    expect(nextOccurrence({ date: '2026-10-05', time: null, recurrence: null }, NOW)).toBeNull();
  });

  it('keeps every other field', () => {
    const d = { ...due('2026-10-05', 'FREQ=DAILY'), string: 'every day', timezone: null };
    expect(nextOccurrence(d, NOW)).toEqual({ ...d, date: '2026-10-06' });
  });
});

describe('nextOccurrence (every!)', () => {
  it.each([
    [
      '3 days after completion',
      due('2026-09-01', 'FREQ=DAILY;INTERVAL=3', null, 'completion'),
      '2026-10-08',
    ],
    ['a week after completion', due('2026-10-01', 'FREQ=WEEKLY', null, 'completion'), '2026-10-12'],
    ['a month, clamped', due('2026-01-01', 'FREQ=MONTHLY', null, 'completion'), '2026-11-05'],
    ['next monday', due('2026-10-05', 'FREQ=WEEKLY;BYDAY=MO', null, 'completion'), '2026-10-12'],
    [
      'hourly from now',
      due('2026-10-01', 'FREQ=HOURLY', '08:00', 'completion'),
      '2026-10-05 11:00',
    ],
    ['until', due('2026-10-01', 'FREQ=DAILY;UNTIL=20261005', null, 'completion'), null],
  ] as const)('%s', (_, d, expected) => {
    expect(next(d)).toBe(expected);
  });

  it('clamps month ends from the completion date', () => {
    expect(
      next(due('2026-01-01', 'FREQ=MONTHLY', null, 'completion'), {
        date: '2027-01-31',
        time: '10:00',
      }),
    ).toBe('2027-02-28');
  });
});

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

const dateArb = fc
  .date({
    min: new Date('2000-01-01T00:00:00Z'),
    max: new Date('2090-12-31T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));

const ruleArb: fc.Arbitrary<Rule> = fc.oneof(
  fc.record({
    freq: fc.constant('DAILY' as const),
    interval: fc.integer({ min: 1, max: 30 }),
    byDay: fc.constant<ByDay[]>([]),
    byMonthDay: fc.constant<number[]>([]),
    byMonth: fc.constant<number[]>([]),
    until: fc.constant(null),
    wkst: fc.constant(1 as const),
  }),
  fc.record({
    freq: fc.constant('WEEKLY' as const),
    interval: fc.integer({ min: 1, max: 8 }),
    byDay: fc
      .uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 })
      .map((ds) => ds.map((d) => ({ weekday: d as 0, nth: null }))),
    byMonthDay: fc.constant<number[]>([]),
    byMonth: fc.constant<number[]>([]),
    until: fc.constant(null),
    wkst: fc.constantFrom(0 as const, 1 as const),
  }),
  fc.record({
    freq: fc.constant('MONTHLY' as const),
    interval: fc.integer({ min: 1, max: 12 }),
    byDay: fc.constant<ByDay[]>([]),
    byMonthDay: fc.uniqueArray(
      fc.integer({ min: -31, max: 31 }).filter((n) => n !== 0),
      { minLength: 1, maxLength: 3 },
    ),
    byMonth: fc.constant<number[]>([]),
    until: fc.constant(null),
    wkst: fc.constant(1 as const),
  }),
  fc.record({
    freq: fc.constant('MONTHLY' as const),
    interval: fc.integer({ min: 1, max: 12 }),
    byDay: fc
      .tuple(fc.integer({ min: 0, max: 6 }), fc.constantFrom(1, 2, 3, 4, -1, -2))
      .map(([weekday, nth]) => [{ weekday: weekday as 0, nth }]),
    byMonthDay: fc.constant<number[]>([]),
    byMonth: fc.constant<number[]>([]),
    until: fc.constant(null),
    wkst: fc.constant(1 as const),
  }),
  fc.record({
    freq: fc.constant('YEARLY' as const),
    interval: fc.integer({ min: 1, max: 4 }),
    byDay: fc.constant<ByDay[]>([]),
    byMonthDay: fc.integer({ min: 1, max: 31 }).map((d) => [d]),
    byMonth: fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 3 }),
    until: fc.constant(null),
    wkst: fc.constant(1 as const),
  }),
);

function matches(r: Rule, d: string): boolean {
  const dim = daysInMonth(yearOf(d), monthOf(d));
  const monthDayOk = () =>
    r.byMonthDay.some((v) => (v > 0 ? Math.min(v, dim) : dim + v + 1) === dayOf(d));
  switch (r.freq) {
    case 'WEEKLY':
      return r.byDay.some((b) => b.weekday === weekdayOf(d));
    case 'MONTHLY':
      if (r.byMonthDay.length) return monthDayOk();
      return r.byDay.every((b) => b.weekday === weekdayOf(d));
    case 'YEARLY':
      return r.byMonth.includes(monthOf(d)) && monthDayOk();
    default:
      return true;
  }
}

describe('recurrence properties', () => {
  it('format → parse round-trips every generated rule', () => {
    fc.assert(
      fc.property(ruleArb, (r) => {
        expect(parseRRule(formatRRule(r))).toEqual({
          ...r,
          byMonth: [...r.byMonth],
          byMonthDay: [...r.byMonthDay],
        });
      }),
    );
  });

  it('occurrences are on or after the minimum and match the pattern', () => {
    fc.assert(
      fc.property(ruleArb, dateArb, fc.integer({ min: 0, max: 400 }), (r, anchor, ahead) => {
        const min = addDays(anchor, ahead);
        const d = occurrenceFrom(r, anchor, min);
        if (d === null) return;
        expect(d >= min).toBe(true);
        expect(matches(r, d)).toBe(true);
      }),
    );
  });

  it('completing a task always moves it strictly forward and into the future', () => {
    fc.assert(
      fc.property(ruleArb, dateArb, dateArb, (r, dueDate, today) => {
        const d = due(dueDate, formatRRule(r));
        const n = nextOccurrence(d, { date: today, time: '12:00' });
        if (!n) return;
        expect(n.date > dueDate).toBe(true);
        expect(n.date >= today).toBe(true);
        expect(matches(r, n.date)).toBe(true);
      }),
    );
  });
});
