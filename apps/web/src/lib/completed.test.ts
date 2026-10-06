import { describe, expect, it } from 'vitest';
import { completedTasksPath } from './completed.js';

describe('completedTasksPath', () => {
  it('asks for every visible project when no project is given', () => {
    expect(completedTasksPath()).toBe('/api/v1/tasks/completed');
    expect(completedTasksPath(undefined, null)).toBe('/api/v1/tasks/completed');
  });

  it('scopes the history to one project', () => {
    expect(completedTasksPath('p1')).toBe('/api/v1/tasks/completed?projectId=p1');
  });

  it('carries the paging cursor, percent-encoded', () => {
    expect(completedTasksPath(undefined, '2026-10-06T10:00:00.000Z')).toBe(
      '/api/v1/tasks/completed?before=2026-10-06T10%3A00%3A00.000Z',
    );
    expect(completedTasksPath('p 1', 'a&b')).toBe(
      '/api/v1/tasks/completed?projectId=p+1&before=a%26b',
    );
  });
});
