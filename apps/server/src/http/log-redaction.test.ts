import { describe, expect, it } from 'vitest';
import { redactUrl } from './log-redaction.js';

describe('log redaction', () => {
  it('removes the secret from feed paths and leaves other URLs alone', () => {
    expect(redactUrl('/api/v1/calendar/abc.ics')).toBe('/api/v1/calendar/[redacted]');
    expect(redactUrl('/api/v1/calendar/abc.ics?x=1')).toBe('/api/v1/calendar/[redacted]?x=1');
    expect(redactUrl('/api/v1/calendar-feeds')).toBe('/api/v1/calendar-feeds');
    expect(redactUrl('/api/v1/tasks/completed?limit=3')).toBe('/api/v1/tasks/completed?limit=3');
  });
});
