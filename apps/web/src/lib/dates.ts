import type { Due, Preferences } from '@bokydo/shared';
import { localeTag } from './locale.js';

/** Calendar dates are plain `YYYY-MM-DD` strings; arithmetic happens in UTC to dodge DST. */
const parse = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function todayIn(timeZone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(ymd: string, n: number): string {
  const d = parse(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parse(a).getTime() - parse(b).getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday */
export const weekday = (ymd: string) => parse(ymd).getUTCDay();

const WEEK_START: Record<Preferences['weekStart'], number> = { sunday: 0, monday: 1, saturday: 6 };

export function startOfWeek(ymd: string, weekStart: Preferences['weekStart']): string {
  const offset = (weekday(ymd) - WEEK_START[weekStart] + 7) % 7;
  return addDays(ymd, -offset);
}

/** Six rows of seven dates covering the month that contains `ymd`. */
export function monthGrid(ymd: string, weekStart: Preferences['weekStart']): string[][] {
  const first = `${ymd.slice(0, 7)}-01`;
  let day = startOfWeek(first, weekStart);
  return Array.from({ length: 6 }, () =>
    Array.from({ length: 7 }, () => {
      const d = day;
      day = addDays(day, 1);
      return d;
    }),
  );
}

export function weekdayNames(
  weekStart: Preferences['weekStart'],
  style: 'short' | 'narrow' = 'short',
): string[] {
  const base = parse('2026-01-04'); // a Sunday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + ((i + WEEK_START[weekStart]) % 7));
    return d.toLocaleDateString(localeTag(), { weekday: style, timeZone: 'UTC' });
  });
}

export function formatTime(hhmm: string, prefs: Pick<Preferences, 'timeFormat'>): string {
  if (prefs.timeFormat === '24h') return hhmm;
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

export function formatDate(
  ymd: string,
  prefs: Pick<Preferences, 'dateFormat'>,
  withYear = false,
): string {
  const d = parse(ymd);
  const day = d.getUTCDate();
  const month = d.toLocaleDateString(localeTag(), { month: 'short', timeZone: 'UTC' });
  const year = withYear ? ` ${d.getUTCFullYear()}` : '';
  if (prefs.dateFormat === 'mdy') return `${month} ${day}${year}`;
  if (prefs.dateFormat === 'ymd')
    return withYear ? `${d.getUTCFullYear()} ${month} ${day}` : `${month} ${day}`;
  return `${day} ${month}${year}`;
}

export type DueTone = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later';

/** "Today", "Tomorrow 14:00", "Friday", "12 Oct", "12 Oct 2027" plus a colour tone. */
export function describeDate(
  ymd: string,
  time: string | null,
  today: string,
  prefs: Pick<Preferences, 'timeFormat' | 'dateFormat'>,
): { label: string; tone: DueTone } {
  const delta = diffDays(ymd, today);
  let label: string;
  let tone: DueTone = 'later';
  if (delta < 0) tone = 'overdue';
  if (delta === 0) [label, tone] = ['Today', 'today'];
  else if (delta === 1) [label, tone] = ['Tomorrow', 'tomorrow'];
  else if (delta === -1) label = 'Yesterday';
  else if (delta > 1 && delta < 7)
    [label, tone] = [
      parse(ymd).toLocaleDateString(localeTag(), { weekday: 'long', timeZone: 'UTC' }),
      'week',
    ];
  else label = formatDate(ymd, prefs, ymd.slice(0, 4) !== today.slice(0, 4));
  return { label: time ? `${label} ${formatTime(time, prefs)}` : label, tone };
}

export function describeDue(
  due: Due,
  today: string,
  prefs: Pick<Preferences, 'timeFormat' | 'dateFormat'>,
) {
  return describeDate(due.date, due.time, today, prefs);
}

/**
 * A one-off due date. Its stored `string` is absolute ("6 Oct 17:00"), never relative: "Tomorrow"
 * would be wrong by the next day. Views show `dueLabel` instead.
 */
export function makeDue(
  date: string,
  time: string | null,
  today: string,
  prefs: Pick<Preferences, 'timeFormat' | 'dateFormat'>,
): Due {
  const day = formatDate(date, prefs, date.slice(0, 4) !== today.slice(0, 4));
  return {
    date,
    time,
    timezone: null,
    string: time ? `${day} ${formatTime(time, prefs)}` : day,
    recurrence: null,
  };
}

/** What to show for a due date: the phrase for recurring ones ("every mon"), else relative. */
export function dueLabel(
  due: Due,
  today: string,
  prefs: Pick<Preferences, 'timeFormat' | 'dateFormat'>,
): string {
  return due.recurrence ? due.string : describeDue(due, today, prefs).label;
}

export const TONE_CLASS: Record<DueTone, string> = {
  overdue: 'text-danger',
  today: 'text-success',
  tomorrow: 'text-warning',
  week: 'text-p3',
  later: 'text-muted',
};
