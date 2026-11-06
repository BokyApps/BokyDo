# Android release verification (A7a)

How to check that a release APK is really built from the published source: build it twice
and compare. This is also what `.github/workflows/android-reproducible.yml` does in CI.

## Verify a build locally

You need JDK 17+ and the Android SDK (`ANDROID_HOME` set, `~/Android/Sdk` works;
`apps/android/local.properties` with `sdk.dir=` is gitignored). No keystore: a local
release build is unsigned.

```bash
# Two clean checkouts of the same commit, side by side. Each needs its own Gradle home: the
# shared build cache (apps/android sets org.gradle.caching=true) would otherwise hand build B
# build A's outputs, and the comparison would pass without proving anything.
git worktree add /tmp/bokydo-a <commit>      # or: git clone <url> /tmp/bokydo-a
git worktree add /tmp/bokydo-b <commit>
for d in /tmp/bokydo-a /tmp/bokydo-b; do
  (cd "$d/apps/android" && \
    GRADLE_USER_HOME=/tmp/gradle-$(basename "$d") ./gradlew --no-daemon --no-build-cache :app:assembleRelease)
done
A=/tmp/bokydo-a/apps/android/app/build/outputs/apk/release/app-release-unsigned.apk
B=/tmp/bokydo-b/apps/android/app/build/outputs/apk/release/app-release-unsigned.apk
sha256sum "$A" "$B"
cmp "$A" "$B" && echo "Reproducible: byte-identical."
```

On mismatch, `diffoscope "$A" "$B"` shows what moved. Known traps (from F-Droid's
Reproducible Builds notes):

- **Baseline profiles** (`baseline.prof`, `profm`): a profile baked into one build changes
  the APK. This repo keeps none; if one is ever added, both builds must use the same file.
- **apksigner version**: F-Droid's `apksigcopier` verification wants apksigner from
  build-tools 34, not 35+. Signing itself is A7b; the reproducibility check compares
  unsigned APKs, so the signer version doesn't matter here.
- **Timestamps in the environment** (e.g. a dirty clock or `SOURCE_DATE_EPOCH` set in one
  shell and not the other) can leak into zip entries. Build both checkouts back to back.

**What this does not prove.** Both builds run on the same machine, with the same JDK and the
same Android SDK, so it shows the build is deterministic there. F-Droid's builder is a
different machine, a different SDK and a different NDK, and drift between machines - a
different `build-tools` revision, a different R8 version - is exactly what it will hit. The
job is a regression guard, not a certificate that F-Droid's APK will match; a mismatched
build is diagnosed with F-Droid's own logs and `apksigcopier`.

## F-Droid metadata

Lives in `apps/android/fastlane/metadata/android/en-US/` (F-Droid reads
`<subdir>/fastlane/…` when the build recipe names the subdir):

- `title.txt` (≤ 50 chars), `short_description.txt` (≤ 80), `full_description.txt` (≤ 4000)
- `changelogs/<versionCode>.txt` (≤ 500) — add one per release, named by `versionCode`
- `images/icon.png` — the launcher artwork; phone screenshots land once the A2 screens settle

`dependenciesInfo { includeInApk = false }` is set in `app/build.gradle.kts` because
F-Droid's scanner flags Google's encrypted dependency-metadata block.

Keystores, signing and publishing are A7b (blocked by A6 hardening), not this card.

## Task and habit widgets (0.1.1)

After signing in, long-press the home screen and choose Widgets → BokyDo. **BokyDo tasks**
asks for Inbox, Today (including overdue), Upcoming (the next two weeks), or a specific project.
Add multiple instances for different lists. Tap a task to open its details or its checkbox to
complete it; the header opens its list and + starts an addition there. **BokyDo habits** shows
personal daily/weekly habits and today's check-ins. Its header opens Browse → Habits in the app.
Manage habits opens the web tracker for creation and editing.

