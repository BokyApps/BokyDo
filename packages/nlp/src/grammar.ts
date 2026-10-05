import {
  addDays,
  addMinutes,
  addMonths,
  dayOf,
  daysInMonth,
  isValidDate,
  monthOf,
  nextWeekday,
  startOfWeek,
  weekdayOf,
  yearOf,
  ymd,
  type LocalNow,
  type WeekStart,
  type Weekday,
} from './calendar.js';
import {
  AMBIGUOUS_WEEKDAYS,
  compactAmount,
  countOf,
  dayNumber,
  MONTHS,
  ordinalOf,
  PERIODS,
  PM_PERIODS,
  TOMORROW,
  UNITS,
  table,
  WEEKDAYS,
  weekdayPlural,
  type Unit,
} from './lexicon.js';
import {
  firstOccurrence,
  MAX_INTERVAL,
  rule,
  type ByDay,
  type Freq,
  type Rule,
} from './recurrence.js';

export interface DateContext {
  /** The user's current local date and time. */
  now: LocalNow;
  weekStart: WeekStart;
  /** How to read numeric dates such as 3/4: day first (dmy, ymd) or month first (mdy). */
  dateOrder: 'dmy' | 'mdy' | 'ymd';
}

export interface Word {
  /** Lower-cased, with surrounding punctuation removed. */
  text: string;
  /** Offsets of `text` in the input. */
  start: number;
  end: number;
  /** Offsets of the whole whitespace-delimited word. */
  rawStart: number;
  rawEnd: number;
  /** The word ended in "!" (as in "every!"). */
  bang: boolean;
}

const LEADING = new Set(['(', '"', "'", '[', '“', '‘']);
const TRAILING = new Set(['.', ',', ';', ':', '?', '!', ')', '"', "'", ']', '”', '’']);

/** Split into words. Linear: one pass of a single-character-class regex. */
export function lex(input: string, limit = Infinity): Word[] {
  const words: Word[] = [];
  for (const m of input.matchAll(/\S+/g)) {
    if (m.index >= limit) break;
    const raw = m[0];
    let s = 0;
    let e = raw.length;
    while (s < e && LEADING.has(raw[s] ?? '')) s++;
    let bang = false;
    while (e > s && TRAILING.has(raw[e - 1] ?? '')) {
      if (raw[e - 1] === '!') bang = true;
      e--;
    }
    words.push({
      text: raw.slice(s, e).toLowerCase(),
      start: m.index + s,
      end: m.index + e,
      rawStart: m.index,
      rawEnd: m.index + raw.length,
      bang,
    });
  }
  return words;
}

export interface DateMatch {
  /** Index of the first word after the phrase. */
  end: number;
  date: string;
  time: string | null;
}

export interface RecurrenceMatch extends DateMatch {
  rule: Rule;
  anchor: 'scheduled' | 'completion';
}

const T = (w: readonly Word[], i: number) => w[i]?.text ?? '';

// ---------------------------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------------------------

interface TimeMatch {
  end: number;
  time: string;
}

