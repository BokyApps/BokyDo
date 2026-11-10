import { describe, expect, it } from 'vitest';
import { quickAddJson } from './bridge.js';
import { activeTrigger, parseQuickAdd, tokenKey } from './quick-add.js';

const options = {
  now: { date: '2026-10-05', time: '10:00' },
  defaultProjectId: 'inbox',
  projects: [
    { id: 'work', name: 'Work' },
    { id: 'tom', name: 'Tom' },
  ],
  labels: ['phone'],
};

describe('Todoist quick-add shorthand', () => {
  it.each(['tom', 'TOM', 'tmr', 'tmrw', 'tomorrow'])(
    'combines %s with time and priority',
    (day) => {
      const input = `Call Ana ${day} 3p p1 #Work %phone`;
      const parsed = parseQuickAdd(input, options);
      expect(parsed).toMatchObject({
        content: 'Call Ana',
        due: { date: '2026-10-06', time: '15:00' },
        priority: 1,
        projectId: 'work',
        labels: ['phone'],
      });
      expect(JSON.parse(quickAddJson(JSON.stringify({ text: input, options })))).toEqual(parsed);
    },
  );

  it.each([
    ['tommorning', '09:00'],
    ['tomafternoon', '12:00'],
    ['tomevening', '19:00'],
    ['tomnight', '22:00'],
  ])('reads joined date %s', (shortcut, time) => {
    expect(parseQuickAdd(`Read ${shortcut} p2`, options)).toMatchObject({
      content: 'Read',
      priority: 2,
      due: { date: '2026-10-06', time },
    });
  });

  it('uses the same named-time defaults for spaced and joined forms', () => {
    for (const period of ['morning', 'afternoon', 'evening', 'night']) {
      const joined = parseQuickAdd(`Read tom${period}`, options).due;
      const spaced = parseQuickAdd(`Read tomorrow ${period}`, options).due;
      expect(joined?.date).toBe(spaced?.date);
      expect(joined?.time).toBe(spaced?.time);
    }
  });

  it.each(['ev mon, fri at 20:00', 'EV mon, fri at 20:00', 'ev! 2d'])(
    'expands recurrence %s',
    (shortcut) => {
      const short = parseQuickAdd(`Walk ${shortcut}`, options);
      const full = parseQuickAdd(`Walk ${shortcut.replace(/^ev/i, 'every')}`, options);
      expect(short.due?.recurrence).toBeTruthy();
      expect(short.due?.date).toBe(full.due?.date);
      expect(short.due?.time).toBe(full.due?.time);
      expect(short.due?.recurrence).toEqual(full.due?.recurrence);
      expect(short.content).toBe('Walk');
    },
  );

  it('reads spaced compact meridiems without consuming a priority token', () => {
    expect(parseQuickAdd('Read tom 3 p p1', options)).toMatchObject({
      content: 'Read',
      due: { date: '2026-10-06', time: '15:00' },
      priority: 1,
    });
  });

  it('supports both label prefixes, deduplicates them and autocompletes percent labels', () => {
    expect(parseQuickAdd('Call %PHONE @phone p3', options)).toMatchObject({
      content: 'Call',
      labels: ['phone'],
      priority: 3,
    });
    expect(activeTrigger('Call %pho', 9)).toEqual({ kind: 'label', start: 5, query: 'pho' });
  });

  it.each(['Buy tomatoes', 'Tomography results', 'Read tomeveningly', 'Finish 25%'])(
    'keeps ordinary text: %s',
    (text) => {
      expect(parseQuickAdd(text, options)).toMatchObject({ content: text, due: null, labels: [] });
    },
  );

  it('keeps date-like labels and project names out of date parsing', () => {
    expect(parseQuickAdd('Read #Tom %tom', options)).toMatchObject({
      content: 'Read',
      projectId: 'tom',
      labels: ['tom'],
      due: null,
    });
  });

  it('lets the user keep shorthand as literal text and respects smart-date preferences', () => {
    const input = 'Call tom p1';
    const due = parseQuickAdd(input, options).tokens.find((t) => t.kind === 'due');
    expect(due).toBeDefined();
    expect(parseQuickAdd(input, { ...options, disabled: new Set([tokenKey(due!)]) })).toMatchObject(
      {
        content: 'Call tom',
        due: null,
        priority: 1,
      },
    );
    expect(parseQuickAdd('Read tomnight p1', { ...options, smartDates: false })).toMatchObject({
      content: 'Read tomnight',
      due: null,
      priority: 1,
    });
  });
});
