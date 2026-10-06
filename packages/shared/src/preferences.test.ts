import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  mergeNotifications,
  preferencesPatchSchema,
  resolvePreferences,
} from './preferences.js';

describe('notification preferences', () => {
  it('fills in defaults for rows stored before notifications existed', () => {
    const old = { ...DEFAULT_PREFERENCES, notifications: undefined, timezone: 'Asia/Phnom_Penh' };
    const p = resolvePreferences(old);
    expect(p.timezone).toBe('Asia/Phnom_Penh');
    expect(p.notifications).toEqual(DEFAULT_PREFERENCES.notifications);
  });

  it('keeps valid fields when one stored field is invalid', () => {
    const p = resolvePreferences({ timezone: 'Asia/Phnom_Penh', weekStart: 'friday' });
    expect(p.timezone).toBe('Asia/Phnom_Penh');
    expect(p.weekStart).toBe('monday');
  });

  it('merges partial patches deeply', () => {
    const n = mergeNotifications(DEFAULT_PREFERENCES.notifications, {
      autoReminder: null,
      channels: { commented: { email: true } },
      quietHours: { enabled: true },
    });
    expect(n.autoReminder).toBeNull();
    expect(n.channels.commented).toEqual({ email: true, push: true });
    expect(n.channels.assigned).toEqual(DEFAULT_PREFERENCES.notifications.channels.assigned);
    expect(n.quietHours).toEqual({ enabled: true, start: '22:00', end: '07:00' });
  });

  it('never turns security emails off', () => {
    const n = mergeNotifications(DEFAULT_PREFERENCES.notifications, {
      channels: { security: { email: false, push: false } },
    });
    expect(n.channels.security).toEqual({ email: true, push: false });
  });

  it('rejects unknown events, bad times and out-of-range reminders', () => {
    const bad = [
      { notifications: { channels: { spam: { email: true } } } },
      { notifications: { quietHours: { start: '25:00' } } },
      { notifications: { autoReminder: -5 } },
      { notifications: { autoReminder: 99_999 } },
      { notifications: { digest: { time: '7am' } } },
    ];
    for (const patch of bad) expect(preferencesPatchSchema.safeParse(patch).success).toBe(false);
    expect(
      preferencesPatchSchema.safeParse({
        notifications: { channels: { reminder: { push: false } } },
      }).success,
    ).toBe(true);
  });
});
