/**
 * Calendar arithmetic on plain local values. Dates are `YYYY-MM-DD` strings and times `HH:MM`;
 * nothing here knows about time zones except `localNow`, so DST can't shift a date.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
export type WeekStart = 'monday' | 'sunday' | 'saturday';

export interface LocalNow {
  date: string;
  time: string;
}

const toUtc = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));

export function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const yearOf = (d: string) => +d.slice(0, 4);
export const monthOf = (d: string) => +d.slice(5, 7);
export const dayOf = (d: string) => +d.slice(8, 10);

export function isValidDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    year >= 1970 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(d: string, n: number): string {
  return fromUtc(toUtc(d) + n * 86_400_000);
}

/** Calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: string, n: number): string {
  const total = yearOf(d) * 12 + (monthOf(d) - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return ymd(year, month, Math.min(dayOf(d), daysInMonth(year, month)));
}

export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

export const weekdayOf = (d: string) => new Date(toUtc(d)).getUTCDay() as Weekday;

export const WEEK_START_DAY: Record<WeekStart, Weekday> = { sunday: 0, monday: 1, saturday: 6 };

export function startOfWeek(d: string, weekStart: WeekStart | Weekday = 'monday'): string {
  const first = typeof weekStart === 'number' ? weekStart : WEEK_START_DAY[weekStart];
  return addDays(d, -((weekdayOf(d) - first + 7) % 7));
}

/** The first `weekday` on or after `d`. */
export function nextWeekday(d: string, weekday: Weekday, strictlyAfter = false): string {
  const delta = (weekday - weekdayOf(d) + 7) % 7;
  return addDays(d, delta === 0 && strictlyAfter ? 7 : delta);
}

/** The `n`th (1-based, or negative from the end) `weekday` of a month, or null if none. */
export function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: Weekday,
  n: number,
): string | null {
  if (n > 0) {
    const first = nextWeekday(ymd(year, month, 1), weekday);
    const day = dayOf(first) + (n - 1) * 7;
    return day <= daysInMonth(year, month) ? ymd(year, month, day) : null;
  }
  const lastDay = ymd(year, month, daysInMonth(year, month));
  const last = addDays(lastDay, -((weekdayOf(lastDay) - weekday + 7) % 7));
  const day = dayOf(last) + (n + 1) * 7;
  return day >= 1 ? ymd(year, month, day) : null;
}

export const compareDateTime = (a: LocalNow, b: LocalNow) =>
  a.date === b.date ? (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) : a.date < b.date ? -1 : 1;

export const toMinutes = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
export const fromMinutes = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Wall-clock arithmetic: `dt` + `minutes`, rolling over days. */
export function addMinutes(dt: LocalNow, minutes: number): LocalNow {
  const total = toMinutes(dt.time) + minutes;
  const days = Math.floor(total / 1440);
  return { date: addDays(dt.date, days), time: fromMinutes(total - days * 1440) };
}

/** Current local date and time in an IANA zone (falls back to UTC for unknown zones). */
export function localNow(timeZone: string, now: Date = new Date()): LocalNow {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return localNow('UTC', now);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

/** Minutes the zone is ahead of UTC at instant `ms` (unknown zones count as UTC). */
function zoneOffsetMs(timeZone: string, ms: number): number {
  const minute = Math.floor(ms / 60_000) * 60_000;
  const l = localNow(timeZone, new Date(minute));
  return toUtc(l.date) + toMinutes(l.time) * 60_000 - minute;
}

/**
 * The UTC instant (ms) of a wall-clock `date` + `time` in an IANA zone. A time skipped by a DST
 * jump moves forward by the gap; a repeated time resolves to its first occurrence (the same
 * rules as Temporal's "compatible" disambiguation). Unknown zones are treated as UTC.
 */
export function zonedInstant(date: string, time: string, timeZone: string): number {
  const wall = toUtc(date) + toMinutes(time) * 60_000;
  const before = zoneOffsetMs(timeZone, wall - 86_400_000);
  const after = zoneOffsetMs(timeZone, wall + 86_400_000);
  const candidates = [wall - before, wall - after].filter(
    (ms) => ms + zoneOffsetMs(timeZone, ms) === wall,
  );
  // No candidate: the time falls in a gap; the pre-transition offset lands just after it.
  return candidates.length ? Math.min(...candidates) : wall - before;
}
