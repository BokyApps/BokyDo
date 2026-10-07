# ADR 0005: Reminders, background jobs and notification delivery

- Status: Accepted (2026-10-06)

## Context

W6 adds reminders and sends notifications by email and Web Push. That needs work that happens
on a clock rather than in a request: reminders must fire on the minute, in the right time zone,
and catch up sensibly after the server was down. The plan named pg-boss for jobs. Web Push needs
VAPID keys and RFC 8291 payload encryption. The server must POST to URLs that clients give it.

## Decision

- **No job library: a small Postgres-backed runner.** One in-process loop (every 10 s, and soon
  after any commit) runs three jobs in turn: fire due reminders, deliver the notification outbox,
  send daily digests. All state lives in ordinary tables (`reminders.fire_at` / `fired_for`,
  `notifications.dispatched_at`, `users.last_digest_on`), so a restart simply resumes. Rows are
  claimed with `FOR UPDATE SKIP LOCKED`, so a second replica later would not double-send. pg-boss
  would have added a dependency and its own schema for what amounts to three queries.
- **Reminder times are derived, not scheduled.** `fire_at` is recomputed after every write that
  touches a task (and when a user's time zone or automatic-reminder setting changes), using
  `zonedInstant` (DST-correct, Temporal "compatible" rules). `fired_for` holds the `fire_at` that
  was delivered, so a recurring task's next occurrence fires again and nothing fires twice. A
  reminder whose time has already passed when it is set never fires; one missed because the
  server was down is sent late (marked late) for up to 12 hours, then skipped.
- **Reminders are personal and synced.** Only the owner sees, syncs and receives a reminder, and
  only while they can still see the task. Clients get them through the normal sync, so the
  Android app can schedule the same reminders locally (D7).
- **Delivery is an outbox.** Every notification is written in-app first, inside the command's
  transaction. The runner claims undelivered ones after commit and sends email and/or push
  according to the recipient's preferences at that moment. Delivery is at-most-once: a crash
  between claim and send loses that email/push, never duplicates it; the in-app copy remains.
  Notifications older than an hour, or about projects the recipient can no longer see, are not
  sent. Quiet hours drop email/push for everything except reminders and security alerts.
- **Web Push in-house.** RFC 8291 (aes128gcm) and RFC 8292 (VAPID, ES256) are about 150 lines
  on `node:crypto`, verified against the RFC 8291 test vector, instead of a dependency. The VAPID
  key is generated on first boot into the secrets volume like the other keys (ADR 0002).
- **Push endpoints are allow-listed.** The server only POSTs to the browser push services
  (FCM, Mozilla, Apple, WNS) over HTTPS on port 443, never follows redirects, and validates the
  browser's keys before storing a subscription. A subscription belongs to the session that
  created it: signing out (or the session expiring) removes it, and registering an endpoint that
  exists moves it to the new user, so a shared computer never shows someone else's alerts.
- **Email** carries a signed, per-topic unsubscribe link (HMAC of user and topic) that opens a
  confirm page in the app; the same URL goes in `List-Unsubscribe`. Security alerts can't be
  unsubscribed and are still sent directly by the notifier to the right address.

## Consequences

- Precision is about 10 seconds; fine for minute-granular reminders.
- Push only reaches browsers whose vendor push service is on the allow-list. UnifiedPush and
  self-hosted push servers (for the Android app) will need an admin-managed allow-list (A-phase).
  _Update 2026-10-07 (M1):_ that list is the admin setting `push.allowedHosts` (Admin → Settings →
  Push services): hostnames, optionally with a port or a `*.` prefix, HTTPS only, empty by
  default. Endpoints are checked against it when registered and again at every send, and push is
  now sent through the SSRF-safe outbound client (ADR 0006): a listed name may resolve to a
  private address (a self-hosted ntfy), never to loopback, link-local or metadata addresses.
  UnifiedPush endpoints receive the same RFC 8291/8292 Web Push messages as browsers.
- Quiet hours drop rather than defer; the inbox keeps everything, so nothing is lost.
- At-most-once delivery was chosen over at-least-once: a duplicate reminder email is worse than
  a rare missing one when the in-app copy always exists.