Both list widgets resize and scroll, have a refresh action, and follow the app's palette and
bundled font (task widgets also offer a light/dark override). Up to 12 entries appear in a widget;
open its list for additional entries. Text bitmaps retain full accessibility labels. Updates
follow local changes, foreground sync, periodic WorkManager sync and launcher refreshes. Android
may defer background work during Doze; Refresh requests a catch-up. Habit taps are stored in
SQLite with their original date and desired checked state and retried idempotently. A stale
widget from a previous day refreshes before accepting another check-in. Signing out clears
caches/queues, and actions from an earlier login cannot write to a new account.

Version 2 of the device database adds habit tables without rebuilding task tables. VersionCode 2
uses the existing release signing certificate, so installing the APK over the trial preserves
accounts, tasks and widget placements. Debug-only widget-host/test classes are absent from release.

### Device regression

Run against a **disposable emulator and a fresh loopback server**. `docker/android-widgets-fixture.mjs`
refuses an initialized instance and writes its temporary token to a new private file. Install
`playwright-core` outside the repo (as for other browser regressions), then set `NODE_PATH` and run:

```bash
BOKYDO_TEST_BASE_URL=http://127.0.0.1:18090 \
BOKYDO_WIDGET_FIXTURE_PATH=/tmp/bokydo-widget-fixture.json \
node docker/android-widgets-fixture.mjs
cd apps/android
./gradlew :core:test :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb reverse tcp:18090 tcp:18090
adb shell appwidget grantbind --package com.bokyapps.bokydo --user 0
# Copy the private fixture into the debug app without echoing it.
adb shell run-as com.bokyapps.bokydo mkdir -p files
adb shell 'run-as com.bokyapps.bokydo sh -c "cat > files/widget-fixture.json"' < /tmp/bokydo-widget-fixture.json
adb shell am instrument -w -r com.bokyapps.bokydo.test/androidx.test.runner.AndroidJUnitRunner
```

The test uses a real AppWidgetHost and actual Glance callback PendingIntents, verifies all four
task lists, persists a habit check-in to the server, reopens the SQLite queue and checks account
isolation. A separate device test upgrades a version-one database with queued task changes.
The JVM suite covers network/restart retry, success followed by failed refresh, rapid check-ins,
permanent refusal, midnight and account week boundaries. Remove the emulator, stack and fixture
after testing; never use these fixture steps on an owner's installation.

### Signed-release startup gate (0.1.2)

The optimized 0.1.1 APK crashed before `Application.onCreate`: WorkManager's initializer opens
its Room database by reflection, but R8 removed `WorkDatabase_Impl`'s no-argument constructor.
The app's release rules now explicitly preserve Room database constructors. Debug widget tests
could not detect that release-only failure.

After signing, install the exact candidate APK over the preceding signed release on a disposable
emulator. Put `adb` on PATH (or set `ADB`), then run from the repository root:

```bash
BOKYDO_ANDROID_SERIAL=emulator-5562 python3 docker/android-release-startup.py
```

This gate retains app data, force-stops and launches three times, checks that the process stays
alive, checks the crash buffer, and verifies a usable screen through UI Automator. The default
expected text is `Server address` for a fresh installation; set `BOKYDO_ANDROID_EXPECT_TEXT` for
an already-authorized test fixture. It refuses a non-emulator serial and a debuggable target. A successful install or
`am start` response alone does not pass this gate. Keep the signed APK's R8 mapping with the
release verification artifacts so a crash can be traced back to the original method.

`ReleaseConstructorInstrumentation` checks the Room database, Glance action callbacks and background
worker constructors through the installed target's class loader. Build `:app:assembleDebugAndroidTest -PreleaseConstructorSmoke=true`,
sign that test APK locally with the same certificate as the candidate release, install it with
`adb install -r -t`, and select the platform-only release harness:

```bash
adb shell am instrument -w -r \
  com.bokyapps.bokydo.test/com.bokyapps.bokydo.ReleaseConstructorInstrumentation
```

The platform-only Java harness avoids AndroidJUnitRunner's dependencies on unshrunk target
library names. Ordinary debug widget-host tests depend on a debug-only activity and should not
be selected against a release. The signed test APK is a private verification artifact and is not published.
