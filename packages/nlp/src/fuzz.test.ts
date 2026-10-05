import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lex } from './grammar.js';
import { MONTHS, UNITS, WEEKDAYS } from './lexicon.js';
import { parseRRule } from './recurrence.js';
import { MAX_PARSE_LENGTH, parseDate, parseQuickAdd, type QuickAddOptions } from './quick-add.js';

/**
 * ReDoS gate (PLAN §4): no input up to 2 KB may take more than 5 ms to parse. Inputs are built
 * from the grammar's own vocabulary, so the fuzzer spends its time inside the date and
 * recurrence grammar rather than on words it rejects at once.
 */
const BUDGET_MS = 5;

const OPTIONS: QuickAddOptions = {
  now: { date: '2026-10-05', time: '10:00' },
  projects: Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: `Project ${i} name` })),
  sections: Array.from({ length: 50 }, (_, i) => ({
    id: `s${i}`,
    name: `Section ${i}`,
    projectId: 'p1',
  })),
  members: Array.from({ length: 50 }, (_, i) => ({ id: `u${i}`, name: `Member ${i}` })),
};

const VOCAB = [
  ...Object.keys(WEEKDAYS),
  ...Object.keys(MONTHS),
  ...Object.keys(UNITS),
  'every',
  'every!',
  'other',
  'next',
  'this',
  'in',
  'on',
  'at',
  'by',
  'the',
  'of',
  'and',
  'starting',
  'until',
  'from',
  'end',
  'mid',
  'for',
  'last',
  '2nd',
  'first',
  'tomorrow',
  'today',
  'tonight',
  'morning',
  'noon',
  '5pm',
  '17:00',
  '9',
  '27',
  '27/10',
  '2026-10-27',
  '1h30m',
  'p1',
  '@x',
  '#Project',
  '/Section',
  '+Member',
  '{',
  '}',
  '{tomorrow}',
  '!30m',
  '!',
  ',',
  '.',
  '1',
  '12',
  '2027',
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'valueOf',
];

const sentence = fc
  .array(fc.oneof(fc.constantFrom(...VOCAB), fc.string({ maxLength: 8 })), { maxLength: 400 })
  .map((ws) => ws.join(' ').slice(0, MAX_PARSE_LENGTH));

const clock = (globalThis as unknown as { performance: { now(): number } }).performance;

/**
 * Best of several runs after a warm-up, so a GC pause, JIT tier-up or a busy CI machine (test
 * files run in parallel) isn't mistaken for slow parsing. Super-linear code fails every run.
 */
function bestOf(fn: () => void): number {
  for (let i = 0; i < 5; i++) fn();
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t = clock.now();
    fn();
    best = Math.min(best, clock.now() - t);
  }
  return best;
}

describe('parser safety', () => {
  it(`parses any 2 KB input within ${BUDGET_MS} ms`, () => {
    // Warm up the JIT first.
    for (let i = 0; i < 50; i++)
      parseQuickAdd('Call mom tomorrow at 5pm #Project 1 name p1', OPTIONS);
    let worst = 0;
    fc.assert(
      fc.property(sentence, (input) => {
        const ms = bestOf(() => parseQuickAdd(input, OPTIONS));
        worst = Math.max(worst, ms);
        expect(ms).toBeLessThan(BUDGET_MS);
      }),
      { numRuns: 300 },
    );
    expect(worst).toBeLessThan(BUDGET_MS);
  });

  it.each([
    ['repeated triggers', '#'.repeat(2048)],
    ['repeated labels', '@a '.repeat(700)],
    ['repeated every', 'every '.repeat(400)],
    ['repeated dates', 'tomorrow at 5pm '.repeat(130)],
    ['repeated weekday lists', 'every mon, '.repeat(200)],
    ['unclosed braces', '{ '.repeat(1000)],
    ['digits', '1'.repeat(2048)],
    ['colons', '1:'.repeat(1024)],
    ['dots', '1.'.repeat(1024)],
    ['slashes', '1/'.repeat(1024)],
    ['bangs', '!'.repeat(2048)],
    ['long word', 'a'.repeat(2048)],
    ['whitespace', ' \t'.repeat(1024)],
    ['project prefix', '#Project 1 '.repeat(180)],
  ])('stays fast on %s', (_, input) => {
    parseQuickAdd(input, OPTIONS);
    expect(bestOf(() => parseQuickAdd(input, OPTIONS))).toBeLessThan(BUDGET_MS);
    expect(bestOf(() => parseDate(input.slice(0, 200), OPTIONS))).toBeLessThan(BUDGET_MS);
    expect(bestOf(() => parseRRule(input.slice(0, 500)))).toBeLessThan(BUDGET_MS);
  });

  it('never throws, and tokens always point into the input', () => {
    fc.assert(
      fc.property(fc.oneof(sentence, fc.string({ maxLength: 300 })), (input) => {
        const r = parseQuickAdd(input, OPTIONS);
        let last = -1;
        for (const t of r.tokens) {
          expect(t.start).toBeGreaterThan(last);
          expect(t.end).toBeGreaterThan(t.start);
          expect(input.slice(t.start, t.end)).toBe(t.text);
          last = t.end - 1;
        }
        expect(r.content.length).toBeLessThanOrEqual(input.length);
        if (r.due) {
          expect(r.due.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(r.due.string.length).toBeLessThanOrEqual(200);
          if (r.due.recurrence) expect(parseRRule(r.due.recurrence.rrule)).not.toBeNull();
        }
        if (r.durationMinutes !== null) {
          expect(r.durationMinutes).toBeGreaterThanOrEqual(1);
          expect(r.durationMinutes).toBeLessThanOrEqual(1440);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'ignores inherited property names such as %s',
    (word) => {
      for (const input of [
        `every ${word}`,
        `next ${word}`,
        `in 2 ${word}`,
        `${word} 5`,
        `5 ${word}`,
        `for 2 ${word}`,
        word,
      ]) {
        const r = parseQuickAdd(`Task ${input}`, OPTIONS);
        expect(r.due, input).toBeNull();
        expect(r.durationMinutes, input).toBeNull();
        expect(parseDate(input, OPTIONS), input).toBeNull();
      }
    },
  );

  it('lexes in one linear pass', () => {
    expect(lex('a '.repeat(10_000)).length).toBe(10_000);
    expect(lex('  “quoted,” (word)!').map((w) => w.text)).toEqual(['quoted', 'word']);
  });
});
