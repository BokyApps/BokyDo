import {
  addDays,
  addMinutes,
  addMonths,
  compareDateTime,
  dayOf,
  daysInMonth,
  diffDays,
  monthOf,
  nthWeekdayOfMonth,
  startOfWeek,
  toMinutes,
  weekdayOf,
  yearOf,
  ymd,
  type LocalNow,
  type Weekday,
} from './calendar.js';

/**
 * Recurrence rules: a small, strictly validated subset of RFC 5545 RRULE that covers everything
 * quick add can express. Rules are stored as canonical strings in `due.recurrence.rrule`; the
 * task's current due date is the series phase (so "every other week" stays on its weeks).
 *
 * Deliberate differences from RFC 5545, matching how people expect a to-do app to behave:
 * - BYMONTHDAY past the end of a month clamps to its last day ("every 31st" includes Feb 28).
 * - With no BY* parts, the anchor date supplies them (and completion-anchored rules count whole
 *   periods from the completion date).
 */

export type Freq = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export interface ByDay {
  weekday: Weekday;
  /** 1–5 or -1…-5 for "2nd Monday" / "last Friday" (MONTHLY only); null for every such day. */
  nth: number | null;
}
export interface Rule {
  freq: Freq;
  interval: number;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
  /** Inclusive last date of the series. */
  until: string | null;
  wkst: Weekday;
}

export const MAX_INTERVAL = 1000;
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const FREQS: readonly Freq[] = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

export function rule(freq: Freq, parts: Partial<Omit<Rule, 'freq'>> = {}): Rule {
  return {
    freq,
    interval: parts.interval ?? 1,
    byDay: parts.byDay ?? [],
    byMonthDay: parts.byMonthDay ?? [],
    byMonth: parts.byMonth ?? [],
    until: parts.until ?? null,
    wkst: parts.wkst ?? 1,
  };
}

const intList = (v: string, min: number, max: number, allowNegative: boolean) => {
  const out: number[] = [];
  for (const part of v.split(',')) {
    if (!/^-?\d{1,2}$/.test(part)) return null;
    const n = Number(part);
    if (n === 0 || Math.abs(n) < min || Math.abs(n) > max || (n < 0 && !allowNegative)) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
};

/** Parse a canonical rule string; anything outside the supported subset returns null. */
export function parseRRule(input: string): Rule | null {
  if (input.length > 500) return null;
  const seen = new Map<string, string>();
  for (const part of input.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) return null;
    const key = part.slice(0, eq);
    if (seen.has(key)) return null;
    seen.set(key, part.slice(eq + 1));
  }
  const freq = seen.get('FREQ') as Freq | undefined;
  if (!freq || !FREQS.includes(freq)) return null;
  const r = rule(freq);
  for (const [key, value] of seen) {
    switch (key) {
      case 'FREQ':
        break;
      case 'INTERVAL': {
        if (!/^\d{1,4}$/.test(value)) return null;
        r.interval = Number(value);
        if (r.interval < 1 || r.interval > MAX_INTERVAL) return null;
        break;
      }
      case 'BYDAY': {
        for (const part of value.split(',')) {
          const m = /^(-?[1-5])?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part);
          if (!m) return null;
          const weekday = DAY_CODES.indexOf(m[2] as (typeof DAY_CODES)[number]) as Weekday;
          const nth = m[1] ? Number(m[1]) : null;
          if (nth !== null && freq !== 'MONTHLY') return null;
          if (r.byDay.some((d) => d.weekday === weekday && d.nth === nth)) return null;
          r.byDay.push({ weekday, nth });
        }
        if (freq === 'HOURLY' || freq === 'YEARLY') return null;
        break;
      }
      case 'BYMONTHDAY': {
        const days = intList(value, 1, 31, true);
        if (!days || (freq !== 'MONTHLY' && freq !== 'YEARLY')) return null;
        r.byMonthDay = days;
        break;
      }
      case 'BYMONTH': {
        const months = intList(value, 1, 12, false);
        if (!months || freq !== 'YEARLY') return null;
        r.byMonth = months;
        break;
      }
      case 'UNTIL': {
        const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(value);
        if (!m) return null;
        const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
        r.until = ymd(y, mo, d);
        break;
      }
      case 'WKST': {
        const i = DAY_CODES.indexOf(value as (typeof DAY_CODES)[number]);
        if (i < 0) return null;
        r.wkst = i as Weekday;
        break;
      }
      default:
        return null;
    }
  }
  if (r.byDay.length > 0 && r.byMonthDay.length > 0) return null;
  return r;
}

