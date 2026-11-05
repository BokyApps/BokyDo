import {
  NOTIFICATION_EVENTS,
  type AppNotification,
  type NotificationEvent,
  type NotificationPrefs,
} from '@bokydo/shared';
import { useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useStore, useSyncReady, useSyncState } from './sync.js';

export const OPT_IN_EVENT = 'bokydo:desktop-notifications-opt-in';
const keyFor = (userId: string) => `bokydo:desktop-notifications:${userId}`;
export const desktopConsentChanged = (key: string | null, userId: string | null) =>
  key === null || (userId !== null && key === keyFor(userId));
const seenKeyFor = (userId: string) => `bokydo:desktop-notifications-seen:${userId}`;

export function desktopNotificationsOptedIn(userId: string): boolean {
  try {
    return localStorage.getItem(keyFor(userId)) === 'on';
  } catch {
    return false;
  }
}

export function setDesktopNotificationsOptIn(userId: string, enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(keyFor(userId), 'on');
    else localStorage.removeItem(keyFor(userId));
  } catch {
    // A blocked local store means this device cannot remember consent safely.
  }
  window.dispatchEvent(new Event(OPT_IN_EVENT));
}

function eventFor(type: AppNotification['type']): NotificationEvent | null {
  if (type === 'role_changed' || type === 'removed_from_project' || type === 'became_owner')
    return 'sharing';
  return NOTIFICATION_EVENTS.includes(type as NotificationEvent)
    ? (type as NotificationEvent)
    : null;
}

function quietNow(prefs: NotificationPrefs, now: Date, timeZone: string): boolean {
  if (!prefs.quietHours.enabled) return false;
  let hour: number;
  let minute: number;
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    hour = Number(parts.find((part) => part.type === 'hour')?.value);
    minute = Number(parts.find((part) => part.type === 'minute')?.value);
  } catch {
    hour = now.getHours();
    minute = now.getMinutes();
  }
  const current = hour * 60 + minute;
  const start = clockMinutes(prefs.quietHours.start);
  const end = clockMinutes(prefs.quietHours.end);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

const clockMinutes = (value: string) => {
  const [hour = 0, minute = 0] = value.split(':').map(Number);
  return hour * 60 + minute;
};

export function shouldShowDesktopNotification(
  notification: AppNotification,
  prefs: NotificationPrefs,
  now = new Date(),
  timeZone = 'UTC',
): boolean {
  const event = eventFor(notification.type);
  if (!event || !prefs.channels[event].push) return false;
  if (event !== 'reminder' && event !== 'security' && quietNow(prefs, now, timeZone)) return false;
  return !notification.read;
}

function bodyFor(n: AppNotification, t: TFunction) {
  const data = n.data;
  const title = typeof data.title === 'string' ? data.title : t('notifications.aTask');
  const actor = typeof data.actorName === 'string' ? data.actorName : t('notifications.someone');
  const projectName =
    typeof data.workspaceName === 'string'
      ? data.workspaceName
      : typeof data.projectName === 'string'
        ? data.projectName
        : t('notifications.aProject');
  switch (n.type) {
    case 'reminder':
      return t('notifications.reminder', {
        title: t('notifications.quoted', { name: title }),
        late: data.late ? ` ${t('notifications.sentLate')}` : '',
      });
    case 'security':
      return typeof data.message === 'string' ? data.message : t('notifications.security');
    case 'invited':
      return t('notifications.invited', {
        actor,
        project: t('notifications.quoted', { name: projectName }),
      });
    case 'completed':
      return t('notifications.completed', {
        actor,
        title: t('notifications.quoted', { name: title }),
      });
    case 'assigned':
      return t('notifications.assigned', {
        actor,
        title: t('notifications.quoted', { name: title }),
      });
    case 'mentioned':
      return t('notifications.mentioned', {
        actor,
        where: data.title
          ? t('notifications.onTask', { title: t('notifications.quoted', { name: title }) })
          : t('notifications.inProject', {
              project: t('notifications.quoted', { name: projectName }),
            }),
      });
    case 'commented':
      return t('notifications.commented', {
        actor,
        title: t('notifications.quoted', { name: title }),
      });
    case 'role_changed':
      return t('notifications.roleChanged', {
        actor,
        role: String(data.role ?? ''),
        project: t('notifications.quoted', { name: projectName }),
      });
    case 'removed_from_project':
      return t('notifications.removed', {
        actor,
        project: t('notifications.quoted', { name: projectName }),
      });
    case 'became_owner':
      return t('notifications.becameOwner', {
        actor,
        project: t('notifications.quoted', { name: projectName }),
      });
  }
}

function safeTarget(n: AppNotification): string {
  if (n.type === 'invited') return '/invitations';
  if (n.type === 'security') return '/account/security';
  if (n.type === 'removed_from_project') return '/';
  if (n.taskId) return `/task/${encodeURIComponent(n.taskId)}`;
  if (n.projectId) return `/project/${encodeURIComponent(n.projectId)}`;
  return '/';
}

function claimNotificationOnce(userId: string, notificationId: string): boolean {
  try {
    const key = seenKeyFor(userId);
    const seen = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    const ids = Array.isArray(seen)
      ? seen.filter((id): id is string => typeof id === 'string')
      : [];
    if (ids.includes(notificationId)) return false;
    localStorage.setItem(key, JSON.stringify([...ids.slice(-199), notificationId]));
  } catch {
    // The browser notification's stable tag still coalesces simultaneous fallback displays.
  }
  return true;
}

