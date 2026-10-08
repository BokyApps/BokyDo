import { reportRequestSchema } from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import { countsText, generatedText, reportBody, reportTitle } from './report.js';

const PROJECT = '6f1f8a2e-6a4b-4c3d-8e2f-1a2b3c4d5e6f';
const counts = { overdue: 2, today: 3, upcoming: 5, completed: 8 };

describe('reportBody', () => {
  it('sends only the kind for day and week', () => {
    expect(reportBody({ kind: 'day' })).toStrictEqual({ kind: 'day' });
    expect(reportBody({ kind: 'week' })).toStrictEqual({ kind: 'week' });
  });

  it('sends the project with a project report', () => {
    expect(reportBody({ kind: 'project', projectId: PROJECT })).toStrictEqual({
      kind: 'project',
      projectId: PROJECT,
    });
  });

  it('builds bodies the server schema accepts', () => {
    for (const target of [
      { kind: 'day' as const },
      { kind: 'week' as const },
      { kind: 'project' as const, projectId: PROJECT },
    ]) {
      expect(reportRequestSchema.safeParse(reportBody(target)).success).toBe(true);
    }
  });
});

describe('reportTitle', () => {
  it('names each kind', () => {
    expect(reportTitle('day')).toBe('Plan for today');
    expect(reportTitle('week')).toBe('Your week');
    expect(reportTitle('project')).toBe('Project status');
  });
});

describe('countsText', () => {
  it('gives all four counts for a week', () => {
    expect(countsText('week', counts)).toBe(
      'Based on 2 overdue, 3 today, 5 in the next 7 days, 8 done in the last 7 days',
    );
  });

  it('gives all four counts for a project', () => {
    expect(countsText('project', counts)).toBe(
      'Based on 2 overdue, 3 today, 5 in the next 7 days, 8 done in the last 7 days',
    );
  });

  it('gives only overdue and today for a day', () => {
    expect(countsText('day', counts)).toBe('Based on 2 overdue, 3 today');
  });

  it('shows zeros rather than leaving them out', () => {
    const none = { overdue: 0, today: 0, upcoming: 0, completed: 0 };
    expect(countsText('week', none)).toBe(
      'Based on 0 overdue, 0 today, 0 in the next 7 days, 0 done in the last 7 days',
    );
  });
});

describe('generatedText', () => {
  it('gives the time the report was made', () => {
    expect(generatedText('2026-10-08T09:41:00Z', 'en-US')).toMatch(
      /^Generated \d{1,2}:\d{2}\s[AP]M$/,
    );
  });

  it('gives nothing for a time that is not a date', () => {
    expect(generatedText('not a date')).toBe('');
  });
});
