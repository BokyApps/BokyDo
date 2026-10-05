import {
  addDays,
  addMonths,
  parseDate,
  startOfWeek,
  ymd,
  yearOf,
  monthOf,
  daysInMonth,
  type LocalNow,
  type WeekStart,
} from '@bokydo/nlp';

/**
 * Todoist's filter language: `today | overdue`, `#Work & p1`, `!@waiting & 7 days`,
 * `(today | tomorrow), #Home` (a comma gives separate lists). Parsing resolves dates against the
 * user's "now", so the resulting tree is plain data that both the in-memory evaluator and the
 * server's SQL compiler read the same way.
 *
 * The lexer is a single character loop and the parser plain recursive descent with hard limits
 * on length, terms and nesting: no regular expression ever sees more than one short term.
 */

export type DateField = 'due' | 'deadline' | 'created';

export type Term =
  | { t: 'all' }
  /** Inclusive local-date range on a field; null = open-ended. Never both null. */
  | { t: 'date'; field: DateField; from: string | null; to: string | null }
  | { t: 'overdue' }
  | { t: 'noDate' }
  | { t: 'noTime' }
  | { t: 'recurring' }
  | { t: 'noDeadline' }
  | { t: 'priority'; p: 1 | 2 | 3 | 4 }
  /** `#name` (`sub`: `##name`, sub-projects too). Patterns may use `*`. */
  | { t: 'project'; pattern: string; sub: boolean }
  /** `/name`; `/*` = in any section. */
  | { t: 'section'; pattern: string }
  | { t: 'label'; pattern: string }
  | { t: 'noLabels' }
  | { t: 'assignedTo'; who: 'me' | 'others' | 'anyone' | 'nobody' }
  | { t: 'assignedBy'; who: 'me' | 'others' }
  /** By a collaborator's username (`*` allowed). */
  | { t: 'assignedToName'; pattern: string }
  | { t: 'assignedByName'; pattern: string }
  /** In a project with more than one member. */
  | { t: 'shared' }
  | { t: 'search'; text: string }
  | { t: 'subtask' };

export type FilterNode =
  | { op: 'and' | 'or'; left: FilterNode; right: FilterNode }
  | { op: 'not'; child: FilterNode }
  | { op: 'term'; term: Term; text: string; start: number; end: number };

export interface FilterQuery {
  /** This list's source text, e.g. "today | overdue". */
  text: string;
  node: FilterNode;
}

export interface FilterError {
  message: string;
  start: number;
  end: number;
}

export type ParseResult = { ok: true; queries: FilterQuery[] } | { ok: false; error: FilterError };

export interface FilterContext {
  now: LocalNow;
  weekStart?: WeekStart;
  dateOrder?: 'dmy' | 'mdy' | 'ymd';
}

export const LIMITS = { length: 1024, lists: 10, terms: 64, depth: 16, search: 200 } as const;

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

