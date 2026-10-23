import { wipeOffline } from './offline.js';

/**
 * Forget this device on sign-out: the offline copy, every `bokydo-*` cache and this browser's
 * push subscription. The server's logout response also sends `Clear-Site-Data: "cache", "storage"`
 * as a backstop, but that only applies on HTTPS; this covers LAN/HTTP installs and browsers that
 * leave the page before the header takes effect.
 */
export async function wipeDevice(): Promise<void> {
  await wipeOffline();
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith('bokydo-')).map((key) => caches.delete(key)),
      );
    }
  } catch {
    // No Cache Storage (or access denied): nothing to clear.
  }
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
    }
  } catch {
    // Push unavailable; the server already dropped the subscription with the session.
  }
}
