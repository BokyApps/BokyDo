import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from './csv.js';
import {
  countTemplate,
  HEADER,
  MAX_TEMPLATE_ROWS,
  parseTemplateCsv,
  serializeTemplateCsv,
  type Template,
} from './template.js';

const todoistSample = [
  'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG',
  'meta,view_style=board,,,,,,,,,,,,',
  'task,Pack bags,"Don\'t forget the charger",1,1,Me (1),Me (1),tomorrow at 9am,en,Europe/London,30,minute,2030-02-01,en',
  'note,"Check the weather first",,,,Me (1),,,,,,,,',
  'task,Passport,,,2,,,,,,,,,',
  'task,Tickets,,2,2,,,,,,,,,',
  'task,Deep nesting,,,4,,,,,,,,,',
  '',
  'section,Before leaving,,,,,,,,,,,,',
  'task,Water plants,,4,1,,,every friday,en,,,,,',
  'task,Water plants again,,4,1,,,every other day,en,,,,,',
].join('\r\n');

describe('parseTemplateCsv', () => {
  it('reads a Todoist-style file: sections, nesting, dates, durations, comments', () => {
    const { template, warnings } = parseTemplateCsv(todoistSample, 'Trip');
    expect(template.name).toBe('Trip');
    expect(template.tasks.map((t) => [t.content, t.depth])).toEqual([
      ['Pack bags', 0],
      ['Passport', 1],
      ['Tickets', 1],
      ['Deep nesting', 2], // asked for indent 4 right after indent 2: one level deeper only
    ]);
    const pack = template.tasks[0];
    expect(pack).toMatchObject({
      description: "Don't forget the charger",
      priority: 1,
      date: 'tomorrow at 9am',
      timezone: 'Europe/London',
      durationMinutes: 30,
      deadline: '2030-02-01',
      comments: ['Check the weather first'],
    });
    expect(template.tasks[1]?.priority).toBe(4);
    expect(template.sections.map((s) => [s.name, s.tasks.length])).toEqual([['Before leaving', 2]]);
    expect(template.sections[0]?.tasks[0]?.date).toBe('every friday');
    expect(warnings.map((w) => w.message)).toEqual([
      'A task was indented too far; it was moved up a level.',
    ]);
    expect(countTemplate(template)).toEqual({ sections: 1, tasks: 6, comments: 1 });
  });

  it('finds columns by name, in any order, and copes with missing ones', () => {
    const { template } = parseTemplateCsv('priority,content,type\n1,Buy milk,task\n', 'x');
    expect(template.tasks).toHaveLength(1);
    expect(template.tasks[0]).toMatchObject({
      content: 'Buy milk',
      priority: 1,
      depth: 0,
      date: null,
    });
  });

  it('refuses a file with no CONTENT column', () => {
    expect(() => parseTemplateCsv('a,b\n1,2', 'x')).toThrow(/CONTENT/);
  });

  it('passes parser errors through for unusable files', () => {
    expect(() => parseTemplateCsv('', 'x')).toThrow(CsvError);
    expect(() => parseTemplateCsv('PK\u0003\u0004zip', 'x')).toThrow(CsvError);
    expect(() => parseTemplateCsv('TYPE,CONTENT\n"open,x', 'x')).toThrow(CsvError);
  });

  it('skips what it cannot use, with a warning that names the line', () => {
    const csv = [
      'TYPE,CONTENT,PRIORITY,DURATION,DURATION_UNIT',
      'task,,1,,',
      'section,,,,',
      'note,orphan comment,,,',
      'widget,whatever,,,',
      'task,Odd priority,9,,',
      'task,Odd duration,,abc,minute',
      'task,Too long,,5000,minute',
    ].join('\n');
    const { template, warnings } = parseTemplateCsv(csv, 'x');
    expect(template.tasks.map((t) => [t.content, t.priority, t.durationMinutes])).toEqual([
      ['Odd priority', 4, null],
      ['Odd duration', 4, null],
      ['Too long', 4, null],
    ]);
    expect(warnings.map((w) => w.row)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps titles on one line, shortens oversize text, and reads durations in days', () => {
    const long = 'x'.repeat(1200);
    const csv = `TYPE,CONTENT,DESCRIPTION,DURATION,DURATION_UNIT\ntask,"two\nlines here",${long},1,day\ntask,${long},,,`;
    const { template, warnings } = parseTemplateCsv(csv, 'x');
    expect(template.tasks[0]).toMatchObject({ content: 'two lines here', durationMinutes: 1440 });
    expect(template.tasks[0]?.description).toHaveLength(1200);
    expect(template.tasks[1]?.content).toHaveLength(1000);
    expect(warnings.map((w) => w.message)).toEqual([
      'A long title was shortened to 1000 characters.',
    ]);
  });

  it('replaces control characters so every value is accepted by the command schemas', () => {
    const csv =
      'TYPE,CONTENT,DESCRIPTION\ntask,"a\u0007b\tc\u001bd","x\u0002y\tz\nw\u007fv"\nsection,"s\u0001"';
    const { template } = parseTemplateCsv(csv, 'x');
    expect(template.tasks[0]).toMatchObject({ content: 'a b c d', description: 'x y\tz\nw v' });
    expect(template.sections[0]?.name).toBe('s');
  });

  it('keeps formula-looking text as plain text and undoes its own guarding', () => {
    const csv = "TYPE,CONTENT,DESCRIPTION\ntask,=1+1,@mention\ntask,'=guarded,'-5\ntask,it's fine,";
    const { template } = parseTemplateCsv(csv, 'x');
    expect(template.tasks.map((t) => [t.content, t.description])).toEqual([
      ['=1+1', '@mention'],
      ['=guarded', '-5'],
      ["it's fine", ''],
    ]);
  });

  it('limits warnings, and rows', () => {
    const many = 'TYPE,CONTENT\n' + Array.from({ length: 80 }, () => 'bogus,x').join('\n');
    const { warnings } = parseTemplateCsv(many, 'x');
    expect(warnings).toHaveLength(51);
    expect(warnings.at(-1)).toEqual({ row: null, message: '…and 30 more notes.' });
    const huge =
      'TYPE,CONTENT\n' + Array.from({ length: MAX_TEMPLATE_ROWS + 5 }, () => 'task,x').join('\n');
    expect(() => parseTemplateCsv(huge, 'x')).toThrow(CsvError);
  });
});

describe('serializeTemplateCsv', () => {
  const template: Template = {
    name: 'Round trip',
    tasks: [
      {
        content: '=HYPERLINK("http://evil.example","click")',
        description: 'Line one\nLine two, with a comma',
        priority: 1,
        depth: 0,
        date: 'every monday at 9am',
        timezone: 'Europe/Berlin',
        durationMinutes: 45,
        deadline: '2030-05-01',
        comments: ['+1 first note', 'second, note'],
      },
      {
        content: 'Sub',
        description: '',
        priority: 4,
        depth: 1,
        date: null,
        timezone: null,
        durationMinutes: null,
        deadline: null,
        comments: [],
      },
    ],
    sections: [
      {
        name: '@Section',
        tasks: [
          {
            content: 'In section',
            description: '',
            priority: 2,
            depth: 0,
            date: '2030-03-01 09:30',
            timezone: null,
            durationMinutes: null,
            deadline: null,
            comments: [],
          },
        ],
      },
    ],
  };

  it('writes the Todoist columns and guards every cell', () => {
    const text = serializeTemplateCsv(template);
    const rows = parseCsv(text);
    expect(rows[0]).toEqual([...HEADER]);
    for (const cell of rows.flat()) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    expect(rows.map((r) => r[0])).toEqual([
      'TYPE',
      'task',
      'note',
      'note',
      'task',
      'section',
      'task',
    ]);
  });

  it('round-trips through the parser', () => {
    const { template: back, warnings } = parseTemplateCsv(
      serializeTemplateCsv(template),
      'Round trip',
    );
    expect(warnings).toEqual([]);
    expect(back).toEqual(template);
  });
});