const hhmm = (h: number, m: number) =>
  `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const SUFFIX = table<'am' | 'pm'>({ am: 'am', pm: 'pm', 'a.m': 'am', 'p.m': 'pm' });

/**
 * "5pm", "5:30 pm", "17:00", "at 9", "at noon", "midnight". A bare number only counts after
 * "at"; `pmBias` reads a bare "at 7" as 7pm (after "tonight", "this evening").
 */
export function timePhrase(w: readonly Word[], i: number, pmBias = false): TimeMatch | null {
  let j = i;
  const hadAt = T(w, j) === 'at' || T(w, j) === '@';
  if (hadAt) j++;
  const t = T(w, j);
  if (t === 'noon' || t === 'midday') return { end: j + 1, time: '12:00' };
  if (t === 'midnight') return { end: j + 1, time: '00:00' };
  const m = /^(\d{1,2})(?:([:.])(\d{2}))?(am|pm|a|p|a\.m|p\.m)?$/.exec(t);
  if (!m) return null;
  let end = j + 1;
  let suffix: 'am' | 'pm' | null = m[4] ? (m[4].startsWith('a') ? 'am' : 'pm') : null;
  const spaced = SUFFIX[T(w, end)];
  if (!suffix && spaced) {
    suffix = spaced;
    end++;
  }
  const colon = m[2] === ':';
  if (m[2] === '.' && !suffix) return null; // "5.30" is a number, "5.30pm" a time
  if (!suffix && !colon && !hadAt) return null;
  let h = Number(m[1]);
  const min = m[3] ? Number(m[3]) : 0;
  if (min > 59) return null;
  if (suffix) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (suffix === 'pm' ? 12 : 0);
  } else {
    if (h > 23) return null;
    if (pmBias && !colon && h >= 1 && h < 12) h += 12;
  }
  if (["o'clock", 'o’clock', 'oclock'].includes(T(w, end))) end++;
  return { end, time: hhmm(h, min) };
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

interface CoreMatch {
  end: number;
  date: string;
  time?: string;
  pmBias?: boolean;
}

const firstOfMonth = (d: string) => `${d.slice(0, 7)}-01`;
const lastOfMonth = (d: string) => ymd(yearOf(d), monthOf(d), daysInMonth(yearOf(d), monthOf(d)));

/** The next date (from today) falling in `month`, on `day` (clamped when `clamp`). */
function nextMonthDay(today: string, month: number, day: number | 'last', clamp = false) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  for (let year = yearOf(today); year <= yearOf(today) + 8; year++) {
    const dim = daysInMonth(year, month);
    const d = day === 'last' ? dim : clamp ? Math.min(day, dim) : day;
    if (d > dim) continue;
    const date = ymd(year, month, d);
    if (date >= today) return date;
  }
  return null;
}

/** Explicit year, or the next occurrence when the year is left out. */
function resolveDate(today: string, month: number, day: number, year: number | null) {
  if (year !== null) return isValidDate(year, month, day) ? ymd(year, month, day) : null;
  return nextMonthDay(today, month, day);
}

const yearWord = (t: string) => (/^\d{4}$/.test(t) && +t >= 1970 && +t <= 2200 ? +t : null);

function numericDate(ctx: DateContext, t: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) return resolveDate(ctx.now.date, Number(iso[2]), Number(iso[3]), Number(iso[1]));
  const m = /^(\d{1,4})([/.])(\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(t);
  if (!m) return null;
  const [a = '', sep = '', b = '', c] = [m[1], m[2], m[3], m[4]];
  if (sep === '.' && c === undefined) return null; // "1.5" is a number
  if (a.length === 4) {
    // 2026/10/27 (year first, any preference)
    if (c === undefined || c.length !== 2) return null;
    return resolveDate(ctx.now.date, +b, +c, +a);
  }
  if (a.length > 2) return null;
  const year = c === undefined ? null : c.length === 2 ? 2000 + +c : +c;
  const [month, day] = ctx.dateOrder === 'mdy' ? [+a, +b] : [+b, +a];
  return resolveDate(ctx.now.date, month, day, year);
}

/** "jan 27", "27 jan", "27th of january 2027", "the 3rd of may". */
function monthDayDate(ctx: DateContext, w: readonly Word[], i: number): CoreMatch | null {
  const today = ctx.now.date;
  const withYear = (month: number, day: number, j: number): CoreMatch | null => {
    const year = yearWord(T(w, j));
    const date = resolveDate(today, month, day, year);
    return date ? { end: year === null ? j : j + 1, date } : null;
  };
  const month = MONTHS[T(w, i)];
  if (month) {
    const day = dayNumber(T(w, i + 1));
    return day ? withYear(month, day.day, i + 2) : null;
  }
  let j = i;
  if (T(w, j) === 'the') j++;
  const day = dayNumber(T(w, j));
  if (!day) return null;
  j++;
  if (T(w, j) === 'of') j++;
  const m = MONTHS[T(w, j)];
  if (!m) return null;
  return withYear(m, day.day, j + 1);
}

/** "next week" etc.: the start of the following week, month or year. */
function nextPeriodStart(ctx: DateContext, unit: string): string | null {
  const today = ctx.now.date;
  if (unit === 'week') return addDays(startOfWeek(today, ctx.weekStart), 7);
  if (unit === 'month') return addMonths(firstOfMonth(today), 1);
  if (unit === 'year') return ymd(yearOf(today) + 1, 1, 1);
  return null;
}

/** "end of week" is Friday: the end of the working week. */
const FRIDAY: Weekday = 5;

/** "end of …", "mid …", "beginning of …", "eom". */
function boundaryDate(ctx: DateContext, w: readonly Word[], i: number): CoreMatch | null {
  const today = ctx.now.date;
  const t = T(w, i);
  if (t === 'eom') return { end: i + 1, date: lastOfMonth(today) };
  if (t === 'eow') return { end: i + 1, date: nextWeekday(today, FRIDAY) };
  if (t === 'eoy') return { end: i + 1, date: ymd(yearOf(today), 12, 31) };

  let kind: 'end' | 'mid' | 'start';
  let j = i + 1;
  if (t === 'end' && T(w, j) === 'of') kind = 'end';
  else if ((t === 'beginning' || t === 'start') && T(w, j) === 'of') kind = 'start';
  else if (t === 'middle' && T(w, j) === 'of') kind = 'mid';
  else if (t === 'mid') {
    kind = 'mid';
    j = i;
  } else if (t.startsWith('mid-') && MONTHS[t.slice(4)]) {
    const date = nextMonthDay(today, MONTHS[t.slice(4)] ?? 0, 15);
    return date ? { end: i + 1, date } : null;
  } else return null;
  j++;
  if (T(w, j) === 'the') j++;
  const next = T(w, j) === 'next';
  if (next) j++;
  const what = T(w, j);
  const end = j + 1;

  if (what === 'week' && kind !== 'mid') {
    const weekStart = next ? addDays(startOfWeek(today, ctx.weekStart), 7) : null;
    if (kind === 'start') return weekStart ? { end, date: weekStart } : null;
    return { end, date: nextWeekday(weekStart ?? today, FRIDAY) };
  }
  if (what === 'month') {
    const base = next ? addMonths(firstOfMonth(today), 1) : firstOfMonth(today);
    if (kind === 'start') return next ? { end, date: base } : null;
    if (kind === 'end') return { end, date: lastOfMonth(base) };
    let mid = ymd(yearOf(base), monthOf(base), 15);
    if (mid < today) mid = ymd(yearOf(addMonths(base, 1)), monthOf(addMonths(base, 1)), 15);
    return { end, date: mid };
  }
  if (what === 'year' && kind !== 'mid') {
    const year = yearOf(today) + (next ? 1 : 0);
    if (kind === 'start') return next ? { end, date: ymd(year, 1, 1) } : null;
    return { end, date: ymd(year, 12, 31) };
  }
  const month = MONTHS[what];
  if (month && !next) {
    const date =
      kind === 'end'
        ? nextMonthDay(today, month, 'last')
        : kind === 'mid'
          ? nextMonthDay(today, month, 15)
          : nextMonthDay(firstOfMonth(today), month, 1);
    return date ? { end, date } : null;
  }
  return null;
}

/** "in 3 days", "in a week", "in 2h", "3 days from now". */
function relativeDate(ctx: DateContext, w: readonly Word[], i: number): CoreMatch | null {
  const amount = (j: number): { n: number; unit: Unit; end: number } | null => {
    const compact = compactAmount(T(w, j));
    if (compact) return { ...compact, end: j + 1 };
    const n = countOf(T(w, j));
    const unit = UNITS[T(w, j + 1)];
    if (n === null || !unit) return null;
    return { n, unit, end: j + 2 };
  };
  let a: { n: number; unit: Unit; end: number } | null;
  if (T(w, i) === 'in') {
    a = amount(i + 1);
    if (!a && T(w, i + 1) === 'half' && T(w, i + 2) === 'an' && T(w, i + 3) === 'hour')
      a = { n: 30, unit: 'minute', end: i + 4 };
  } else {
    a = amount(i);
    if (a && T(w, a.end) === 'from' && T(w, a.end + 1) === 'now') a.end += 2;
    else if (a && T(w, a.end) === 'later') a.end += 1;
    else a = null;
  }
  if (!a || a.n < 1 || a.n > 999) return null;
  const today = ctx.now.date;
  switch (a.unit) {
    case 'minute':
    case 'hour': {
      const at = addMinutes(ctx.now, a.n * (a.unit === 'hour' ? 60 : 1));
      return { end: a.end, date: at.date, time: at.time };
    }
    case 'day':
      return { end: a.end, date: addDays(today, a.n) };
    case 'week':
      return { end: a.end, date: addDays(today, a.n * 7) };
    case 'month':
      return { end: a.end, date: addMonths(today, a.n) };
    case 'year':
      return { end: a.end, date: addMonths(today, a.n * 12) };
  }
}

/** A period word after a date: "tomorrow morning", "friday evening". */
function withPeriod(w: readonly Word[], m: CoreMatch): CoreMatch {
  let j = m.end;
  if (T(w, j) === 'in' && T(w, j + 1) === 'the') j += 2;
  const period = PERIODS[T(w, j)];
  if (!period) return m;
  return { end: j + 1, date: m.date, time: period, pmBias: PM_PERIODS.has(T(w, j)) };
}

/**
 * A date without its time: relative days, weekdays, "next week", explicit dates, "in 3 days",
 * "end of month"… `hadPrep` is set after "on"/"by"/"due", which licenses ambiguous forms such
 * as "on sat" and "on the 3rd".
 */
export function dateCore(
  ctx: DateContext,
  w: readonly Word[],
  i: number,
  hadPrep = false,
): CoreMatch | null {
  const today = ctx.now.date;
  const t = T(w, i);
  if (!t) return null;

  if (t === 'today' || t === 'tod') return withPeriod(w, { end: i + 1, date: today });
  if (t === 'tonight') return { end: i + 1, date: today, time: '19:00', pmBias: true };
  if (TOMORROW.has(t)) return withPeriod(w, { end: i + 1, date: addDays(today, 1) });
  if (t === 'yesterday') return withPeriod(w, { end: i + 1, date: addDays(today, -1) });
  if (t === 'day' || t === 'the') {
    const j = t === 'the' ? i + 1 : i;
    if (T(w, j) === 'day' && T(w, j + 1) === 'after' && TOMORROW.has(T(w, j + 2)))
      return withPeriod(w, { end: j + 3, date: addDays(today, 2) });
  }

  if (t === 'this' || t === 'next' || t === 'coming') {
    const u = T(w, i + 1);
    const wd = WEEKDAYS[u];
    if (wd !== undefined) {
      // "next fri" is Friday of next week; "this fri" / "coming fri" the nearest one.
      const weekStart = startOfWeek(today, ctx.weekStart);
      const date =
        t === 'next'
          ? addDays(weekStart, 7 + ((wd - weekdayOf(weekStart) + 7) % 7))
          : nextWeekday(today, wd, t === 'coming');
      return withPeriod(w, { end: i + 2, date });
    }
    if (u === 'weekend') {
      const from = t === 'next' ? addDays(startOfWeek(today, ctx.weekStart), 7) : today;
      return withPeriod(w, { end: i + 2, date: nextWeekday(from, 6) });
    }
    if (t === 'next') {
      const date = nextPeriodStart(ctx, u);
      if (date) return { end: i + 2, date };
      const month = MONTHS[u];
      if (month) {
        const date = nextMonthDay(addMonths(firstOfMonth(today), 1), month, 1);
        if (date) return { end: i + 2, date };
      }
    }
    const period = PERIODS[u];
    if (t === 'this' && period)
      return { end: i + 2, date: today, time: period, pmBias: PM_PERIODS.has(u) };
    return null;
  }

  const wd = WEEKDAYS[t];
  if (wd !== undefined && (hadPrep || !AMBIGUOUS_WEEKDAYS.has(t))) {
    // "fri oct 9": an explicit date wins over the weekday that names it.
    const explicit = monthDayDate(ctx, w, i + 1) ?? numericAt(ctx, w, i + 1);
    if (explicit) return withPeriod(w, explicit);
    return withPeriod(w, { end: i + 1, date: nextWeekday(today, wd) });
  }

  const boundary = boundaryDate(ctx, w, i);
  if (boundary) return boundary;
  const relative = relativeDate(ctx, w, i);
  if (relative) return relative;

  const numeric = numericAt(ctx, w, i);
  if (numeric) return withPeriod(w, numeric);
  // "27 jan" needs no preposition; a lone "the 3rd" / "3rd" does.
  const md = monthDayDate(ctx, w, i);
  if (md) return withPeriod(w, md);
  if (hadPrep) {
    const j = t === 'the' ? i + 1 : i;
    const day = dayNumber(T(w, j));
    if (day?.ordinal) {
      for (let k = 0; k < 12; k++) {
        const month = addMonths(firstOfMonth(today), k);
        if (day.day > daysInMonth(yearOf(month), monthOf(month))) continue;
        const date = ymd(yearOf(month), monthOf(month), day.day);
        if (date >= today) return withPeriod(w, { end: j + 1, date });
      }
    }
  }
  return null;
}

function numericAt(ctx: DateContext, w: readonly Word[], i: number): CoreMatch | null {
  const date = numericDate(ctx, T(w, i));
  return date ? { end: i + 1, date } : null;
}

const DATE_PREPS = new Set(['on', 'by', 'due']);

/**
 * A due date with optional time, in either order: "tomorrow at 5pm", "5pm tomorrow", "on fri",
 * "by the 3rd", or a time alone ("at 5pm" means today).
 */
export function datePhrase(
  ctx: DateContext,
  w: readonly Word[],
  i: number,
  allowTimeOnly = true,
  standalone = false,
): DateMatch | null {
  let j = i;
  // Text that is only a date (the date picker) may use forms that need "on" in a sentence.
  let hadPrep = standalone;
  if (DATE_PREPS.has(T(w, j))) {
    hadPrep = true;
    j++;
    if (T(w, j) === 'on' && T(w, j - 1) === 'due') j++;
  }
  const time = timePhrase(w, j);
  if (time) {
    let k = time.end;
    const prep = DATE_PREPS.has(T(w, k));
    if (prep) k++;
    const core = dateCore(ctx, w, k, prep);
    if (core) return { end: core.end, date: core.date, time: time.time };
    return allowTimeOnly ? { end: time.end, date: ctx.now.date, time: time.time } : null;
  }
  const core = dateCore(ctx, w, j, hadPrep);
  if (!core) return null;
  const after = timePhrase(w, core.end, core.pmBias);
  return {
    end: after?.end ?? core.end,
    date: core.date,
    time: after?.time ?? core.time ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------------------------

const ADVERBS = table<[Freq, number]>({
  hourly: ['HOURLY', 1],
  daily: ['DAILY', 1],
  nightly: ['DAILY', 1],
  weekly: ['WEEKLY', 1],
  fortnightly: ['WEEKLY', 2],
  biweekly: ['WEEKLY', 2],
  monthly: ['MONTHLY', 1],
  quarterly: ['MONTHLY', 3],
  yearly: ['YEARLY', 1],
  annually: ['YEARLY', 1],
});

const UNIT_FREQ: Partial<Record<Unit, Freq>> = table({
  hour: 'HOURLY',
  day: 'DAILY',
  week: 'WEEKLY',
  month: 'MONTHLY',
  year: 'YEARLY',
});

const WEEKDAY_SET: Weekday[] = [1, 2, 3, 4, 5];
const WEEKEND_SET: Weekday[] = [6, 0];

interface Pattern {
  end: number;
  freq: Freq;
  interval: number;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
  time?: string;
}

const weekdayIn = (t: string) => WEEKDAYS[t] ?? weekdayPlural(t);

/** "mon", "mon, wed and fri", "mon,wed", "mondays & thursdays". */
function weekdayList(w: readonly Word[], i: number): { end: number; days: Weekday[] } | null {
  const days: Weekday[] = [];
  let j = i;
  for (;;) {
    const parts = T(w, j).split(',');
    if (parts.length > 7 || parts.some((p) => p !== '' && weekdayIn(p) === undefined)) break;
    const found = parts.filter(Boolean).flatMap((p) => {
      const d = weekdayIn(p);
      return d === undefined ? [] : [d];
    });
    if (found.length === 0) break;
    for (const d of found) if (!days.includes(d)) days.push(d);
    j++;
    const sep = T(w, j);
    if ((sep === 'and' || sep === '&') && weekdayIn(T(w, j + 1)) !== undefined) j++;
    else if (weekdayIn(sep.split(',')[0] ?? '') === undefined) break;
  }
  return days.length ? { end: j, days } : null;
}

/** Optional "of the month" / "of every month" / "of each month" after a monthly pattern. */
function ofMonth(w: readonly Word[], j: number): number {
  if (T(w, j) !== 'of') return j;
  const k = ['the', 'every', 'each'].includes(T(w, j + 1)) ? j + 2 : j + 1;
  return T(w, k) === 'month' ? k + 1 : j;
}

/** What follows "every": the shape of the series, without start/end. */
function pattern(w: readonly Word[], i: number): Pattern | null {
  const base = (end: number, freq: Freq, interval = 1, extra: Partial<Pattern> = {}): Pattern => ({
    end,
    freq,
    interval,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    ...extra,
  });
  const weekly = (end: number, days: Weekday[], interval = 1) =>
    base(end, 'WEEKLY', interval, { byDay: days.map((weekday) => ({ weekday, nth: null })) });

  let j = i;
  let interval = 1;
  // "every 27 jan", "every 27th of january"
  const leadDay = dayNumber(T(w, j));
  const ofMonthName = T(w, j + 1) === 'of' ? MONTHS[T(w, j + 2)] : undefined;
  const yearlyMonth = MONTHS[T(w, j + 1)] ?? ofMonthName;
  if (leadDay && yearlyMonth)
    return base(ofMonthName ? j + 3 : j + 2, 'YEARLY', 1, {
      byMonth: [yearlyMonth],
      byMonthDay: [leadDay.day],
    });
  if (T(w, j) === 'other') {
    interval = 2;
    j++;
  } else {
    const compact = compactAmount(T(w, j));
    const n = countOf(T(w, j));
    if (compact) {
      interval = compact.n;
      const freq = UNIT_FREQ[compact.unit];
      return freq ? withOn(w, base(j + 1, freq, interval)) : null;
    }
    if (n !== null && UNITS[T(w, j + 1)]) {
      interval = n;
      j++;
    } else if (n !== null && /^\d{1,2}$/.test(T(w, j)) && n >= 1 && n <= 31) {
      // "every 27": the 27th of each month
      return base(ofMonth(w, j + 1), 'MONTHLY', 1, { byMonthDay: [n] });
    }
  }
  if (interval < 1 || interval > MAX_INTERVAL) return null;
  const t = T(w, j);

  const unit = UNITS[t];
  if (unit && (interval > 1 || !t.endsWith('s') || t === 'hrs')) {
    const freq = UNIT_FREQ[unit];
    return freq ? withOn(w, base(j + 1, freq, interval)) : null;
  }
  const period = PERIODS[t];
  if (period && interval === 1) return base(j + 1, 'DAILY', 1, { time: period });
  if (['weekday', 'weekdays', 'workday', 'workdays'].includes(t))
    return weekly(j + 1, WEEKDAY_SET, interval);
  if (t === 'weekend' || t === 'weekends') return weekly(j + 1, WEEKEND_SET, interval);
  const days = weekdayList(w, j);
  if (days) return weekly(days.end, days.days, interval);
  if (interval !== 1) return null;

  // "every 2nd mon", "every last friday of the month", "every last day", "every 15th"
  const nth = ordinalOf(t);
  if (nth !== null) {
    const wd = weekdayIn(T(w, j + 1));
    if (wd !== undefined && nth >= -5 && nth <= 5)
      return base(ofMonth(w, j + 2), 'MONTHLY', 1, { byDay: [{ weekday: wd, nth }] });
    if (T(w, j + 1) === 'day') return base(ofMonth(w, j + 2), 'MONTHLY', 1, { byMonthDay: [nth] });
    if (nth > 0 && dayNumber(t)) {
      const month = MONTHS[T(w, j + 1)] ?? (T(w, j + 1) === 'of' ? MONTHS[T(w, j + 2)] : undefined);
      if (month) {
        const end = T(w, j + 1) === 'of' ? j + 3 : j + 2;
        return base(end, 'YEARLY', 1, { byMonth: [month], byMonthDay: [nth] });
      }
      return base(ofMonth(w, j + 1), 'MONTHLY', 1, { byMonthDay: [nth] });
    }
  }
  // "every jan 27", "every 27 jan"
  const month = MONTHS[t];
  const day = dayNumber(T(w, j + 1));
  if (month && day) return base(j + 2, 'YEARLY', 1, { byMonth: [month], byMonthDay: [day.day] });
  return null;
}

/** "every 2 weeks on mon, thu", "every month on the 15th". */
function withOn(w: readonly Word[], p: Pattern): Pattern {
  if (T(w, p.end) !== 'on') return p;
  if (p.freq === 'WEEKLY') {
    const days = weekdayList(w, p.end + 1);
    if (days)
      return { ...p, end: days.end, byDay: days.days.map((weekday) => ({ weekday, nth: null })) };
  }
  if (p.freq === 'MONTHLY') {
    const j = T(w, p.end + 1) === 'the' ? p.end + 2 : p.end + 1;
    const nth = ordinalOf(T(w, j));
    if (nth !== null) {
      const wd = weekdayIn(T(w, j + 1));
      if (wd !== undefined && nth >= -5 && nth <= 5)
        return { ...p, end: ofMonth(w, j + 2), byDay: [{ weekday: wd, nth }] };
      const end = T(w, j + 1) === 'day' ? j + 2 : j + 1;
      if (nth === -1 && end === j + 1) return p;
      return { ...p, end: ofMonth(w, end), byMonthDay: [nth] };
    }
  }
  return p;
}

const STARTS = new Set(['starting', 'from', 'beginning', 'starts', 'start']);
const UNTILS = new Set(['until', 'till', 'til', 'ending', 'ends', 'through', 'thru']);

/**
 * A start or end date: any date, or a month alone ("starting aug" = the 1st, "until dec 2027" =
 * through the 31st).
 */
function boundDate(
  ctx: DateContext,
  w: readonly Word[],
  i: number,
  kind: 'start' | 'end',
): DateMatch | null {
  let j = i;
  if (T(w, j) === 'on') j++;
  const month = MONTHS[T(w, j)];
  if (month && !dayNumber(T(w, j + 1))) {
    const today = ctx.now.date;
    const year = yearWord(T(w, j + 1));
    let first: string | null;
    if (year !== null) first = ymd(year, month, 1);
    else if (monthOf(today) === month) first = firstOfMonth(today);
    else first = nextMonthDay(firstOfMonth(today), month, 1);
    if (!first) return null;
    const end = year === null ? j + 1 : j + 2;
    if (kind === 'end') return { end, date: lastOfMonth(first), time: null };
    return { end, date: first < today ? today : first, time: null };
  }
  return datePhrase(ctx, w, j, true);
}

/**
 * "every mon 9am", "every 2nd friday starting next month", "every! 3 days", "every 3 months
 * starting aug until dec 2027", "daily at 8". Returns the rule and its first occurrence.
 */
export function recurrencePhrase(
  ctx: DateContext,
  w: readonly Word[],
  i: number,
): RecurrenceMatch | null {
  let anchor: 'scheduled' | 'completion' = 'scheduled';
  let p: Pattern | null;
  const head = T(w, i);
  if (head === 'every' || head === 'each') {
    const word = w[i];
    if (word?.bang && word.end + 1 === word.rawEnd) anchor = 'completion';
    else if (word?.bang) return null;
    p = pattern(w, i + 1);
  } else if (ADVERBS[head]) {
    const [freq, interval] = ADVERBS[head];
    p = { end: i + 1, freq, interval, byDay: [], byMonthDay: [], byMonth: [] };
  } else return null;
  if (!p) return null;

  let end = p.end;
  let time: string | null = p.time ?? null;
  let start: string | null = null;
  let until: string | null = null;
  for (let guard = 0; guard < 3; guard++) {
    const t = T(w, end);
    if (STARTS.has(t)) {
      const at = timePhrase(w, end + 1);
      if (at && !start && (p.freq === 'HOURLY' || !time)) {
        // "every hour starting at 9am" / "every day starting 8:30"
        const dated = DATE_PREPS.has(T(w, at.end)) ? dateCore(ctx, w, at.end + 1, true) : null;
        time = at.time;
        start = dated?.date ?? null;
        end = dated?.end ?? at.end;
        continue;
      }
      const d: DateMatch | null = start ? null : boundDate(ctx, w, end + 1, 'start');
      if (!d) break;
      start = d.date;
      if (d.time) time = d.time;
      end = d.end;
      continue;
    }
    if (UNTILS.has(t)) {
      const d: DateMatch | null = until ? null : boundDate(ctx, w, end + 1, 'end');
      if (!d) break;
      until = d.date;
      end = d.end;
      continue;
    }
    if (!time) {
      const at = timePhrase(w, end);
      if (at) {
        time = at.time;
        end = at.end;
        continue;
      }
    }
    break;
  }

  const now = ctx.now;
  const from = start ?? now.date;
  const r = rule(p.freq, {
    interval: p.interval,
    byDay: p.byDay,
    byMonthDay: p.byMonthDay,
    byMonth: p.byMonth,
    until,
  });
  if (anchor === 'scheduled' && r.byDay.length === 0 && r.byMonthDay.length === 0) {
    // Pin the pattern to the start date so the series can't drift (Jan 31 → Feb 28 → Mar 28).
    if (r.freq === 'WEEKLY') r.byDay = [{ weekday: weekdayOf(from), nth: null }];
    if (r.freq === 'MONTHLY') r.byMonthDay = [dayOf(from)];
    if (r.freq === 'YEARLY') {
      if (r.byMonth.length === 0) r.byMonth = [monthOf(from)];
      r.byMonthDay = [dayOf(from)];
    }
  }

  if (r.freq === 'HOURLY') {
    let at: LocalNow;
    if (time) {
      at = { date: from, time };
      const step = r.interval * 60;
      for (
        let k = 0;
        k < 2000 && (at.date < now.date || (at.date === now.date && at.time <= now.time));
        k++
      )
        at = addMinutes(at, step);
    } else {
      // Starts at the next whole hour.
      const next = addMinutes({ date: now.date, time: `${now.time.slice(0, 2)}:00` }, 60);
      at = start && start > now.date ? { date: start, time: '09:00' } : next;
    }
    if (until && at.date > until) return null;
    return { end, date: at.date, time: at.time, rule: r, anchor };
  }

  const date = firstOccurrence(r, from, time, now);
  if (!date) return null;
  return { end, date, time, rule: r, anchor };
}

/** Bare adverbs ("weekly") only count at the end of the text, so "Weekly review" stays a title. */
export const isAdverb = (t: string) => t in ADVERBS;
