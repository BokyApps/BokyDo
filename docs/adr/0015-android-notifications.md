# ADR 0015: Android notifications — local reminder alarms and UnifiedPush

- Status: Accepted (2026-10-07)

## Context

A3 makes the Android app notify. PLAN D7 already decided the shape: a self-hosted server can't
use Firebase Cloud Messaging for our app, so reminders must not depend on push at all, and live
events (assignments, mentions, comments) come through UnifiedPush (ntfy and other distributors).
M1 gave admins the list of push servers the server may send to (ADR 0005 update).

## Decision

### Reminders: alarms on the device

- The app computes fire times from the synced tasks and reminders with the server's rules
  (`computeFireAt`): absolute reminders are fixed; relative ones follow the task's due time, in
  its own zone or floating in the user's zone; no due time means inactive; completed tasks never
  remind. Skipped DST times move forward by the gap and repeated ones take the first occurrence,
  in both `java.time` and the server's `zonedInstant` (tested on the same cases). The synced user
  now carries `timeZone`, the effective zone (the preference, else the instance default), so the
  device never guesses.
- **One alarm at a time**: the next reminder. When it fires, everything due is shown (each
  reminder once per fire time; nothing more than 12 hours late, like the server) and the next
  alarm is set. Re-armed after every sync, on start, and on boot, clock or time-zone change, app
  update and exact-alarm permission change.
- Exact alarms use `SCHEDULE_EXACT_ALARM`, which the user may deny on Android 14+; then alarms
  are inexact (a few minutes late) and the app offers to open the setting. `USE_EXACT_ALARM` is
  not used: Google Play limits it to alarm-clock and calendar apps.
- Actions: **Complete** (a normal queued `task_complete`, so it works offline and syncs later),
  **Snooze 15 min** and **1 hour** (kept on the device). Reschedule and reply-to-comment wait for
  A2's task screens.

### Live events: UnifiedPush, spoken directly

- The app implements the UnifiedPush Android protocol (AND_3) itself, about 250 lines, instead
  of the connector library, which brings in Tink and more. It finds distributors by their
  `REGISTER` receiver, registers with a random token (UUIDv4), proves its identity to the
  distributor (a PendingIntent, and share-identity on Android 14+), and passes the server's VAPID
  key so the distributor can limit who may push.
- **Encryption end to end.** The device makes its own P-256 key pair and auth secret, kept in the
  Keystore-encrypted vault, and registers them with the server like a browser does. The server
  sends the same RFC 8291 Web Push message as to browsers; the app decrypts it (pure JVM code in
  `:core`, tested against the RFC's own example). Distributors and push servers only see
  ciphertext; a forged or altered message fails the GCM tag and is dropped.
- **Receiver hygiene.** The receiver has to be exported (distributors are other apps). Every
  message must carry our current token (compared in constant time), so another app can't feed
  us messages or end the registration. Notification action receivers are not exported, and all
  PendingIntents are explicit and immutable.
- **Bound to the sign-in.** Push routes accept the app's `sync`-scoped OAuth token.
  `push_subscriptions.grant_id` (migration 0016) ties an app's registration to its grant, as a
  browser's is tied to its session. Revoking the grant (signing out, removing the app in
  Settings, refresh-token reuse) or an account reset deletes it, and sending re-checks the grant.
  Personal access tokens can't register: nothing would end the registration with the device.
- A pushed message shows a notification and triggers a sync. Its tag is the task's id, the same
  as a local reminder for that task, so the server's push for a reminder replaces the local one
  quietly instead of doubling it.

## Consequences

- Reminders work with no network and no push app. Instant notifications need a UnifiedPush
  distributor on the phone, and its server on the admin's list (the app explains which host).
- Fire times follow the server's rules exactly, but a device with a wrong clock reminds at the
  wrong time: same as any alarm app.
- Lock-screen privacy follows Android's per-app setting (notifications are marked private). A
  "hide task names" option belongs to A6 hardening.
- A Play Store flavour with FCM would need a relay (PLAN §9): not built.
