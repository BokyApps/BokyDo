import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { globMatch, matcher, parseFilter, resolveFilter, LIMITS } from './index.js';

/** ReDoS / complexity gate: any query up to the length limit parses and runs quickly. */
const CTX = { now: { date: '2026-10-05', time: '10:00' } };
const clock = (globalThis as unknown as { performance: { now(): number } }).performance;

function bestOf(fn: () => void): number {
  for (let i = 0; i < 3; i++) fn();
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t = clock.now();
    fn();
    best = Math.min(best, clock.now() - t);
  }
  return best;
}

const PIECES = [
  'today',
  'overdue',
  'no date',
  'p1',
  '#Work',
  '##Work',
  '#W*',
  '/*',
  '@e*',
  'search: x',
  'due before: friday',
  '7 days',
  '&',
  '|',
  '!',
  '(',
  ')',
  ',',
  '\\',
  '*',
  ' ',
  'assigned to: me',
  'created: today',
  'deadline: next week',
  'constructor',
  '__proto__',
];
const query = fc
  .array(fc.oneof(fc.constantFrom(...PIECES), fc.string({ maxLength: 6 })), { maxLength: 200 })
  .map((xs) => xs.join(' ').slice(0, LIMITS.length));

describe('filter safety', () => {
  it('parses any query within 5 ms and never throws', () => {
    fc.assert(
      fc.property(query, (q) => {
        expect(bestOf(() => parseFilter(q, CTX))).toBeLessThan(5);
      }),
      { numRuns: 300 },
    );
  });

  it.each([
    ['nesting', `${'('.repeat(16)}p1${')'.repeat(16)}`],
    ['negations', `${'!'.repeat(16)}p1`],
    ['escapes', '\\'.repeat(1024)],
    ['operators', '&|'.repeat(512)],
    ['long term', `search: ${'a'.repeat(190)}`],
    ['many terms', 'p1 | '.repeat(63) + 'p2'],
    ['wildcards', `#${'*a'.repeat(100)}b`],
  ])('stays fast on %s', (_, q) => {
    expect(bestOf(() => parseFilter(q, CTX))).toBeLessThan(5);
  });

  it('matches adversarial wildcards against long names quickly', () => {
    const pattern = `${'*a'.repeat(60)}b`;
    const name = 'a'.repeat(120);
    expect(bestOf(() => globMatch(pattern, name))).toBeLessThan(5);
  });

  it('evaluates a 64-term query over 10,000 tasks quickly', () => {
    const r = parseFilter(`${'(p1 | @e* | today) & '.repeat(21)}#Work*`, CTX);
    if (!r.ok) throw new Error(r.error.message);
    const { queries } = resolveFilter(r.queries, {
      projects: [{ id: 'w', name: 'Work', parentId: null }],
      sections: [],
    });
    const match = matcher(queries[0]!.node, { now: CTX.now, userId: 'u', timeZone: 'UTC' });
    const tasks = Array.from({ length: 10_000 }, (_, i) => ({
      projectId: i % 2 ? 'w' : 'x',
      sectionId: null,
      parentId: null,
      content: `task ${i}`,
      priority: (i % 4) + 1,
      due: i % 3 ? { date: '2026-10-05', time: null, recurrence: null } : null,
      deadline: null,
      labels: i % 5 ? ['errands', `l${i % 50}`] : [],
      assigneeId: null,
      assignedById: null,
      createdAt: '2026-10-01T00:00:00Z',
    }));
    expect(bestOf(() => tasks.filter(match))).toBeLessThan(100);
  });
});
