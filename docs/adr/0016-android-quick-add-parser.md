# ADR 0016: Android quick add runs the real parser in the JavaScript sandbox

- Status: Accepted (2026-10-07)

## Context

Quick add ("Call Ana tomorrow 3pm #Work p1 @phone") is parsed by `packages/nlp`: 2,130 tests of
dates, recurrence, projects, sections, labels, people, priorities, durations and reminders, with
live highlighting as you type. A2 builds the Android quick add and had to choose (PLAN §9):
embed that parser on the phone, call the server to parse, or write a second parser in Kotlin.

- A **Kotlin port** would drift from the web the first time either changes, and duplicates the
  part of the app with the most edge cases.
- **Server parsing** breaks quick add offline, adds a round trip to every keystroke for
  highlighting, and sends half-typed text to the server.
- **Embedding** needs a JavaScript engine. QuickJS means shipping native libraries (per ABI, and
  F-Droid builds native code from source); AndroidX `javascriptengine` (`JavaScriptSandbox`)
  uses the V8 of the installed WebView in an isolated process, with no native code in the app.

## Spike (2026-10-07, API 36 emulator, WebView 133)

- `packages/nlp` has no dependencies and bundles (esbuild, IIFE, minified) to **21 KB** (8 KB
  gzipped) with a one-function entry point: JSON in, JSON out, no host objects crossing over.
- It needs `Intl` only for "what time is it in this zone" (`localNow`); quick add takes `now` as
  input, so the app computes it with `java.time` and the sandbox needs no time-zone data.
- `JavaScriptSandbox`: supported, with isolate termination and promise returns. Cold start plus
  loading the bundle **≈ 590 ms** (once per process), first parse ≈ 90 ms, then **≈ 3.4 ms per
  parse**: fast enough to re-parse on every keystroke.
- The Android result for `Call Ana tomorrow 3pm #Work p1 @phone every monday` is **byte for byte
  the same** as Node's.

## Decision

- A2 runs `packages/nlp` in `JavaScriptSandbox`
  (`androidx.javascriptengine:javascriptengine`, Apache-2.0, pure Java).
- **One sandbox per app**, started lazily when quick add first opens and kept for the process
  (binding twice fails, and a cold start costs ~0.6 s). One isolate, with the bundle evaluated
  once.
- **Interface:** `bokydoQuickAdd(json) → json`. The input is `{ text, options }`, where options
  are the same as `QuickAddOptions` (`now` from `java.time` in the user's synced `timeZone`,
  writable projects, sections, labels, members, `weekStart`, `dateOrder`, `disabled` token keys
  as an array). The output is `QuickAddResult`. The text is passed as a JSON string literal, never
  spliced into code. The resulting ids are only suggestions, and the sync engine re-checks every
  write.
- **The bundle is generated, not hand-written.** A `packages/nlp` script builds
  `apps/android/app/src/main/assets/nlp.js` with esbuild. The file is committed (Gradle builds
  don't need Node, which keeps F-Droid reproducible builds simple), and CI rebuilds it and fails
  if it differs from the committed copy, so the phone can't drift from the web.
- **Fallback:** where `JavaScriptSandbox.isSupported()` is false (an old or missing WebView),
  quick add still works as plain text (title only, fields set with pickers), with a one-line
  note. No server parsing endpoint is added.

## Consequences

- Web and Android parse identically. A parser fix reaches the phone with the next app build.
- The app depends on an up-to-date WebView for smart parsing; devices without one lose
  highlighting, not quick add.
- The isolate is sandboxed (separate process, no network or file access); a hostile string can
  at worst make one parse fail.
