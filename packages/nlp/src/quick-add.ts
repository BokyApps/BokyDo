import { localNow, type LocalNow, type WeekStart } from './calendar.js';
import {
  datePhrase,
  isAdverb,
  lex,
  recurrencePhrase,
  type DateContext,
  type DateMatch,
  type RecurrenceMatch,
  type Word,
} from './grammar.js';
import { compactAmount, countOf, table, UNITS } from './lexicon.js';
import { formatRRule } from './recurrence.js';

export type TokenKind =
  | 'due'
  | 'deadline'
  | 'priority'
  | 'label'
  | 'project'
  | 'section'
  | 'assignee'
  | 'duration'
  | 'reminder';

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** The matched text, as typed. */
  text: string;
}

/** Shape-compatible with `Due` in @bokydo/shared (floating: no fixed time zone). */
export interface ParsedDue {
  date: string;
  time: string | null;
  timezone: null;
  /** The phrase as typed ("every mon 9am"), for display and re-editing. */
  string: string;
  recurrence: { rrule: string; anchor: 'scheduled' | 'completion' } | null;
}

export type Reminder =
  { type: 'relative'; minutesBefore: number } | { type: 'absolute'; date: string; time: string };

export interface NamedRef {
  id: string;
  /** Matched case-insensitively after the trigger. Include "Parent/Child" paths as extra entries. */
  name: string;
}

export interface QuickAddOptions {
  /** The user's local date and time (see `localNow`). */
  now: LocalNow;
  weekStart?: WeekStart;
  dateOrder?: DateContext['dateOrder'];
  /** The "smart date recognition" preference: off leaves dates in the title. */
  smartDates?: boolean;
  /** Reminder syntax (`!30m`, `!tomorrow 9am`). */
  reminders?: boolean;
  /**
   * Candidates for `#project`, `/section`, `+assignee`. These only decide what is highlighted:
   * the server checks every resulting ID, so pass only what the user may write to anyway.
   */
  projects?: readonly NamedRef[];
  sections?: readonly (NamedRef & { projectId: string })[];
  members?: readonly NamedRef[];
  /** Existing label names, to reuse their capitalisation. */
  labels?: readonly string[];
  /** Project that `/section` resolves against when no `#project` is given. */
  defaultProjectId?: string | null;
  /** Tokens the user clicked to keep as plain text, as `tokenKey()` values. */
  disabled?: ReadonlySet<string>;
}

export interface QuickAddResult {
  /** The title with every recognised token removed. */
  content: string;
  tokens: Token[];
  due: ParsedDue | null;
  deadline: string | null;
  priority: number | null;
  labels: string[];
  projectId: string | null;
  sectionId: string | null;
  assigneeId: string | null;
  durationMinutes: number | null;
  reminders: Reminder[];
}

/** Text beyond this is kept verbatim (tasks are capped at 1,000 characters anyway). */
export const MAX_PARSE_LENGTH = 2048;
export const MAX_DURATION_MINUTES = 24 * 60;
const LABEL = /^[^\s@#]{1,60}$/;

export const tokenKey = (t: Pick<Token, 'kind' | 'text'>) => `${t.kind}:${t.text.toLowerCase()}`;

function dateContext(o: QuickAddOptions): DateContext {
  return { now: o.now, weekStart: o.weekStart ?? 'monday', dateOrder: o.dateOrder ?? 'dmy' };
}

interface NameIndex<T> {
  byName: Map<string, T>;
  longest: number;
}

/** Lower-cased names → refs. The first ref wins when two share a name. */
function indexNames<T extends NamedRef>(refs: readonly T[]): NameIndex<T> {
  const byName = new Map<string, T>();
  let longest = 0;
  for (const ref of refs) {
    if (!ref.name || ref.name.length > 300) continue;
    const key = ref.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, ref);
    longest = Math.max(longest, ref.name.length);
  }
  return { byName, longest };
}

const BOUNDARY = /[\s.,;:!?)]/;