type TokenType = '(' | ')' | '&' | '|' | ',' | '!' | 'term';
interface LexToken {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

const OPERATORS = new Set(['(', ')', '&', '|', ',']);

function lex(input: string): LexToken[] {
  const out: LexToken[] = [];
  let i = 0;
  let expectOperand = true;
  while (i < input.length) {
    const ch = input[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (OPERATORS.has(ch)) {
      out.push({ type: ch as TokenType, text: ch, start: i, end: i + 1 });
      expectOperand = ch !== ')';
      i++;
      continue;
    }
    if (ch === '!' && expectOperand) {
      out.push({ type: '!', text: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    // A term runs to the next unescaped operator; "\&" keeps an operator character literal.
    const start = i;
    let text = '';
    let end = i;
    while (i < input.length && !OPERATORS.has(input[i] ?? '')) {
      if (input[i] === '\\' && i + 1 < input.length) {
        text += input[i + 1];
        i += 2;
      } else {
        text += input[i];
        i++;
      }
      if (text.trimEnd().length === text.length) end = i;
    }
    out.push({ type: 'term', text: text.trim(), start, end });
    expectOperand = false;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

class ParseFailure extends Error {
  constructor(readonly error: FilterError) {
    super(error.message);
  }
}

export function parseFilter(input: string, ctx: FilterContext): ParseResult {
  try {
    if (input.length > LIMITS.length)
      fail(`Filters can be at most ${LIMITS.length} characters`, LIMITS.length, input.length);
    if (!input.trim()) fail('Type a filter, like “today | overdue”', 0, 0);
    return { ok: true, queries: new Parser(lex(input), input, ctx).list() };
  } catch (err) {
    if (err instanceof ParseFailure) return { ok: false, error: err.error };
    throw err;
  }
}

function fail(message: string, start: number, end: number): never {
  throw new ParseFailure({ message, start, end });
}

class Parser {
  private i = 0;
  private terms = 0;
  constructor(
    private readonly tokens: LexToken[],
    private readonly input: string,
    private readonly ctx: FilterContext,
  ) {}

  private peek(): LexToken | undefined {
    return this.tokens[this.i];
  }

  list(): FilterQuery[] {
    const queries: FilterQuery[] = [];
    for (;;) {
      const start = this.peek()?.start ?? this.input.length;
      const node = this.or(0);
      const last = this.tokens[this.i - 1];
      queries.push({ text: this.input.slice(start, last?.end ?? start).trim(), node });
      const next = this.peek();
      if (!next) return queries;
      if (next.type !== ',') fail(`Unexpected “${next.text}”`, next.start, next.end);
      this.i++;
      if (queries.length >= LIMITS.lists)
        fail(`At most ${LIMITS.lists} comma-separated lists`, next.start, next.end);
    }
  }

  private or(depth: number): FilterNode {
    let left = this.and(depth);
    while (this.peek()?.type === '|') {
      this.i++;
      left = { op: 'or', left, right: this.and(depth) };
    }
    return left;
  }

  private and(depth: number): FilterNode {
    let left = this.unary(depth);
    while (this.peek()?.type === '&') {
      this.i++;
      left = { op: 'and', left, right: this.unary(depth) };
    }
    return left;
  }

  private unary(depth: number): FilterNode {
    const tok = this.peek();
    if (depth > LIMITS.depth)
      fail('Too deeply nested', tok?.start ?? this.input.length, tok?.end ?? this.input.length);
    if (!tok) fail('The filter ends too early', this.input.length, this.input.length);
    if (tok.type === '!') {
      this.i++;
      return { op: 'not', child: this.unary(depth + 1) };
    }
    if (tok.type === '(') {
      this.i++;
      const node = this.or(depth + 1);
      const close = this.peek();
      if (close?.type !== ')')
        fail('Missing “)”', close?.start ?? this.input.length, close?.end ?? this.input.length);
      this.i++;
      return node;
    }
    if (tok.type !== 'term')
      fail(`Expected a filter term before “${tok.text}”`, tok.start, tok.end);
    this.i++;
    if (++this.terms > LIMITS.terms)
      fail(`At most ${LIMITS.terms} terms per filter`, tok.start, tok.end);
    const term = recognize(tok.text, this.ctx);
    if (typeof term === 'string') fail(term, tok.start, tok.end);
    return { op: 'term', term, text: tok.text, start: tok.start, end: tok.end };
  }
}

// ---------------------------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------------------------

type Range = { from: string | null; to: string | null };

const FIELD_PREFIXES: [string, DateField, 'on' | 'before' | 'after'][] = [
  ['due before:', 'due', 'before'],
  ['date before:', 'due', 'before'],
  ['due after:', 'due', 'after'],
  ['date after:', 'due', 'after'],
  ['due:', 'due', 'on'],
  ['date:', 'due', 'on'],
  ['deadline before:', 'deadline', 'before'],
  ['deadline after:', 'deadline', 'after'],
  ['deadline:', 'deadline', 'on'],
  ['created before:', 'created', 'before'],
  ['created after:', 'created', 'after'],
  ['created:', 'created', 'on'],
];

const KEYWORDS: Readonly<Record<string, Term>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Term>, {
    all: { t: 'all' },
    'view all': { t: 'all' },
    overdue: { t: 'overdue' },
    od: { t: 'overdue' },
    'no date': { t: 'noDate' },
    'no due date': { t: 'noDate' },
    'no time': { t: 'noTime' },
    recurring: { t: 'recurring' },
    'no deadline': { t: 'noDeadline' },
    'no labels': { t: 'noLabels' },
    'no label': { t: 'noLabels' },
    subtask: { t: 'subtask' },
    subtasks: { t: 'subtask' },
    assigned: { t: 'assignedTo', who: 'anyone' },
    unassigned: { t: 'assignedTo', who: 'nobody' },
    'no assignee': { t: 'assignedTo', who: 'nobody' },
    'no priority': { t: 'priority', p: 4 },
  } satisfies Record<string, Term>),
);

/** One term's meaning, or an error message. */
export function recognize(raw: string, ctx: FilterContext): Term | string {
  const text = raw.replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  if (!text) return 'Empty filter term';
  const keyword = KEYWORDS[lower];
  if (keyword) return keyword;
  if (/^p[1-4]$/.test(lower)) return { t: 'priority', p: Number(lower[1]) as 1 | 2 | 3 | 4 };

  if (text.startsWith('##')) return name(text.slice(2), 'project', true);
  if (text.startsWith('#')) return name(text.slice(1), 'project', false);
  if (text.startsWith('/')) return name(text.slice(1), 'section', false);
  if (text.startsWith('@')) return name(text.slice(1), 'label', false);

  if (lower.startsWith('search:')) {
    const q = text.slice('search:'.length).trim();
    if (!q) return 'Add something to search for after “search:”';
    if (q.length > LIMITS.search) return `Searches can be at most ${LIMITS.search} characters`;
    return { t: 'search', text: q };
  }
  if (lower.startsWith('assigned to:')) {
    const who = lower.slice('assigned to:'.length).trim();
    if (who === 'me' || who === 'others' || who === 'anyone') return { t: 'assignedTo', who };
    if (who === 'nobody' || who === 'no one') return { t: 'assignedTo', who: 'nobody' };
    const raw = text.slice('assigned to:'.length).trim();
    if (!raw) return 'Add a name after “assigned to:”';
    return { t: 'assignedToName', pattern: raw };
  }
  if (lower.startsWith('assigned by:')) {
    const who = lower.slice('assigned by:'.length).trim();
    if (who === 'me' || who === 'others') return { t: 'assignedBy', who };
    const raw = text.slice('assigned by:'.length).trim();
    if (!raw) return 'Add a name after “assigned by:”';
    return { t: 'assignedByName', pattern: raw };
  }
  if (lower === 'shared') return { t: 'shared' };
  if (lower.startsWith('workspace:')) return `Workspaces arrive later in collaboration (W5)`;

  for (const [prefix, field, op] of FIELD_PREFIXES) {
    if (!lower.startsWith(prefix)) continue;
    const value = text.slice(prefix.length).trim();
    const range = rangeOf(value, ctx);
    if (!range) return `“${value || '…'}” isn't a date this filter understands`;
    if (op === 'on') return { t: 'date', field, ...range };
    if (op === 'before') {
      if (range.from === null) return `“${value}” has no start to be before`;
      return { t: 'date', field, from: null, to: addDays(range.from, -1) };
    }
    if (range.to === null) return `“${value}” has no end to be after`;
    return { t: 'date', field, from: addDays(range.to, 1), to: null };
  }

  const range = rangeOf(text, ctx);
  if (range) return { t: 'date', field: 'due', ...range };
  return `Unknown filter term “${text}”. To find text, use “search: ${text}”`;
}

function name(pattern: string, kind: 'project' | 'section' | 'label', sub: boolean): Term | string {
  const p = pattern.trim();
  if (!p)
    return `Add a ${kind} name after “${kind === 'project' ? '#' : kind === 'section' ? '/' : '@'}”`;
  if (p.length > 200) return `That ${kind} name is too long`;
  if (kind === 'project') return { t: 'project', pattern: p, sub };
  if (kind === 'section') return { t: 'section', pattern: p };
  return { t: 'label', pattern: p };
}

/** A date or date range: keywords, "7 days", "this week", or anything `parseDate` reads. */
export function rangeOf(value: string, ctx: FilterContext): Range | null {
  const today = ctx.now.date;
  const lower = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!lower) return null;
  if (lower === 'today' || lower === 'tod') return { from: today, to: today };
  if (lower === 'tomorrow' || lower === 'tmr' || lower === 'tmrw') {
    const d = addDays(today, 1);
    return { from: d, to: d };
  }
  if (lower === 'yesterday') {
    const d = addDays(today, -1);
    return { from: d, to: d };
  }
  // "7 days", "next 7 days" (today and the 6 after), "-7 days" (the 7 before today), "2 weeks"
  const m = /^(next |-)?(\d{1,3}) (days?|weeks?)$/.exec(lower);
  if (m) {
    const n = Number(m[2]) * (m[3]?.startsWith('week') ? 7 : 1);
    if (n < 1 || n > 3660) return null;
    return m[1] === '-'
      ? { from: addDays(today, -n), to: addDays(today, -1) }
      : { from: today, to: addDays(today, n - 1) };
  }
  const weekStart = ctx.weekStart ?? 'monday';
  if (lower === 'this week' || lower === 'next week') {
    const from = addDays(startOfWeek(today, weekStart), lower === 'next week' ? 7 : 0);
    return { from, to: addDays(from, 6) };
  }
  if (lower === 'this month' || lower === 'next month') {
    const first = addMonths(`${today.slice(0, 7)}-01`, lower === 'next month' ? 1 : 0);
    return {
      from: first,
      to: ymd(yearOf(first), monthOf(first), daysInMonth(yearOf(first), monthOf(first))),
    };
  }
  const parsed = parseDate(value, {
    now: ctx.now,
    weekStart,
    dateOrder: ctx.dateOrder ?? 'dmy',
  });
  if (!parsed || parsed.recurrence) return null;
  return { from: parsed.date, to: parsed.date };
}
