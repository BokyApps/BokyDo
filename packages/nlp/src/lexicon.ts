import type { Weekday } from './calendar.js';

/**
 * A frozen lookup table without a prototype, so user words such as "constructor" or "__proto__"
 * can never resolve to inherited properties.
 */
export function table<T>(entries: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
}

/**
 * Word lists for the English grammar. Every pattern in this package matches a single
 * whitespace-free word with an anchored, linear regex: multi-word phrases are handled by the
 * word-level grammar, never by regex, so there is no catastrophic backtracking to worry about.
 */

export const WEEKDAYS: Readonly<Record<string, Weekday>> = table({
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  weds: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
});

/** Abbreviations that are also ordinary words; they need "on", "next", "every"… in front. */
export const AMBIGUOUS_WEEKDAYS: ReadonlySet<string> = new Set(['sun', 'sat', 'wed']);

/** "mondays", "fridays" (only after "every"). */
export function weekdayPlural(t: string): Weekday | undefined {
  return t.endsWith('s') && t.length > 4 ? WEEKDAYS[t.slice(0, -1)] : undefined;
}

export const MONTHS: Readonly<Record<string, number>> = table({
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
});

export const ORDINAL_WORDS: Readonly<Record<string, number>> = table({
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  last: -1,
});

export const NUMBER_WORDS: Readonly<Record<string, number>> = table({
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
});

export type Unit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export const UNITS: Readonly<Record<string, Unit>> = table({
  m: 'minute',
  min: 'minute',
  mins: 'minute',
  minute: 'minute',
  minutes: 'minute',
  h: 'hour',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  hours: 'hour',
  d: 'day',
  day: 'day',
  days: 'day',
  w: 'week',
  wk: 'week',
  wks: 'week',
  week: 'week',
  weeks: 'week',
  mo: 'month',
  mos: 'month',
  mth: 'month',
  mths: 'month',
  month: 'month',
  months: 'month',
  y: 'year',
  yr: 'year',
  yrs: 'year',
  year: 'year',
  years: 'year',
});

/** Named times of day. */
export const PERIODS: Readonly<Record<string, string>> = table({
  morning: '09:00',
  afternoon: '14:00',
  evening: '19:00',
  night: '21:00',
});

/** Hours after which a bare "at 7" means 7pm (after "tonight", "this evening"…). */
export const PM_PERIODS: ReadonlySet<string> = new Set(['afternoon', 'evening', 'night']);

export const TOMORROW: ReadonlySet<string> = new Set([
  'tomorrow',
  'tmr',
  'tmrw',
  'tomorow',
  'tommorow',
  'tommorrow',
]);

/** A whole number: digits, or a small number word ("a", "two"…). */
export function countOf(t: string): number | null {
  if (/^\d{1,4}$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

/** "27", "27th", "1st" → 27, 27, 1 (1–31). */
export function dayNumber(t: string): { day: number; ordinal: boolean } | null {
  const m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(t);
  if (!m) return null;
  const day = Number(m[1]);
  return day >= 1 && day <= 31 ? { day, ordinal: Boolean(m[2]) } : null;
}

/** "2nd", "second", "last" → 2, 2, -1. Numeric ordinals up to 31. */
export function ordinalOf(t: string): number | null {
  const word = ORDINAL_WORDS[t];
  if (word !== undefined) return word;
  const d = dayNumber(t);
  return d?.ordinal ? d.day : null;
}

/** "3d", "45min", "2h" → [3, 'day'], … */
export function compactAmount(t: string): { n: number; unit: Unit } | null {
  const m = /^(\d{1,4})([a-z]{1,7})$/.exec(t);
  const unit = m ? UNITS[m[2] ?? ''] : undefined;
  return m && unit ? { n: Number(m[1]), unit } : null;
}
