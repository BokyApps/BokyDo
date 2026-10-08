import { describe, expect, it } from 'vitest';
import { quickAddJson } from './bridge.js';
import { parseQuickAdd } from './quick-add.js';

const now = { date: '2026-10-07', time: '10:00' };
const options = {
  now,
  projects: [{ id: 'p-work', name: 'Work' }],
  labels: ['phone'],
  defaultProjectId: 'p-inbox',
};

describe('quickAddJson (the Android bridge)', () => {
  it('returns exactly what parseQuickAdd returns', () => {
    const text = 'Call Ana tomorrow 3pm #Work p1 @phone every monday';
    const out = JSON.parse(quickAddJson(JSON.stringify({ text, options })));
    expect(out).toEqual(JSON.parse(JSON.stringify(parseQuickAdd(text, options))));
    expect(out.projectId).toBe('p-work');
    expect(out.priority).toBe(1);
    expect(out.labels).toEqual(['phone']);
  });

  it('takes disabled token keys as an array', () => {
    const text = 'Read #Work';
    const out = JSON.parse(
      quickAddJson(JSON.stringify({ text, options: { ...options, disabled: ['project:#work'] } })),
    );
    expect(out.projectId).toBeNull();
    expect(out.content).toBe('Read #Work');
  });

  it('treats hostile text as text', () => {
    const text = '"); globalThis.pwned = 1; ("';
    const out = JSON.parse(quickAddJson(JSON.stringify({ text, options })));
    expect(out.content).toBe(text);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  it('refuses input without text or now', () => {
    expect(() => quickAddJson(JSON.stringify({ options }))).toThrow(TypeError);
    expect(() => quickAddJson(JSON.stringify({ text: 'x', options: {} }))).toThrow(TypeError);
    expect(() => quickAddJson('not json')).toThrow();
  });
});