export async function claimDesktopNotification(
  userId: string,
  notificationId: string,
): Promise<boolean> {
  if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks) {
    return navigator.locks.request(`bokydo-notification:${userId}:${notificationId}`, () =>
      claimNotificationOnce(userId, notificationId),
    );
  }
  return claimNotificationOnce(userId, notificationId);
}

export function newNotificationIds(
  previous: ReadonlySet<string>,
  current: readonly AppNotification[],
  after = 0,
) {
  return current.filter(
    (notification) =>
      !previous.has(notification.id) && new Date(notification.createdAt).getTime() >= after,
  );
}

export function latestNotificationTimestamp(notifications: readonly AppNotification[]): number {
  return notifications.reduce((latest, notification) => {
    const timestamp = new Date(notification.createdAt).getTime();
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
}

export async function displayDesktopNotification(
  n: AppNotification,
  body: string,
  canDisplay: () => boolean = () => true,
): Promise<void> {
  if (!canDisplay()) return;
  const options: NotificationOptions & { renotify: false } = {
    body,
    // Existing Web Push uses the task ID as its tag; matching it coalesces same-task delivery.
    tag: n.taskId || n.id,
    icon: '/favicon.svg',
    data: { url: safeTarget(n) },
    renotify: false,
  };
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      if (registration?.showNotification) {
        if (!canDisplay()) return;
        await registration.showNotification('BokyDo', options);
        return;
      }
    } catch {
      // Some browsers have a worker but cannot show persistent notifications; use the page API.
    }
  }
  if (!canDisplay()) return;
  const notification = new Notification('BokyDo', options);
  notification.onclick = () => {
    const url =
      typeof notification.data?.url === 'string' && /^\/(?!\/)/.test(notification.data.url)
        ? notification.data.url
        : '/';
    window.focus();
    window.location.assign(new URL(url, window.location.origin));
    notification.close();
  };
}

/** Show only new synced notices in open BokyDo tabs, using the browser's local notification API. */
export function LiveDesktopNotifications() {
  const state = useSyncState();
  const store = useStore();
  const serverSynced = useSyncReady();
  const { t } = useTranslation();
  const activeUser = state.user?.id ?? null;
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current += 1;
    return () => {
      lifetime.current += 1;
    };
  }, [activeUser]);
  const consentVersion = useRef(0);
  const baseline = useRef<{ userId: string | null; ids: Set<string>; after: number }>({
    userId: null,
    ids: new Set(),
    after: 0,
  });
  const seenInMemory = useRef(new Set<string>());

  useEffect(() => {
    const onConsentChange = () => {
      consentVersion.current += 1;
    };
    window.addEventListener(OPT_IN_EVENT, onConsentChange);
    const onStorage = (event: StorageEvent) => {
      if (desktopConsentChanged(event.key, activeUser)) onConsentChange();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(OPT_IN_EVENT, onConsentChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [activeUser]);

  useEffect(() => {
    const lifetimeAtStart = lifetime.current;
    const consentVersionAtStart = consentVersion.current;
    if (!serverSynced) return;
    const ids = new Set(state.notifications.map((n) => n.id));
    if (!activeUser || baseline.current.userId !== activeUser) {
      baseline.current = {
        userId: activeUser,
        ids,
        after: latestNotificationTimestamp(state.notifications),
      };
      seenInMemory.current.clear();
      return;
    }
    const previous = baseline.current.ids;
    const after = baseline.current.after;
    baseline.current = { userId: activeUser, ids: new Set([...previous, ...ids]), after };
    const newNotifications = newNotificationIds(previous, state.notifications, after).filter(
      (n) => !seenInMemory.current.has(`${activeUser}:${n.id}`),
    );
    for (const n of newNotifications) seenInMemory.current.add(`${activeUser}:${n.id}`);
    const prefs = state.user?.preferences.notifications;
    if (!prefs || !desktopNotificationsOptedIn(activeUser) || !('Notification' in window)) return;
    if (!window.isSecureContext || Notification.permission !== 'granted') return;
    const timeZone =
      state.user?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const canDisplay = (notice: AppNotification) => {
      const currentUser = store.state.user;
      const current = store.state.notifications.find((item) => item.id === notice.id);
      return (
        lifetime.current === lifetimeAtStart &&
        consentVersion.current === consentVersionAtStart &&
        currentUser?.id === activeUser &&
        !!current &&
        desktopNotificationsOptedIn(activeUser) &&
        'Notification' in window &&
        window.isSecureContext &&
        Notification.permission === 'granted' &&
        shouldShowDesktopNotification(
          current,
          currentUser.preferences.notifications,
          new Date(),
          currentUser.timeZone || 'UTC',
        )
      );
    };
    for (const n of newNotifications) {
      if (!shouldShowDesktopNotification(n, prefs, new Date(), timeZone)) continue;
      void claimDesktopNotification(activeUser, n.id)
        .then((claimed) => {
          if (claimed && canDisplay(n))
            return displayDesktopNotification(n, bodyFor(n, t), () => canDisplay(n));
        })
        .catch(() => undefined);
    }
    return;
  }, [activeUser, serverSynced, state.notifications, state.user, store, t]);
  return null;
}

export function desktopNotificationAvailability():
  'unsupported' | 'insecure' | 'denied' | 'dismissed' | 'granted' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'default') return 'dismissed';
  return 'granted';
}
