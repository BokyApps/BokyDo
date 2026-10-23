// Service worker: app-shell cache (offline reads) plus Web Push notifications.
//
// What it caches is the shell only: the HTML, the hashed JS/CSS/fonts and the icons. Everything
// private lives under /api/ (and /mcp, /oauth, /.well-known, the health probes) and is never
// touched here — those requests are not intercepted at all, so auth, CSRF, streaming sync and
// the server's `Cache-Control: no-store` behave exactly as if no worker existed. Writes survive
// a reload through the opt-in offline copy, not through this cache.
//
// A new worker never takes over by itself: the app shows "A new version is ready" and sends
// SKIP_WAITING only when the user agrees, because old page code against a new shell can lose
// queued writes. `VERSION` and the build asset list are injected by the plugin in vite.config.ts.

const ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  /* __BOKYDO_ASSETS__ */
];
const VERSION = '__BOKYDO_VERSION__';
const SHELL = `bokydo-shell-${VERSION}`;
// In dev the plugin hasn't run, so `VERSION` is still the placeholder and `ASSETS` is empty:
// don't cache the dev modules or hijack HMR. The built worker replaces both at build time.
const BUILT = VERSION !== '__BOKYDO_VERSION__';

/** Paths the worker must never answer for: auth, sync, OAuth, discovery and the probes. */
const NEVER = ['/api', '/mcp', '/oauth', '/.well-known', '/healthz', '/readyz'];

/** Should this request be served from the shell cache at all? Exposed for tests. */
function shouldIntercept(url, method) {
  if (method !== 'GET' || url.origin !== self.location.origin) return false;
  const path = url.pathname;
  return !NEVER.some((base) => path === base || path.startsWith(`${base}/`));
}
self.BokyDoSW = { shouldIntercept, NEVER };

self.addEventListener('install', (event) => {
  if (!BUILT) return;
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(ASSETS))
      // A failed precache (a deploy caught mid-flight) must not strand the install.
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop every previous shell; the version is in the name.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('bokydo-shell-') && key !== SHELL)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

// The page asks to take the update it has already shown a prompt for.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (!BUILT) return;
  const { request } = event;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!shouldIntercept(url, request.method)) return;
  // Navigations: prefer the network (fresh HTML), fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  // Hashed build assets and icons: serve from the shell, fetch and cache on a miss.
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL);
    return (await cache.match('/index.html')) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok && response.type === 'basic') {
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

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
