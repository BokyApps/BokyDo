# ADR 0022: Installable web app, offline read cache and queued writes

- Status: Accepted (2026-10-09). Implementation is W12a.

## Context

W12a makes the web app installable, usable offline, and smaller on first load (F-023: one
658 KB bundle). Three things constrain it:

- `apps/web/public/sw.js` already exists and is load-bearing: it shows Web Push notifications
  and focuses the app on click (W5). A second service worker on the same scope would replace it,
  and a broken one silently stops reminders.
- Everything a user sees is private data. The server already sends `Cache-Control: no-store` on
  every `/api/` response (`security-headers.ts`), so nothing private lands in the HTTP cache.
  Anything we now keep on the device is new data at rest, often on shared or family computers.
- The sync client (`packages/sync-client`) already has the right model for offline writes:
  `view = confirmed state + replay(queued commands)`, and the server deduplicates by command UUID
  (`processed_commands`, never pruned), so re-sending a command after a lost response is safe.
  Only the queue's lifetime is the problem: it lives in memory and is lost on reload.

## Decision

- **One service worker, still hand-written.** Extend `public/sw.js`; do not add
  `vite-plugin-pwa` or Workbox. They would pull `workbox-build` and its dependency tree into the
  build for what is ~60 lines here, and the push handlers must stay exactly as they are. A small
  Vite plugin in `apps/web` writes the list of hashed build assets into the worker at build time
  (a `generateBundle` hook emitting `sw.js` with an `ASSETS` array and a `VERSION` hash).
- **What the worker caches: the app shell only.** On `install`, precache `index.html`, the
  hashed JS/CSS/font files and `favicon.svg` into a cache named `bokydo-shell-<VERSION>`; on
  `activate`, delete every other `bokydo-shell-*` cache. On `fetch`:
  - same-origin navigations: network first, falling back to the cached `index.html`;
  - same-origin hashed assets: cache first;
  - **anything under `/api/`, `/mcp`, `/oauth`, `/.well-known/`, `/healthz`, `/readyz`, any
    non-GET request and any cross-origin request: not intercepted at all** (no `respondWith`),
    so auth, CSRF, streaming sync and the `no-store` rule behave exactly as today.
- **Updates.** A new worker waits; the app shows "A new version is ready — Reload" and sends
  `SKIP_WAITING` when the user agrees. Never `skipWaiting()` unconditionally: a page running old
  code against a new shell can lose queued writes.
- **Offline read cache: opt-in, per device.** Settings › This device › "Keep a copy on this
  device for offline use", off by default, stored in `localStorage`. When on, the confirmed sync
  state and the pending command queue are written to IndexedDB (database `bokydo-offline`,
  one record per user id) after each successful sync and each enqueue. On start-up, if it is on,
  the store hydrates from IndexedDB before the first network sync, then syncs normally. When it
  is off nothing is written, and turning it off deletes the database.
- **Queued writes survive a reload** (only with the setting on). Commands keep their UUIDs, so a
  command whose response was lost is answered from `processed_commands` instead of applying
  twice. A command the server rejects is dropped from the queue as today (that is the rollback).
- **Sign-out wipes the device.** On sign-out the client deletes `bokydo-offline`, deletes every
  `bokydo-*` cache and unsubscribes this browser's push subscription before navigating to
  `/login`. The server's logout response also sends `Clear-Site-Data: "cache", "storage"` as a
  backstop for browsers where the page is gone before the client finishes; it only applies on
  HTTPS (secure contexts), which is why the client does its own wipe for LAN/HTTP installs.
  "storage" also unregisters the service worker, so push for this browser stops until the next
  sign-in re-registers it — intended, since the device is no longer signed in. It clears
  `localStorage` too (appearance, view options, the offline setting): also intended.
- **A different user on the same browser.** On sign-in, delete any `bokydo-offline` record whose
  user id is not the signed-in user's. A 401 from sync (session expired or revoked) keeps the data
  but shows the sign-in screen; a sign-in as someone else then wipes it as above.
- **Installable.** Add `manifest.webmanifest` (name, short name, `start_url: "/"`,
  `display: "standalone"`, theme colours from the default theme, 192/512 px PNG icons and a
  maskable icon) linked from `index.html`. CSP already allows `manifest-src 'self'` and
  `worker-src 'self'`; no CSP change is needed.
- **Code splitting (F-023).** Route-level `lazy()` for Settings, Admin, Productivity, Calendar,
  Import, AI settings and Ask; the time-zone table and theme tables load with the screens that use
  them. Target: the first-load JS under 250 KB gzip, measured in the build output.

## Consequences

- Turning the setting on puts task data at rest in the browser profile. The setting's help text
  says so, and suggests leaving it off on a shared computer.
- A service worker bug can strand users on an old shell. The update prompt, the versioned cache
  name and network-first navigations keep that recoverable without clearing site data by hand.
- Tests to add with the implementation: the worker never intercepts `/api/` (unit test of the
  fetch handler's routing function), hydration and wipe-on-sign-out (web unit tests with
  `fake-indexeddb`), a smoke test in `docker/smoke-test.sh` that the built `sw.js` still contains
  the push handlers, and the a11y audit re-run for the update prompt.