/**
 * Longest case-insensitive candidate name right after `at`, ending at a word boundary. One
 * lookup per boundary within reach, so the cost doesn't grow with the number of candidates.
 */
function matchName<T extends NamedRef>(
  input: string,
  at: number,
  index: NameIndex<T>,
): { ref: T; end: number } | null {
  let best: { ref: T; end: number } | null = null;
  const limit = Math.min(input.length, at + index.longest);
  for (let end = at + 1; end <= limit; end++) {
    const next = input[end];
    if (next !== undefined && !BOUNDARY.test(next)) continue;
    const ref = index.byName.get(input.slice(at, end).toLowerCase());
    if (ref) best = { ref, end };
  }
  return best;
}

/** "45min", "2h", "1.5 hours", "1h30m", "an hour", "half an hour", "1 hour 30 minutes". */
export function durationPhrase(
  w: readonly Word[],
  i: number,
): { end: number; minutes: number } | null {
  const T = (k: number) => w[k]?.text ?? '';
  const one = (j: number): { end: number; minutes: number; unit: 'hour' | 'minute' } | null => {
    const t = T(j);
    const hm = /^(\d{1,2})h(\d{1,2})m?$/.exec(t);
    if (hm) return { end: j + 1, minutes: Number(hm[1]) * 60 + Number(hm[2]), unit: 'minute' };
    const dec = /^(\d{1,2}\.\d{1,2})(h|hrs?|hours?)$/.exec(t);
    if (dec) return { end: j + 1, minutes: Math.round(Number(dec[1]) * 60), unit: 'hour' };
    const compact = compactAmount(t);
    if (compact && (compact.unit === 'hour' || compact.unit === 'minute'))
      return {
        end: j + 1,
        minutes: compact.n * (compact.unit === 'hour' ? 60 : 1),
        unit: compact.unit,
      };
    if (t === 'half' && T(j + 1) === 'an' && T(j + 2) === 'hour')
      return { end: j + 3, minutes: 30, unit: 'minute' };
    const n = /^\d{1,2}\.\d{1,2}$/.test(t) ? Number(t) : countOf(t);
    const unit = UNITS[T(j + 1)];
    if (n === null || (unit !== 'hour' && unit !== 'minute')) return null;
    return { end: j + 2, minutes: Math.round(n * (unit === 'hour' ? 60 : 1)), unit };
  };
  const first = one(i);
  if (!first) return null;
  let { end, minutes } = first;
  if (first.unit === 'hour') {
    const j = T(end) === 'and' ? end + 1 : end;
    const rest = one(j);
    if (rest && rest.unit === 'minute' && rest.minutes < 60) {
      minutes += rest.minutes;
      end = rest.end;
    }
  }
  return minutes >= 1 && minutes <= MAX_DURATION_MINUTES ? { end, minutes } : null;
}

function toDue(
  input: string,
  w: readonly Word[],
  start: number,
  m: DateMatch | RecurrenceMatch,
): ParsedDue {
  // The preposition belongs to the sentence, not the date: "on friday" → "friday".
  let s = start;
  while (s < m.end - 1 && ['on', 'by', 'due', 'at'].includes(w[s]?.text ?? '')) s++;
  const text = input.slice(w[s]?.rawStart ?? 0, w[m.end - 1]?.end ?? input.length).slice(0, 200);
  return {
    date: m.date,
    time: m.time,
    timezone: null,
    string: text,
    recurrence: 'rule' in m ? { rrule: formatRRule(m.rule), anchor: m.anchor } : null,
  };
}

/**
 * Parse a date typed on its own (the date picker's text box, or `{…}` deadlines). The whole text
 * must be a date: anything left over means no match.
 */
export function parseDate(text: string, options: QuickAddOptions): ParsedDue | null {
  if (text.length > 200) return null;
  const w = lex(text);
  if (w.length === 0) return null;
  const ctx = dateContext(options);
  const m = recurrencePhrase(ctx, w, 0) ?? datePhrase(ctx, w, 0, true, true);
  return m && m.end === w.length ? toDue(text, w, 0, m) : null;
}

