import { api } from './api.js';

export type PushState = 'unsupported' | 'insecure' | 'denied' | 'off' | 'on';

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const fromB64u = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

/** Is push on for this browser (and this account)? */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Ask permission, subscribe with this server's key, and register the subscription. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const reg = await registration();
  const { publicKey } = await api<{ publicKey: string }>('GET', '/api/v1/push/key');
  const key = fromB64u(publicKey);
  let sub = await reg.pushManager.getSubscription();
  const current = sub?.options.applicationServerKey;
  if (sub && (!current || !sameBytes(new Uint8Array(current), key))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('POST', '/api/v1/push/subscriptions', sub.toJSON());
  return 'on';
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api('DELETE', '/api/v1/push/subscriptions', { endpoint: sub.endpoint }).catch(() => null);
  await sub.unsubscribe();
}

/**
 * Subscriptions belong to a session on the server (signing out removes them). After signing in
 * again on a browser that already has permission, re-register so pushes resume here.
 */
export async function resyncPush(): Promise<void> {
  if ((await pushState()) !== 'on') return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await api('POST', '/api/v1/push/subscriptions', sub.toJSON()).catch(() => null);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
