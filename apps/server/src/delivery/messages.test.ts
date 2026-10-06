import { describe, expect, it } from 'vitest';
import { inQuietHours } from './delivery.js';
import { clean, contentOf } from './messages.js';

describe('notification text', () => {
  it('flattens control characters so nothing reaches headers as a new line', () => {
    expect(clean('Ship\r\nBcc: evil@example.com')).toBe('Ship Bcc: evil@example.com');
    expect(clean('a\u0000b\u007fc')).toBe('a b c');
    expect(clean('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(clean(undefined)).toBe('');
  });

  it('describes each notification type with a same-origin link', () => {
    const c = contentOf(
      {
        type: 'mentioned',
        data: { title: 'Plan', excerpt: 'hey @bob' },
        taskId: 't1',
        projectId: 'p1',
      },
      'alice',
    );
    expect(c).toEqual({
      title: 'alice mentioned you on “Plan”',
      detail: 'hey @bob',
      path: '/task/t1',
    });
    expect(
      contentOf({ type: 'invited', data: { name: 'Acme' }, taskId: null, projectId: null }, null)
        .title,
    ).toBe('Someone invited you to “Acme”');
    expect(
      contentOf(
        {
          type: 'security',
          data: { message: 'Your password was changed' },
          taskId: null,
          projectId: null,
        },
        null,
      ),
    ).toMatchObject({ path: '/account/security' });
  });
});

describe('quiet hours', () => {
  const q = (start: string, end: string) => ({ enabled: true, start, end });
  it.each([
    [q('22:00', '07:00'), '23:30', true],
    [q('22:00', '07:00'), '06:59', true],
    [q('22:00', '07:00'), '07:00', false],
    [q('22:00', '07:00'), '12:00', false],
    [q('09:00', '17:00'), '12:00', true],
    [q('09:00', '17:00'), '17:00', false],
    [q('09:00', '09:00'), '09:00', false],
    [{ enabled: false, start: '00:00', end: '23:59' }, '12:00', false],
  ])('%o at %s → %s', (quiet, time, expected) => {
    expect(inQuietHours(quiet, time)).toBe(expected);
  });
});
