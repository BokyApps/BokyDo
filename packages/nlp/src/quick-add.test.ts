import { describe, expect, it } from 'vitest';
import { activeTrigger, parseQuickAdd, tokenKey, type QuickAddOptions } from './quick-add.js';

const OPTIONS: QuickAddOptions = {
  now: { date: '2026-10-05', time: '10:00' },
  projects: [
    { id: 'home', name: 'Home' },
    { id: 'reno', name: 'Home Reno' },
    { id: 'work', name: 'Work' },
    { id: 'q4', name: 'Work/Q4 Launch' },
  ],
  sections: [
    { id: 'w-next', name: 'Next up', projectId: 'work' },
    { id: 'w-later', name: 'Later', projectId: 'work' },
    { id: 'i-later', name: 'Later', projectId: 'inbox' },
  ],
  members: [
    { id: 'u-sam', name: 'Sam' },
    { id: 'u-sam-lee', name: 'Sam Lee' },
  ],
  labels: ['Errands', 'phone'],
  defaultProjectId: 'inbox',
};
const parse = (input: string, extra: Partial<QuickAddOptions> = {}) =>
  parseQuickAdd(input, { ...OPTIONS, ...extra });

describe('quick add tokens', () => {
  it('parses the full Todoist syntax in one line', () => {
    const r = parse(
      'Call the plumber tomorrow at 5pm #Home Reno /Later @phone @urgent p1 +Sam for 15min {fri} !30m before',
    );
    expect(r).toMatchObject({
      content: 'Call the plumber /Later',
      due: { date: '2026-10-06', time: '17:00', string: 'tomorrow at 5pm', recurrence: null },
      projectId: 'reno',
      priority: 1,
      labels: ['phone', 'urgent'],
      assigneeId: 'u-sam',
      durationMinutes: 15,
      deadline: '2026-10-09',
      reminders: [{ type: 'relative', minutesBefore: 30 }],
    });
    // "/Later" isn't a section of Home Reno, so it stays in the title.
    expect(r.sectionId).toBeNull();
    expect(r.tokens.map((t) => t.kind)).toEqual([
      'due',
      'project',
      'label',
      'label',
      'priority',
      'assignee',
      'duration',
      'deadline',
      'reminder',
    ]);
  });

  it('reports token offsets that slice back to the typed text', () => {
    const input = 'Pay rent every 1st #Home p2 @Errands';
    const r = parse(input);
    for (const t of r.tokens) expect(input.slice(t.start, t.end)).toBe(t.text);
    expect(r.tokens.map((t) => t.text)).toEqual(['every 1st', '#Home', 'p2', '@Errands']);
  });

  describe('#project', () => {
    it('prefers the longest matching name', () => {
      expect(parse('Paint #Home Reno walls').projectId).toBe('reno');
      expect(parse('Paint #Home walls').projectId).toBe('home');
      expect(parse('Plan #Work/Q4 Launch').projectId).toBe('q4');
    });
    it('matches case-insensitively, at a word boundary only', () => {
      expect(parse('x #home').projectId).toBe('home');
      expect(parse('x #Homework').projectId).toBeNull();
      expect(parse('x #Home, then y')).toMatchObject({ projectId: 'home', content: 'x, then y' });
    });
    it('leaves unknown projects and hashtags as text', () => {
      expect(parse('Fix bug #123')).toMatchObject({ projectId: null, content: 'Fix bug #123' });
      expect(parse('Ideas #Nope')).toMatchObject({ projectId: null, content: 'Ideas #Nope' });
    });
    it('only resolves to projects it was given (never trusted for access)', () => {
      expect(parse('x #Secret', { projects: [] }).projectId).toBeNull();
    });
    it('uses the first project when several are given', () => {
      expect(parse('x #Work #Home')).toMatchObject({ projectId: 'work', content: 'x #Home' });
    });
  });

  describe('/section', () => {
    it('resolves within the #project, wherever it appears', () => {
      expect(parse('x /Next up #Work').sectionId).toBe('w-next');
      expect(parse('x #Work /Later').sectionId).toBe('w-later');
    });
    it('falls back to the default project', () => {
      expect(parse('x /Later').sectionId).toBe('i-later');
      expect(parse('x /Next up').sectionId).toBeNull();
    });
    it('leaves slashes in ordinary text alone', () => {
      expect(parse('and/or /tmp cleanup').content).toBe('and/or /tmp cleanup');
    });
  });

  describe('@label', () => {
    it('reuses the capitalisation of existing labels and dedupes', () => {
      expect(parse('x @errands @ERRANDS @new').labels).toEqual(['Errands', 'new']);
    });
    it('ignores e-mail addresses and stray @', () => {
      expect(parse('Mail bob@example.com @ now')).toMatchObject({
        labels: [],
        content: 'Mail bob@example.com @ now',
      });
    });
    it('rejects names a label cannot have', () => {
      expect(parse('x @a#b').labels).toEqual([]);
      expect(parse(`x @${'a'.repeat(61)}`).labels).toEqual([]);
    });
    it('strips trailing punctuation from the label', () => {
      expect(parse('Buy bread @errands, milk')).toMatchObject({
        labels: ['Errands'],
        content: 'Buy bread, milk',
      });
    });
  });

  describe('p1–p4', () => {
    it('takes the first priority and leaves lookalikes alone', () => {
      expect(parse('x p3 p1')).toMatchObject({ priority: 3, content: 'x p1' });
      expect(parse('Buy p5 parts and P2 cables')).toMatchObject({
        priority: 2,
        content: 'Buy p5 parts and cables',
      });
      expect(parse('Order p10')).toMatchObject({ priority: null });
    });
  });

  describe('+assignee', () => {
    it('matches known members only, longest first', () => {
      expect(parse('Review +Sam Lee').assigneeId).toBe('u-sam-lee');
      expect(parse('Review +Sam').assigneeId).toBe('u-sam');
      expect(parse('Review +Alex')).toMatchObject({ assigneeId: null, content: 'Review +Alex' });
      expect(parse('1 +1 = 2').content).toBe('1 +1 = 2');
    });
  });

  describe('for <duration>', () => {
    it.each([
      ['for 45min', 45],
      ['for 45 min', 45],
      ['for 45m', 45],
      ['for 2h', 120],
      ['for 2 hours', 120],
      ['for 1.5h', 90],
      ['for 1.5 hours', 90],
      ['for 1h30m', 90],
      ['for 1h30', 90],
      ['for an hour', 60],
      ['for half an hour', 30],
      ['for 1 hour 30 minutes', 90],
      ['for 2 hours and 15 min', 135],
      ['for 24h', 1440],
    ])('%s', (phrase, minutes) => {
      expect(parse(`Focus ${phrase}`)).toMatchObject({
        durationMinutes: minutes,
        content: 'Focus',
      });
    });
    it.each(['for 3 days', 'for 25h', 'for 0 min', 'for you', 'for 2'])('not %s', (phrase) => {
      expect(parse(`Gift ${phrase}`)).toMatchObject({
        durationMinutes: null,
        content: `Gift ${phrase}`,
      });
    });
  });

  describe('{deadline}', () => {
    it('parses any date inside braces', () => {
      expect(parse('Report {next friday}').deadline).toBe('2026-10-16');
      expect(parse('Report {27/10}').deadline).toBe('2026-10-27');
      expect(parse('Report {jan 5} tomorrow')).toMatchObject({
        deadline: '2027-01-05',
        due: { date: '2026-10-06' },
        content: 'Report',
      });
    });
    it('keeps braces that are not a date', () => {
      expect(parse('Fix {foo} bar')).toMatchObject({ deadline: null, content: 'Fix {foo} bar' });
      expect(parse('Fix {every day}').deadline).toBeNull();
      expect(parse('Fix {tomorrow').deadline).toBeNull();
    });
  });

  describe('!reminder', () => {
    it('reads relative and absolute reminders', () => {
      expect(parse('x !30m').reminders).toEqual([{ type: 'relative', minutesBefore: 30 }]);
      expect(parse('x !1h before').reminders).toEqual([{ type: 'relative', minutesBefore: 60 }]);
      expect(parse('x !1d').reminders).toEqual([{ type: 'relative', minutesBefore: 1440 }]);
      expect(parse('x !tomorrow 9am').reminders).toEqual([
        { type: 'absolute', date: '2026-10-06', time: '09:00' },
      ]);
      expect(parse('x !fri').reminders).toEqual([
        { type: 'absolute', date: '2026-10-09', time: '09:00' },
      ]);
    });
    it('can be switched off', () => {
      expect(parse('Wow !30m', { reminders: false })).toMatchObject({
        reminders: [],
        content: 'Wow !30m',
      });
    });
    it('leaves exclamations alone', () => {
      expect(parse('Ship it!!! now')).toMatchObject({ reminders: [], content: 'Ship it!!! now' });
    });
  });

  describe('dates', () => {
    it('takes the first date and keeps the rest as text', () => {
      expect(parse('Move meeting from monday to friday')).toMatchObject({
        due: { date: '2026-10-05' },
        content: 'Move meeting from to friday',
      });
    });
    it('respects the smart date recognition preference', () => {
      expect(parse('Call tomorrow p1', { smartDates: false })).toMatchObject({
        due: null,
        priority: 1,
        content: 'Call tomorrow',
      });
    });
    it('drops the preposition from the stored phrase', () => {
      expect(parse('Pay by friday').due?.string).toBe('friday');
      expect(parse('Meet at 5pm').due?.string).toBe('5pm');
      expect(parse('Gym every mon').due?.string).toBe('every mon');
    });
    it('does not parse a date inside another token', () => {
      expect(parse('x @tomorrow #Work')).toMatchObject({ due: null, labels: ['tomorrow'] });
    });
  });

  describe('un-parsing', () => {
    it('keeps disabled tokens as text', () => {
      const first = parse('Read tomorrow p1 @home');
      const due = first.tokens.find((t) => t.kind === 'due')!;
      const r = parse('Read tomorrow p1 @home', { disabled: new Set([tokenKey(due)]) });
      expect(r).toMatchObject({ due: null, priority: 1, content: 'Read tomorrow' });
    });
    it('skips to the next candidate when one is disabled', () => {
      const r = parse('Read tomorrow or friday', { disabled: new Set(['due:tomorrow']) });
      expect(r).toMatchObject({ due: { date: '2026-10-09' }, content: 'Read tomorrow or' });
    });
  });

  it('tidies whitespace and punctuation left behind', () => {
    expect(parse('  Call   mom  tomorrow ,  please  ').content).toBe('Call mom, please');
    expect(parse('Line one tomorrow\nline two').content).toBe('Line one\nline two');
  });

  it('keeps text beyond the parse limit verbatim', () => {
    const long = `${'word '.repeat(500)}tomorrow`;
    const r = parse(long);
    expect(r.due).toBeNull();
    expect(r.content).toBe(long.trim());
  });
});

describe('activeTrigger', () => {
  it.each([
    ['Buy #Wo', 7, { kind: 'project', start: 4, query: 'Wo' }],
    ['Buy @', 5, { kind: 'label', start: 4, query: '' }],
    ['x /Ne', 5, { kind: 'section', start: 2, query: 'Ne' }],
    ['x +sa', 5, { kind: 'assignee', start: 2, query: 'sa' }],
    ['#Work', 5, { kind: 'project', start: 0, query: 'Work' }],
  ] as const)('%s', (input, caret, expected) => {
    expect(activeTrigger(input, caret)).toEqual(expected);
  });
  it.each([
    ['Buy milk', 8],
    ['Buy #Work now', 13],
    ['a@b', 3],
    ['#', 0],
  ])('none in %s', (input, caret) => {
    expect(activeTrigger(input, caret)).toBeNull();
  });
});