const TRIGGERS = '#@/+{!';
const isTrigger = (c: string | undefined) => c !== undefined && c !== '' && TRIGGERS.includes(c);

/**
 * Parse a quick-add line: "Call mom tomorrow 5pm #Family @phone p1 for 15min {fri}".
 *
 * Never trusted for authorization: `#`, `/` and `+` resolve only against the candidates passed
 * in, and the server re-checks every ID in the resulting command.
 */
export function parseQuickAdd(input: string, options: QuickAddOptions): QuickAddResult {
  const ctx = dateContext(options);
  const disabled = options.disabled ?? new Set<string>();
  const w = lex(input, MAX_PARSE_LENGTH);
  const tokens: Token[] = [];
  const used = new Array<boolean>(w.length).fill(false);
  const result: QuickAddResult = {
    content: '',
    tokens,
    due: null,
    deadline: null,
    priority: null,
    labels: [],
    projectId: null,
    sectionId: null,
    assigneeId: null,
    durationMinutes: null,
    reminders: [],
  };

  /** Record a token unless the user switched it off; marks the words it covers as used. */
  const take = (kind: TokenKind, start: number, end: number, from: number): boolean => {
    const token = { kind, start, end, text: input.slice(start, end) };
    if (disabled.has(tokenKey(token))) return false;
    tokens.push(token);
    for (let k = from; k < w.length && (w[k]?.rawStart ?? Infinity) < end; k++) used[k] = true;
    return true;
  };
  const isTokenStart = (k: number) => k >= w.length || isTrigger(input[w[k]?.rawStart ?? -1]);

  // #project first, so /section can resolve inside it wherever it appears.
  const projects = indexNames(options.projects ?? []);
  for (const [i, word] of w.entries()) {
    if (result.projectId !== null) break;
    if (input[word.rawStart] !== '#') continue;
    const m = matchName(input, word.rawStart + 1, projects);
    if (m && take('project', word.rawStart, m.end, i)) result.projectId = m.ref.id;
  }
  const knownLabels = new Map((options.labels ?? []).map((l) => [l.toLowerCase(), l]));
  const seenLabels = new Set<string>();
  const sectionProject = result.projectId ?? options.defaultProjectId ?? null;
  const sections = indexNames(
    (options.sections ?? []).filter((s) => s.projectId === sectionProject),
  );
  const members = indexNames(options.members ?? []);

  for (let i = 0; i < w.length; i++) {
    const word = w[i];
    if (!word || used[i]) continue;
    const first = input[word.rawStart];
    const t = word.text;

    if (first === '@' && word.start === word.rawStart) {
      const name = input.slice(word.rawStart + 1, word.end);
      if (LABEL.test(name)) {
        const label = knownLabels.get(name.toLowerCase()) ?? name;
        if (take('label', word.rawStart, word.end, i) && !seenLabels.has(label.toLowerCase())) {
          seenLabels.add(label.toLowerCase());
          result.labels.push(label);
        }
      }
      continue;
    }
    if (first === '/' && result.sectionId === null) {
      const m = matchName(input, word.rawStart + 1, sections);
      if (m && take('section', word.rawStart, m.end, i)) result.sectionId = m.ref.id;
      continue;
    }
    if (first === '+' && result.assigneeId === null) {
      const m = matchName(input, word.rawStart + 1, members);
      if (m && take('assignee', word.rawStart, m.end, i)) result.assigneeId = m.ref.id;
      continue;
    }
    if (first === '{' && result.deadline === null) {
      const close = input.indexOf('}', word.rawStart);
      if (close > word.rawStart && close - word.rawStart <= 64) {
        const inner = parseDate(input.slice(word.rawStart + 1, close), options);
        if (inner && !inner.recurrence && take('deadline', word.rawStart, close + 1, i))
          result.deadline = inner.date;
      }
      continue;
    }
    if (first === '!' && options.reminders !== false) {
      const reminder = reminderAt(ctx, input, w, i);
      if (reminder && take('reminder', word.rawStart, reminder.endOffset, i))
        result.reminders.push(reminder.value);
      continue;
    }
    if (/^p[1-4]$/.test(t) && word.start === word.rawStart && result.priority === null) {
      if (take('priority', word.start, word.end, i)) result.priority = Number(t[1]);
      continue;
    }
    if (t === 'for' && result.durationMinutes === null) {
      const d = durationPhrase(w, i + 1);
      if (d && !used.slice(i, d.end).includes(true)) {
        if (take('duration', word.start, w[d.end - 1]?.end ?? word.end, i)) {
          result.durationMinutes = d.minutes;
          i = d.end - 1;
        }
        continue;
      }
    }
    if (options.smartDates !== false && result.due === null && !isTrigger(first)) {
      let m: DateMatch | RecurrenceMatch | null = recurrencePhrase(ctx, w, i);
      if (m && isAdverb(t) && !isTokenStart(m.end)) m = null;
      m ??= datePhrase(ctx, w, i, true);
      if (m && !used.slice(i, m.end).includes(true)) {
        const due = toDue(input, w, i, m);
        if (take('due', word.start, w[m.end - 1]?.end ?? word.end, i)) {
          result.due = due;
          i = m.end - 1;
        }
      }
    }
  }

  tokens.sort((a, b) => a.start - b.start);
  let content = '';
  let at = 0;
  for (const token of tokens) {
    content += input.slice(at, token.start);
    at = token.end;
  }
  content += input.slice(at);
  result.content = content
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    // "Call mom tomorrow." → "Call mom." (but "Wow !30m" keeps its space)
    .replace(/ ([.,;:!?]+)(?=\s|$)/g, '$1')
    .trim();
  return result;
}

