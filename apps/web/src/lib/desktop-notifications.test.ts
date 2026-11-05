import { DEFAULT_PREFERENCES, type AppNotification } from '@bokydo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimDesktopNotification,
  desktopConsentChanged,
  displayDesktopNotification,
  desktopNotificationsOptedIn,
  latestNotificationTimestamp,
  newNotificationIds,
  setDesktopNotificationsOptIn,
  shouldShowDesktopNotification,
} from './desktop-notifications.js';

const notification = (overrides: Partial<AppNotification> = {}): AppNotification => ({
  id: 'notification-1',
  type: 'assigned',
  actorId: 'actor-1',
  projectId: 'project-1',
  taskId: 'task-1',
  commentId: null,
  data: { title: 'A task' },
  createdAt: new Date().toISOString(),
  read: false,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local desktop notifications', () => {
  it('uses account-scoped device consent and seen IDs', async () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
      clear: () => data.clear(),
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    localStorage.clear();
    setDesktopNotificationsOptIn('alice', true);
    expect(desktopNotificationsOptedIn('alice')).toBe(true);
    expect(desktopNotificationsOptedIn('bob')).toBe(false);
    expect(await claimDesktopNotification('alice', 'same-id')).toBe(true);
    expect(await claimDesktopNotification('alice', 'same-id')).toBe(false);
    expect(await claimDesktopNotification('bob', 'same-id')).toBe(true);
    setDesktopNotificationsOptIn('alice', false);
    expect(desktopNotificationsOptedIn('alice')).toBe(false);
  });

  it('only treats IDs absent from the initial account snapshot as new', () => {
    const initial = new Set(['old-1', 'old-2']);
    expect(
      newNotificationIds(initial, [notification({ id: 'old-1' }), notification({ id: 'new-1' })]),
    ).toMatchObject([{ id: 'new-1' }]);
    expect(
      newNotificationIds(
        new Set(),
        [notification({ createdAt: '2020-01-01T00:00:00Z' })],
        Date.now(),
      ),
    ).toEqual([]);
  });

  it('uses server timestamps as the baseline cutoff and accepts same-millisecond new IDs', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2040-01-01T00:00:00Z'));
    const initial = notification({
      id: 'baseline',
      createdAt: '2026-11-05T12:00:00.123Z',
    });
    const sameMillisecond = notification({
      id: 'new-at-same-time',
      createdAt: '2026-11-05T12:00:00.123Z',
    });
    const cutoff = latestNotificationTimestamp([initial]);
    expect(cutoff).toBe(Date.parse(initial.createdAt));
    expect(newNotificationIds(new Set([initial.id]), [sameMillisecond], cutoff)).toEqual([
      sameMillisecond,
    ]);
    expect(latestNotificationTimestamp([])).toBe(0);
  });

  it('honors per-event push choices and quiet hours, with reminder and security exceptions', () => {
    const prefs = structuredClone(DEFAULT_PREFERENCES.notifications);
    prefs.quietHours = { enabled: true, start: '22:00', end: '07:00' };
    const at23 = new Date('2026-11-05T23:00:00Z');
    expect(shouldShowDesktopNotification(notification(), prefs, at23, 'UTC')).toBe(false);
    prefs.channels.assigned.push = false;
    expect(
      shouldShowDesktopNotification(notification(), prefs, new Date('2026-11-05T12:00:00Z')),
    ).toBe(false);
    expect(
      shouldShowDesktopNotification(notification({ type: 'reminder' }), prefs, at23, 'UTC'),
    ).toBe(true);
    expect(
      shouldShowDesktopNotification(notification({ type: 'security' }), prefs, at23, 'UTC'),
    ).toBe(true);
  });

  it('does not show read notifications', () => {
    expect(
      shouldShowDesktopNotification(
        notification({ read: true }),
        DEFAULT_PREFERENCES.notifications,
      ),
    ).toBe(false);
  });

  it('uses the existing service worker for persistent local notices without touching PushManager', async () => {
    const showNotification = vi.fn(async () => undefined);
    const registration = {
      showNotification,
      get pushManager() {
        throw new Error('local notifications must not access PushManager');
      },
    };
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn(async () => registration) },
    });
    vi.stubGlobal('window', {
      location: { origin: 'https://bokydo.example', assign: vi.fn() },
      focus: vi.fn(),
    });
    vi.stubGlobal('Notification', vi.fn());
    await displayDesktopNotification(notification(), 'A task was assigned');
    expect(showNotification).toHaveBeenCalledWith(
      'BokyDo',
      expect.objectContaining({ tag: 'task-1', renotify: false, data: { url: '/task/task-1' } }),
    );
    expect(Notification).not.toHaveBeenCalled();
  });

  it('cancels a delayed display when consent is withdrawn before the worker resolves', async () => {
    const showNotification = vi.fn(async () => undefined);
    let releaseRegistration!: (registration: { showNotification: typeof showNotification }) => void;
    const registrationPromise = new Promise<{ showNotification: typeof showNotification }>(
      (resolve) => {
        releaseRegistration = resolve;
      },
    );
    let canDisplay = true;
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn(() => registrationPromise) },
    });
    vi.stubGlobal('Notification', vi.fn());
    const pending = displayDesktopNotification(
      notification(),
      'A task was assigned',
      () => canDisplay,
    );
    canDisplay = false;
    releaseRegistration({ showNotification });
    await pending;
    expect(showNotification).not.toHaveBeenCalled();
    expect(Notification).not.toHaveBeenCalled();
  });
});

it('only cancels pending delivery for this account consent changes or a storage clear', () => {
  expect(desktopConsentChanged('bokydo:desktop-notifications:alice', 'alice')).toBe(true);
  expect(desktopConsentChanged(null, 'alice')).toBe(true);
  expect(desktopConsentChanged('bokydo:desktop-notifications-seen:alice', 'alice')).toBe(false);
  expect(desktopConsentChanged('bokydo:desktop-notifications:bob', 'alice')).toBe(false);
  expect(desktopConsentChanged('bokydo.offline.user', 'alice')).toBe(false);
});
