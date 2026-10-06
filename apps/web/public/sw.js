// Service worker: shows Web Push notifications and opens them in the app. No caching here
// (offline support comes with the PWA work); payloads are decrypted by the browser.

/** Only same-origin paths may be opened from a notification. */
const safePath = (url) => (typeof url === 'string' && /^\/(?!\/)/.test(url) ? url : '/');

self.addEventListener('push', (event) => {
  let data;
  try {
    data = (event.data && event.data.json()) || {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'BokyDo';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/favicon.svg',
      data: { url: safePath(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: 'bokydo:open', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
