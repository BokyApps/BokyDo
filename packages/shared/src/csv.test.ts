import { describe, expect, it } from 'vitest';
import { CsvError, guardFormula, parseCsv, unguardFormula, writeCsv } from './csv.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof CsvError ? err.code : `other: ${String(err)}`;
  }
  return 'no error';
};

describe('parseCsv', () => {
  it('reads plain rows with any line ending, and a byte-order mark', () => {
    expect(parseCsv('a,b\r\nc,d\ne,f\rg,h\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
    expect(parseCsv('﻿a,b')).toEqual([['a', 'b']]);
  });

  it('reads quoted cells with commas, doubled quotes and line breaks', () => {
    expect(parseCsv('"a,b","say ""hi""","line1\r\nline2",plain')).toEqual([
      ['a,b', 'say "hi"', 'line1\r\nline2', 'plain'],
    ]);
  });

  it('keeps empty cells and blank lines, and a stray quote inside a plain cell', () => {
    expect(parseCsv('a,,c\n\nx"y,z')).toEqual([['a', '', 'c'], [''], ['x"y', 'z']]);
  });

  it('detects a semicolon delimiter from the first line only', () => {
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseCsv('a,b\n1;2')).toEqual([['a', 'b'], ['1;2']]);
    expect(parseCsv('"a;b",c\n1,2')).toEqual([
      ['a;b', 'c'],
      ['1', '2'],
    ]);
  });

  it('refuses files that are empty, binary or not closed', () => {
    expect(code(() => parseCsv(''))).toBe('empty');
    expect(code(() => parseCsv('  \n \n'))).toBe('empty');
    expect(code(() => parseCsv('PK\u0003\u0004\u0014\u0000rest'))).toBe('binary');
    expect(code(() => parseCsv('a,b\0c'))).toBe('binary');
    expect(code(() => parseCsv('a,"never closed\nb,c'))).toBe('unterminated_quote');
  });

  it('enforces its limits instead of consuming memory', () => {
    const limits = { maxChars: 100, maxRows: 3, maxColumns: 4, maxCellChars: 10 };
    expect(code(() => parseCsv('x'.repeat(101), limits))).toBe('too_large');
    expect(code(() => parseCsv('a\nb\nc\nd', limits))).toBe('too_many_rows');
    expect(code(() => parseCsv('a,b,c,d,e', limits))).toBe('too_many_columns');
    expect(code(() => parseCsv('x'.repeat(11), limits))).toBe('cell_too_long');
    expect(code(() => parseCsv(`"${'x'.repeat(11)}"`, limits))).toBe('cell_too_long');
    expect(() => parseCsv('a\nb\nc', limits)).not.toThrow();
  });

  it('parses a large file quickly', () => {
    const row = 'task,"A title, with a comma",,4,1,,,tomorrow,en,,,,,,,';
    const start = Date.now();
    const rows = parseCsv(Array.from({ length: 2000 }, () => row).join('\n'));
    expect(rows).toHaveLength(2000);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('formula guard', () => {
  it('prefixes anything a spreadsheet could run, and only that', () => {
    for (const v of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx', '=HYPERLINK("http://x")'])
      expect(guardFormula(v)).toBe(`'${v}`);
    for (const v of ['', 'plain', "it's", ' =padded', '1+1', 'a=b'])
      expect(guardFormula(v)).toBe(v);
  });

  it('is reversed only where it applies', () => {
    for (const v of ['=1+1', '+1', '-1', '@x', '\tx'])
      expect(unguardFormula(guardFormula(v))).toBe(v);
    expect(unguardFormula("'quoted")).toBe("'quoted");
    expect(unguardFormula("'")).toBe("'");
  });
});

describe('writeCsv', () => {
  it('quotes where needed and ends lines with CRLF', () => {
    expect(writeCsv([['a', 'b,c', 'd"e', 'f\ng'], ['h']])).toBe('a,"b,c","d""e","f\ng"\r\nh\r\n');
  });

  it('guards every cell, so no cell starts a formula', () => {
    const text = writeCsv([['=cmd|calc', '+1', '-2', '@x', 'ok']]);
    expect(text).toBe("'=cmd|calc,'+1,'-2,'@x,ok\r\n");
    for (const cell of parseCsv(text)[0] ?? []) expect(cell).not.toMatch(/^[=+\-@]/);
  });

  it('round-trips awkward values (after un-guarding)', () => {
    const rows = [
      ['=1+1', 'comma, here', 'quote " here', 'two\nlines', '', "it's", '  spaced  '],
      ['日本語', '😀', '-5', '@mention', 'tab\there'],
    ];
    const back = parseCsv(writeCsv(rows)).map((r) => r.map(unguardFormula));
    expect(back).toEqual(rows);
  });
});