export function formatRRule(r: Rule): string {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval !== 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byMonth.length) parts.push(`BYMONTH=${r.byMonth.join(',')}`);
  if (r.byMonthDay.length) parts.push(`BYMONTHDAY=${r.byMonthDay.join(',')}`);
  if (r.byDay.length)
    parts.push(`BYDAY=${r.byDay.map((d) => `${d.nth ?? ''}${DAY_CODES[d.weekday]}`).join(',')}`);
  if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, '')}`);
  if (r.wkst !== 1) parts.push(`WKST=${DAY_CODES[r.wkst]}`);
  return parts.join(';');
}

/** Give up after this many periods (a rule like Feb 30 never matches). */
const MAX_PERIODS = 2000;

const monthIndex = (d: string) => yearOf(d) * 12 + monthOf(d) - 1;

function candidatesInMonth(r: Rule, year: number, month: number, anchor: string): string[] {
  const dim = daysInMonth(year, month);
  const days = new Set<string>();
  for (const v of r.byMonthDay) {
    const day = v > 0 ? Math.min(v, dim) : dim + v + 1;
    if (day >= 1) days.add(ymd(year, month, day));
  }
  for (const { weekday, nth } of r.byDay) {
    if (nth !== null) {
      const d = nthWeekdayOfMonth(year, month, weekday, nth);
      if (d) days.add(d);
    } else {
      for (let n = 1; n <= 5; n++) {
        const d = nthWeekdayOfMonth(year, month, weekday, n);
        if (d) days.add(d);
      }
    }
  }
  if (r.byMonthDay.length === 0 && r.byDay.length === 0)
    days.add(ymd(year, month, Math.min(dayOf(anchor), dim)));
  return [...days].sort();
}

/**
 * The first occurrence on or after `min` (and on or after `anchor`) of the series whose phase is
 * set by `anchor`. Null when the series has ended or never matches.
 */
export function occurrenceFrom(r: Rule, anchor: string, min: string): string | null {
  const lo = min > anchor ? min : anchor;
  const n = r.interval;
  const ok = (d: string) => d >= lo;
  let found: string | null = null;
  switch (r.freq) {
    case 'HOURLY':
    case 'DAILY': {
      const k0 = Math.ceil(diffDays(lo, anchor) / n);
      const allowed = r.byDay.map((d) => d.weekday);
      for (let k = k0; k < k0 + MAX_PERIODS && !found; k++) {
        const d = addDays(anchor, k * n);
        if (allowed.length === 0 || allowed.includes(weekdayOf(d))) found = d;
      }
      break;
    }
    case 'WEEKLY': {
      const ws0 = startOfWeek(anchor, r.wkst);
      const k0 = Math.floor(diffDays(startOfWeek(lo, r.wkst), ws0) / 7 / n);
      const weekdays = r.byDay.length ? r.byDay.map((d) => d.weekday) : [weekdayOf(anchor)];
      const offsets = [...new Set(weekdays.map((w) => (w - r.wkst + 7) % 7))].sort((a, b) => a - b);
      for (let k = k0; k < k0 + MAX_PERIODS && !found; k++) {
        const ws = addDays(ws0, k * n * 7);
        found = offsets.map((o) => addDays(ws, o)).find(ok) ?? null;
      }
      break;
    }
    case 'MONTHLY': {
      const m0 = monthIndex(anchor);
      const k0 = Math.max(0, Math.floor((monthIndex(lo) - m0) / n));
      for (let k = k0; k < k0 + MAX_PERIODS && !found; k++) {
        const idx = m0 + k * n;
        found = candidatesInMonth(r, Math.floor(idx / 12), (idx % 12) + 1, anchor).find(ok) ?? null;
      }
      break;
    }
    case 'YEARLY': {
      const y0 = yearOf(anchor);
      const k0 = Math.max(0, Math.floor((yearOf(lo) - y0) / n));
      const months = r.byMonth.length ? [...r.byMonth].sort((a, b) => a - b) : [monthOf(anchor)];
      for (let k = k0; k < k0 + MAX_PERIODS / 10 && !found; k++) {
        const year = y0 + k * n;
        for (const month of months) {
          found = candidatesInMonth(r, year, month, anchor).find(ok) ?? null;
          if (found) break;
        }
      }
      break;
    }
  }
  if (found && r.until && found > r.until) return null;
  return found;
}

/** Shift by whole periods (used for completion-anchored rules without BY* parts). */
function addPeriods(d: string, r: Rule): string {
  switch (r.freq) {
    case 'DAILY':
      return addDays(d, r.interval);
    case 'WEEKLY':
      return addDays(d, r.interval * 7);
    case 'MONTHLY':
      return addMonths(d, r.interval);
    default:
      return addMonths(d, r.interval * 12);
  }
}

const minutesBetween = (a: LocalNow, b: LocalNow) =>
  diffDays(b.date, a.date) * 1440 + toMinutes(b.time) - toMinutes(a.time);

/**
 * First occurrence of a new series starting at `start`. A timed occurrence that is already past
 * today moves to the next one, so "every day at 9am" typed at 10am starts tomorrow.
 */
export function firstOccurrence(
  r: Rule,
  start: string,
  time: string | null,
  now: LocalNow,
): string | null {
  // The first matching day sets the phase: "every 2 months on the 1st" typed on 5 Oct starts
  // on 1 Nov, not on 1 Dec.
  const single = { ...r, interval: 1 };
  const first = occurrenceFrom(single, start, start);
  if (first && time && first === now.date && time <= now.time)
    return occurrenceFrom(single, start, addDays(now.date, 1));
  return first;
}

export interface RecurringDue {
  date: string;
  time: string | null;
  recurrence: { rrule: string; anchor: 'scheduled' | 'completion' } | null;
}

/**
 * Where a recurring task goes when it is completed at local time `now`, or null when the series
 * has ended (the task then completes for good) or the rule is unusable.
 *
 * - `scheduled` ("every"): the next occurrence after the current one that isn't already past, so
 *   completing an overdue daily task lands on today rather than replaying missed days.
 * - `completion` ("every!"): counted from the completion date.
 */
export function nextOccurrence<D extends RecurringDue>(due: D, now: LocalNow): D | null {
  if (!due.recurrence) return null;
  const r = parseRRule(due.recurrence.rrule);
  if (!r) return null;

  if (r.freq === 'HOURLY') {
    const step = r.interval * 60;
    let next: LocalNow;
    if (due.recurrence.anchor === 'completion') {
      next = addMinutes(now, step);
    } else {
      const anchor = { date: due.date, time: due.time ?? '00:00' };
      const k = Math.max(1, Math.floor(minutesBetween(anchor, now) / step) + 1);
      next = addMinutes(anchor, k * step);
    }
    if (r.until && next.date > r.until) return null;
    return { ...due, date: next.date, time: next.time };
  }

  let date: string | null;
  if (due.recurrence.anchor === 'completion') {
    const plain = r.byDay.length === 0 && r.byMonthDay.length === 0 && r.byMonth.length === 0;
    date = plain ? addPeriods(now.date, r) : occurrenceFrom(r, now.date, addDays(now.date, 1));
    if (date && r.until && date > r.until) date = null;
  } else {
    const afterCurrent = addDays(due.date, 1);
    date = occurrenceFrom(r, due.date, afterCurrent > now.date ? afterCurrent : now.date);
    if (date && due.time && compareDateTime({ date, time: due.time }, now) <= 0)
      date = occurrenceFrom(r, due.date, addDays(date, 1));
  }
  return date ? { ...due, date } : null;
}