function reminderAt(
  ctx: DateContext,
  input: string,
  w: readonly Word[],
  i: number,
): { value: Reminder; endOffset: number } | null {
  const word = w[i];
  if (!word) return null;
  // Re-lex the word without its "!" so the date grammar sees "tomorrow", not "!tomorrow".
  const head: Word = { ...word, text: word.text.replace(/^!/, ''), rawStart: word.rawStart + 1 };
  if (!head.text) return null;
  const sub = [head, ...w.slice(i + 1, i + 12)];
  const amount = compactAmount(head.text);
  if (amount && (amount.unit === 'minute' || amount.unit === 'hour' || amount.unit === 'day')) {
    const factor = amount.unit === 'minute' ? 1 : amount.unit === 'hour' ? 60 : 1440;
    const before = sub[1]?.text === 'before';
    return {
      value: { type: 'relative', minutesBefore: amount.n * factor },
      endOffset: before ? (sub[1]?.end ?? head.end) : head.end,
    };
  }
  const m = datePhrase(ctx, sub, 0, true);
  if (!m) return null;
  return {
    value: { type: 'absolute', date: m.date, time: m.time ?? '09:00' },
    endOffset: sub[m.end - 1]?.end ?? head.end,
  };
}

export interface Trigger {
  kind: 'project' | 'label' | 'section' | 'assignee';
  /** Offset of the trigger character. */
  start: number;
  /** What has been typed after it so far. */
  query: string;
}

const TRIGGER_KIND = table<Trigger['kind']>({
  '#': 'project',
  '@': 'label',
  '/': 'section',
  '+': 'assignee',
});

/** The autocomplete trigger the caret is in, if any ("#Wo|" → project "Wo"). */
export function activeTrigger(input: string, caret: number): Trigger | null {
  let s = caret;
  while (s > 0 && !/\s/.test(input[s - 1] ?? '') && caret - s < 64) s--;
  const kind = TRIGGER_KIND[input[s] ?? ''];
  if (!kind || s >= caret) return null;
  return { kind, start: s, query: input.slice(s + 1, caret) };
}

/** Convenience for callers that hold a time zone rather than a local time. */
export function nowIn(timeZone: string, now?: Date): LocalNow {
  return localNow(timeZone, now);
}
