import { describe, expect, it } from 'vitest';
import { escapeText, foldLine, renderCalendar, type FeedTask } from './ics.js';

const task = (over: Partial<FeedTask> = {}): FeedTask => ({
  id: '0192a3b4-0000-7000-8000-000000000001',
  summary: 'Write report',
  description: '',
  labels: [],
  priority: 4,
  projectName: null,
  date: '2026-07-01',
  time: null,
  timeZone: null,
  durationMinutes: null,
  rrule: null,
  updatedAt: new Date('2026-06-30T10:20:30.000Z'),
  url: null,
  ...over,
});

const render = (t: Partial<FeedTask>, includeDescriptions = false) =>
  renderCalendar({ name: 'Work', tasks: [task(t)], includeDescriptions });
/** Unfolded content lines (what a calendar app reads). */
const lines = (text: string) => text.replaceAll('\r\n ', '').split('\r\n').filter(Boolean);

describe('escapeText', () => {
  it('escapes the TEXT specials and line breaks', () => {
    expect(escapeText('a, b; c\\d')).toBe('a\\, b\\; c\\\\d');
    expect(escapeText('one\ntwo\r\nthree\rfour')).toBe('one\\ntwo\\nthree\\nfour');
  });

  it('turns control characters and Unicode line separators into spaces', () => {
    expect(escapeText('a\u0000b\u0007c\u001bd\u007fe\u0085f g h\ti')).toBe('a b c d e f g h i');
  });
});

describe('foldLine', () => {
  it('leaves short lines alone', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('folds at 75 octets, never inside a UTF-8 character, and unfolds to the original', () => {
    const original = `SUMMARY:${'日本語のタスク😀'.repeat(20)}`;
    const folded = foldLine(original);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(1);
    for (const [i, line] of physical.entries()) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      if (i > 0) expect(line.startsWith(' ')).toBe(true);
      // Every physical line is valid text: no half characters.
      expect(line).not.toContain('�');
    }
    expect(folded.replaceAll('\r\n ', '')).toBe(original);
  });
});

