# ADR 0010: Android app foundation

- Status: Accepted (2026-10-06)

## Context

Phase 2 is a native Android app (PLAN §9). A1 lays the foundation: connecting to a
self-hosted server, signing in, storing credentials, and keeping a local copy of the user's
data in sync. The server side is ready: OAuth 2.1 with PKCE (ADR 0008), sync with a bearer
token, and the event stream (ADR 0003). The device is a hostile-ish environment: other apps,
backups, lost phones, untrusted networks.

## Decision

- **Layout.** `apps/android` is a Gradle build with a pure Kotlin/JVM `:core` module (address
  rules, discovery checks, PKCE and the redirect checks, the HTTP client, the sync engine and
  merge rules) and the `:app` module (Keystore, SQLite, WorkManager, Custom Tabs, Compose UI).
  `:core` is unit-tested on the JVM against a mock server. AGP 9.4.1 with built-in Kotlin
  2.2.10 and Gradle 9.6.0, the same as BokyQR. The wrapper jar and distribution are pinned by
  SHA-256 (also checked in CI).
- **Discovery.** The user types an address. The app reads `/.well-known/bokydo` and accepts it
  only if it describes that same origin: issuer, every endpoint and the app's fixed client
  identity. A server whose public URL differs (e.g. http typed, https configured) gets a "use
  this address instead" message rather than a silent switch.
- **https by default.** Plain http is allowed only for addresses that can only be on the user's
  own network (loopback, private IPv4, `.local`/`.lan`/`.home.arpa`/`.internal`), after a warning,
  as the web app allows for LAN installs. The platform config therefore permits cleartext
  (Android can't express "private IPs only"); the app enforces the rule itself. Only system
  certificate authorities are trusted.
- **Sign-in in a Custom Tab** with the first-party OAuth client (`bkdc_bokydo-android-app-001`,
  redirect `com.bokyapps.bokydo:/oauth2redirect`), so passwords, TOTP and passkeys work exactly
  as on the web and the app never sees a password. The redirect is checked against the sign-in
  in progress: `state`, issuer (RFC 9207), redirect path, a 10-minute expiry, and no repeated
  parameters. The in-progress state is used once. Another app that registers the same scheme
  gets a code it can't redeem without the PKCE verifier.
- **Tokens in the Keystore-backed vault.** The session (tokens and discovery) is AES-256-GCM
  encrypted under a non-exportable Android Keystore key and bound to its name as associated data.
  The key needs no user authentication, so background sync works; an optional app lock (A2)
  gates the UI instead. If the key can't decrypt (wiped, restored elsewhere), the app counts as
  signed out. Backups and device-to-device transfer are off for everything.
- **One HTTP client:** redirects never followed (a bearer token only goes where the user
  chose), bodies capped at 32 MB, and refreshes serialised. Two concurrent refreshes would look
  like token theft to the server and revoke the session (ADR 0008). A refused grant signs
  out; other errors keep the session. Tokens never appear in `toString()` or logs.
- **Local data: plain SQLite, not Room.** Entities are stored as the server's JSON by type and
  id, alongside the complete snapshots, the cursor and the command queue. Merge rules are those
  of the web client (`applyServerResponse`), pinned by `MemoryStore` tests. No annotation
  processing (KSP and AGP 9 built-in Kotlin are a fragile pairing today), and screens load state
  into memory like the web app. Room remains an option if A2's queries outgrow that.
- **Commands are queued, not lost.** Changes go into the queue with device-generated UUIDv7 ids
  (no temporary ids to remap, as on the web). They're sent in order, 100 per request, and leave
  the queue only once the server has answered. Refusals are kept for the UI. Resending is safe:
  the server replays the first result for a known command UUID.
- **Sync triggers:** WorkManager every 15 minutes and right after sign-in or changes; while the
  app is in the foreground, the server's event stream (SSE, the same bearer token) triggers a
  sync on every poke, reconnecting with backoff. The plan said WebSocket; the server uses SSE
  (ADR 0003).

## Consequences

- A1's UI is deliberately minimal (connect, sign in, status). A2 builds the screens on
  `SqliteStore` and the engine, adds optimistic local updates, and the optional biometric lock.
- Users with a private CA on their LAN need a publicly trusted certificate (or plain http on
  the LAN). Trusting user-installed CAs can be revisited with an explicit setting.
- The database isn't encrypted beyond Android's file-based encryption. A lost, unlocked, rooted
  device exposes cached tasks, but not the tokens.
- `/.well-known/assetlinks.json` is served from Admin → Settings (`android.certFingerprints`)
  for passkeys and app links, ready for when the release signing key exists (A7).
