import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../../apps/android/app/src/main/assets/nlp.js', import.meta.url),
  'utf8',
);

describe('committed Android parser asset', () => {
  it('keeps the saved-filter bundle in sync with shared date shorthand', () => {
    const filterSource = readFileSync(
      new URL('../../../apps/android/app/src/main/assets/filter.js', import.meta.url),
      'utf8',
    );
    const filter = runInNewContext(`${filterSource};bokydoFilter`, Object.create(null));
    const output = JSON.parse(
      filter(
        JSON.stringify({
          query: 'tom & p1',
          now: { date: '2026-11-10', time: '10:00' },
          tasks: [
            { id: 'today', priority: 1, due: { date: '2026-11-10' } },
            { id: 'tomorrow', priority: 1, due: { date: '2026-11-11' } },
            { id: 'later', priority: 1, due: { date: '2026-11-12' } },
          ],
          projects: [],
          sections: [],
        }),
      ),
    );
    expect(output.ok).toBe(true);
    expect(output.lists[0].taskIds).toEqual(['tomorrow']);
  });

  it('runs shorthand through the actual packaged entry point without browser or Node globals', () => {
    const parse = runInNewContext(`${source};bokydoQuickAdd`, Object.create(null));
    const options = { now: { date: '2026-11-10', time: '10:00' } };
    const result = JSON.parse(
      parse(JSON.stringify({ text: 'Call Ana tom 15:00 p1 %phone', options })),
    );
    expect(result).toMatchObject({
      content: 'Call Ana',
      priority: 1,
      labels: ['phone'],
      due: { date: '2026-11-11', time: '15:00' },
    });
    const recurring = JSON.parse(parse(JSON.stringify({ text: 'Walk ev! day p2', options })));
    expect(recurring).toMatchObject({
      content: 'Walk',
      priority: 2,
      due: { recurrence: { rrule: 'FREQ=DAILY', anchor: 'completion' } },
    });
  });
});