describe('renderCalendar', () => {
  it('writes a CRLF calendar with the required properties', () => {
    const text = render({});
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(text.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true);
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    const l = lines(text);
    expect(l).toContain('PRODID:-//BokyDo//Calendar feed//EN');
    expect(l).toContain('X-WR-CALNAME:Work');
    expect(l).toContain('UID:0192a3b4-0000-7000-8000-000000000001@bokydo');
    expect(l).toContain('DTSTAMP:20260630T102030Z');
    expect(l).toContain('TRANSP:TRANSPARENT');
  });

  it('cannot be made to start new properties or events from task text', () => {
    const hostile =
      'x\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:pwned\nATTENDEE:mailto:evil@example.com';
    const text = renderCalendar({
      name: hostile,
      tasks: [
        task({
          summary: hostile,
          description: hostile,
          labels: [hostile, 'a,b'],
          projectName: hostile,
          url: `https://example.com/task/1\r\nX-EVIL:1`,
        }),
      ],
      includeDescriptions: true,
    });
    // Line breaks exist only as CRLF pairs: a bare CR or LF would split lines in lenient parsers.
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    const l = lines(text);
    expect(l.filter((x) => x === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(l.filter((x) => x === 'END:VEVENT')).toHaveLength(1);
    expect(l.filter((x) => x === 'END:VCALENDAR')).toHaveLength(1);
    expect(l.some((x) => /^(ATTENDEE|X-EVIL|SUMMARY:pwned)/.test(x))).toBe(false);
    // Every line starts with a known property name.
    const known =
      /^(BEGIN|END|VERSION|PRODID|CALSCALE|METHOD|X-WR-CALNAME|REFRESH-INTERVAL|X-PUBLISHED-TTL|UID|DTSTAMP|LAST-MODIFIED|SUMMARY|DTSTART|DTEND|RRULE|DESCRIPTION|URL|CATEGORIES|PRIORITY|TRANSP)[:;]/;
    for (const line of l) expect(line, line).toMatch(known);
  });

  it('writes all-day tasks as DATE values ending the next day', () => {
    const l = lines(render({ date: '2026-12-31' }));
    expect(l).toContain('DTSTART;VALUE=DATE:20261231');
    expect(l).toContain('DTEND;VALUE=DATE:20270101');
  });

  it('writes floating times without a zone, and adds the duration as DTEND', () => {
    const l = lines(render({ time: '09:30', durationMinutes: 90 }));
    expect(l).toContain('DTSTART:20260701T093000');
    expect(l).toContain('DTEND:20260701T110000');
  });

  it('writes a fixed-zone one-off as the exact UTC instant', () => {
    // London is on summer time (UTC+1) on 1 July.
    const l = lines(render({ time: '09:00', timeZone: 'Europe/London', durationMinutes: 30 }));
    expect(l).toContain('DTSTART:20260701T080000Z');
    expect(l).toContain('DTEND:20260701T083000Z');
  });

  it('keeps the zone for repeating fixed-zone tasks so daylight saving is followed', () => {
    const l = lines(
      render({ time: '09:00', timeZone: 'Europe/London', rrule: 'FREQ=WEEKLY;BYDAY=WE' }),
    );
    expect(l).toContain('DTSTART;TZID=Europe/London:20260701T090000');
    expect(l).toContain('RRULE:FREQ=WEEKLY;BYDAY=WE');
  });

  it('treats an invalid zone as floating rather than writing it out', () => {
    const l = lines(render({ time: '09:00', timeZone: 'Mars/Olympus;X=1' }));
    expect(l).toContain('DTSTART:20260701T090000');
    expect(l.join('\n')).not.toContain('Mars');
  });

  it('gives UNTIL the same form as DTSTART', () => {
    const rule = 'FREQ=DAILY;UNTIL=20260710';
    expect(lines(render({ rrule: rule }))).toContain('RRULE:FREQ=DAILY;UNTIL=20260710');
    expect(lines(render({ time: '09:00', rrule: rule }))).toContain(
      'RRULE:FREQ=DAILY;UNTIL=20260710T235959',
    );
    // 23:59:59 on 10 July in London is 22:59:59 UTC.
    expect(lines(render({ time: '09:00', timeZone: 'Europe/London', rrule: rule }))).toContain(
      'RRULE:FREQ=DAILY;UNTIL=20260710T225959Z',
    );
  });

  it('drops rules it cannot express and anything that is not a parsable rule', () => {
    expect(
      lines(render({ rrule: 'FREQ=HOURLY;INTERVAL=2' })).some((x) => x.startsWith('RRULE')),
    ).toBe(false);
    expect(lines(render({ time: '09:00', rrule: 'FREQ=HOURLY;INTERVAL=2' }))).toContain(
      'RRULE:FREQ=HOURLY;INTERVAL=2',
    );
    expect(
      lines(render({ rrule: 'FREQ=DAILY\r\nATTENDEE:mailto:x@example.com' })).some(
        (x) => x.startsWith('RRULE') || x.startsWith('ATTENDEE'),
      ),
    ).toBe(false);
  });

  it('shows descriptions only when asked, always with the project and link', () => {
    const t = {
      description: 'Secret details',
      projectName: 'Home',
      url: 'https://todo.example/task/1',
    };
    const hidden = lines(render(t, false)).join('\n');
    expect(hidden).not.toContain('Secret details');
    expect(hidden).toContain('DESCRIPTION:Project: Home');
    expect(hidden).toContain('URL:https://todo.example/task/1');
    expect(lines(render(t, true)).join('\n')).toContain('Secret details');
  });

  it('maps priority and labels, and omits both when unset', () => {
    const l = lines(render({ priority: 1, labels: ['home', 'a,b'] }));
    expect(l).toContain('PRIORITY:1');
    expect(l).toContain('CATEGORIES:home,a\\,b');
    expect(lines(render({ priority: 2 }))).toContain('PRIORITY:3');
    expect(lines(render({ priority: 3 }))).toContain('PRIORITY:5');
    expect(lines(render({ priority: 4 })).some((x) => x.startsWith('PRIORITY'))).toBe(false);
  });

  it('writes an empty but valid calendar', () => {
    const text = renderCalendar({ name: 'Empty', tasks: [], includeDescriptions: false });
    expect(lines(text)).not.toContain('BEGIN:VEVENT');
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
