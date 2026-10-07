import { CsvError } from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import {
  describeTemplateError,
  readTemplateFile,
  safeFilename,
  TemplateFileError,
  templateNameFromFile,
} from './files.js';

describe('safeFilename', () => {
  it('keeps ordinary names and adds the extension', () => {
    expect(safeFilename('Garden')).toBe('Garden.csv');
    expect(safeFilename('Q3 plan: launch?')).toBe('Q3 plan- launch-.csv');
    expect(safeFilename('日本語のプロジェクト')).toBe('日本語のプロジェクト.csv');
  });

  it('cannot escape a folder or hide the file', () => {
    expect(safeFilename('../../etc/passwd')).toBe('etc-passwd.csv');
    expect(safeFilename('..\\x')).not.toMatch(/[\\/]/);
    expect(safeFilename('.hidden')).toBe('hidden.csv');
    expect(safeFilename('a\u0000b\nc')).toBe('a-b-c.csv');
  });

  it('is never empty or long', () => {
    expect(safeFilename('')).toBe('project.csv');
    expect(safeFilename('   ')).toBe('project.csv');
    expect(safeFilename('///')).toBe('project.csv');
    expect(safeFilename('x'.repeat(500)).length).toBe(60 + '.csv'.length);
  });
});

describe('templateNameFromFile', () => {
  it('suggests a readable name', () => {
    expect(templateNameFromFile('Trip_packing_list.csv')).toBe('Trip packing list');
    expect(templateNameFromFile('Garden')).toBe('Garden');
    expect(templateNameFromFile('.csv')).toBe('Imported project');
    expect(templateNameFromFile('x'.repeat(300) + '.csv')).toHaveLength(120);
  });
});

describe('reading a file', () => {
  const file = (text: string, name = 'x.csv') => new File([text], name, { type: 'text/csv' });

  it('reads a template and names it after the file', async () => {
    const { template } = await readTemplateFile(file('TYPE,CONTENT\ntask,Hello', 'My_list.csv'));
    expect(template.name).toBe('My list');
    expect(template.tasks.map((t) => t.content)).toEqual(['Hello']);
  });

  it('explains why a file cannot be used', async () => {
    const messages = await Promise.all(
      [file(''), file('a,b\n1,2'), file('TYPE,CONTENT\n"open'), file('PK\u0003\u0004zip')].map(
        (f) =>
          readTemplateFile(f).catch((e: unknown) =>
            e instanceof TemplateFileError ? e.message : 'unexpected',
          ),
      ),
    );
    expect(messages).toEqual([
      'That file is empty.',
      'That does not look like a Todoist-style CSV: it has no CONTENT column.',
      'That file is damaged: a quoted value is never closed.',
      'That is not a CSV text file. Export a project as CSV from Todoist and choose that file.',
    ]);
  });

  it('refuses an oversize file without reading it', async () => {
    const big = new File([new Uint8Array(1024 * 1024 + 1)], 'big.csv');
    await expect(readTemplateFile(big)).rejects.toThrow(/larger|too large/);
    expect(describeTemplateError(new CsvError('too_many_rows', ''))).toMatch(/1,000 rows/);
  });
});
