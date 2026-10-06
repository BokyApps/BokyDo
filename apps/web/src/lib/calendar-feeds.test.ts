import { describe, expect, it } from 'vitest';
import { feedHref } from './calendar-feeds.js';

describe('feedHref', () => {
  const path = '/api/v1/calendar/abc.ics';

  it('resolves a path against the current origin', () => {
    expect(feedHref(path, 'https://todo.example.com')).toBe(
      'https://todo.example.com/api/v1/calendar/abc.ics',
    );
    expect(feedHref(path, 'http://localhost:8080')).toBe(
      'http://localhost:8080/api/v1/calendar/abc.ics',
    );
  });

  it('keeps a link that is already absolute', () => {
    expect(feedHref('https://todo.example.com/api/v1/calendar/abc.ics', 'http://other')).toBe(
      'https://todo.example.com/api/v1/calendar/abc.ics',
    );
  });
});
