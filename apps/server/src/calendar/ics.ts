import { addDays, formatRRule, parseRRule, zonedInstant } from '@bokydo/nlp';

/**
 * iCalendar (RFC 5545) writer for calendar feeds. Task text is untrusted: every value goes
 * through `escapeText` (no raw line breaks, so content can't start a new property or event) and
 * every line is folded at 75 octets without splitting a UTF-8 character.
 */

const CRLF = '\r\n';
const encoder = new TextEncoder();

/** TEXT value escaping: `\`, `;`, `,` and line breaks; other control characters become spaces. */
export function escapeText(input: string): string {
  let out = '';
  for (const ch of input.replaceAll('\r\n', '\n').replaceAll('\r', '\n')) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\n') out += '\\n';
    else if (ch === '\\' || ch === ';' || ch === ',') out += `\\${ch}`;
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029)
      out += ' ';
    else out += ch;
  }
  return out;
}

/** Fold a content line at 75 octets; continuation lines start with one space. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
      limit = 74; // the leading space counts toward the 75
    }
    current += ch;
    bytes += n;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

export interface FeedTask {
  id: string;
  summary: string;
  description: string;
  labels: string[];
  /** 1 (p1, most urgent) … 4 (default). */
  priority: number;
  projectName: string | null;
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`, or null for an all-day task. */
  time: string | null;
  /** Fixed IANA zone, or null for a floating time ("9:00 wherever I am"). */
  timeZone: string | null;
  durationMinutes: number | null;
  /** Canonical rule string for tasks that repeat from their schedule; null otherwise. */
  rrule: string | null;
  updatedAt: Date;
  /** Link back to the task in the app (omitted when the instance has no public URL). */
  url: string | null;
}

export interface FeedOptions {
  name: string;
  tasks: FeedTask[];
  includeDescriptions: boolean;
}

const wallMs = (date: string, time: string) =>
  Date.UTC(
    +date.slice(0, 4),
    +date.slice(5, 7) - 1,
    +date.slice(8, 10),
    +time.slice(0, 2),
    +time.slice(3, 5),
  );

/** `YYYYMMDDTHHMMSS` of a millisecond value read as UTC fields (wall clock or an instant). */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15);
const utcStamp = (ms: number) => `${stamp(ms)}Z`;
const compactDate = (date: string) => date.replaceAll('-', '');

/** Only real, well-formed IANA names are written as TZID; anything else reads as floating. */
function validZone(zone: string | null): string | null {
  if (!zone || !/^[A-Za-z0-9_+/-]{1,64}$/.test(zone)) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/**
 * The series rule as RFC 5545 text, or null when it can't be expressed faithfully (hourly rules
 * on a task with a date but no hour). UNTIL must have the same form as DTSTART: a DATE for an
 * all-day task, and UTC when DTSTART names a zone.
 */
function rruleLine(rrule: string, time: string | null, zone: string | null): string | null {
  const rule = parseRRule(rrule);
  if (!rule || (rule.freq === 'HOURLY' && time === null)) return null;
  let text = formatRRule({ ...rule, until: null });
  if (rule.until) {
    if (time === null) text += `;UNTIL=${compactDate(rule.until)}`;
    else if (zone) text += `;UNTIL=${utcStamp(zonedInstant(rule.until, '23:59', zone) + 59_000)}`;
    else text += `;UNTIL=${compactDate(rule.until)}T235959`;
  }
  return `RRULE:${text}`;
}

function eventLines(task: FeedTask, includeDescriptions: boolean): string[] {
  const zone = validZone(task.timeZone);
  const lines = [
    'BEGIN:VEVENT',
    `UID:${task.id}@bokydo`,
    `DTSTAMP:${utcStamp(task.updatedAt.getTime())}`,
    `LAST-MODIFIED:${utcStamp(task.updatedAt.getTime())}`,
    `SUMMARY:${escapeText(task.summary)}`,
  ];
  const duration = task.durationMinutes ? task.durationMinutes * 60_000 : 0;
  if (task.time === null) {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(task.date)}`);
    lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(task.date, 1))}`);
  } else {
    const start = wallMs(task.date, task.time);
    if (zone && !task.rrule) {
      // A one-off in a fixed zone is an exact instant, which every client reads the same way.
      const instant = zonedInstant(task.date, task.time, zone);
      lines.push(`DTSTART:${utcStamp(instant)}`);
      if (duration) lines.push(`DTEND:${utcStamp(instant + duration)}`);
    } else if (zone) {
      // Repeating in a fixed zone: keep the zone so every occurrence follows its daylight saving.
      lines.push(`DTSTART;TZID=${zone}:${stamp(start)}`);
      if (duration) lines.push(`DTEND;TZID=${zone}:${stamp(start + duration)}`);
    } else {
      lines.push(`DTSTART:${stamp(start)}`);
      if (duration) lines.push(`DTEND:${stamp(start + duration)}`);
    }
  }
  const repeat = task.rrule ? rruleLine(task.rrule, task.time, zone) : null;
  if (repeat) lines.push(repeat);

  const description = [
    task.projectName ? `Project: ${task.projectName}` : null,
    includeDescriptions && task.description.trim() ? task.description.trim() : null,
    task.url ? `Open in BokyDo: ${task.url}` : null,
  ].filter((part): part is string => part !== null);
  if (description.length) lines.push(`DESCRIPTION:${escapeText(description.join('\n\n'))}`);
  if (task.url) lines.push(`URL:${escapeText(task.url)}`);
  if (task.labels.length) lines.push(`CATEGORIES:${task.labels.map(escapeText).join(',')}`);
  if (task.priority >= 1 && task.priority <= 3) lines.push(`PRIORITY:${task.priority * 2 - 1}`);
  // Tasks shouldn't make a calendar look busy.
  lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  return lines;
}

export function renderCalendar(opts: FeedOptions): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BokyDo//Calendar feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(opts.name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...opts.tasks.flatMap((task) => eventLines(task, opts.includeDescriptions)),
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}
