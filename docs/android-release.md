# Android release verification (A7a)

## Hosting the Android download

Settings → Mobile app reads `/downloads/android.json` from the same origin. Publish a signed,
versioned APK there and publish the manifest atomically after verifying the APK. The manifest
must use a local `/downloads/<filename>.apk` path; external download links are rejected.

```json
{
  "version": "0.1.4",
  "versionCode": 5,
  "url": "/downloads/bokydo-0.1.4.apk",
  "minAndroid": "8.0",
  "minSdk": 26,
  "sizeBytes": 12345678,
  "sha256": "replace with the APK's 64-character lowercase SHA-256 hash"
}
```

Use the APK's actual `versionCode` (an increasing integer), `minSdk` API level, file size and
`sha256sum` output. `minAndroid` is the human-readable Android version. Android Settings → App
updates checks this same manifest, downloads newer releases without session credentials, verifies
the checksum, APK package/version and signing certificate, then opens Android's update installer.
The first update may require allowing installs from BokyDo in Android settings. Installing over
the existing app keeps its data and widgets. Existing versions before0.1.4 need one manual update
to gain this updater. All future APKs must keep the same signing certificate. Serve JSON as `application/json` with
`Cache-Control: no-store`, and APKs as `application/vnd.android.package-archive`. For Caddy,
mount a read-only directory at `/srv/downloads` and put this before the app reverse proxy:

```caddyfile
handle_path /downloads/* {
    root * /srv/downloads
    header /android.json Cache-Control "no-store"
    file_server
}
```

Keep each versioned APK immutable and use the same signing certificate for updates. Do not
commit private signing keys or APKs to the source tree. Other installations can host their own
build with this manifest; without one, the settings page explains that no download is available.
The service worker never intercepts `/downloads`, so metadata stays fresh and APKs aren't cached
as part of the offline app shell.

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

From 0.1.5, task widgets reserve space for the add-task icon even with a long project name.
Every widget has a small BokyDo logo button that opens the main Today screen without opening
task entry. The quick-add widget has separate add and app-open buttons and starts two cells wide.

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

### Signed-release Android version matrix

`docker/android-matrix-device.py` exercises the exact signed APK on disposable stock Android
14, 15 and 16 emulators (API 34–36). It verifies three fresh cold starts, native OAuth sign-in
and task creation, Inbox/Today/Upcoming/project widgets, task completion, habit check-ins and
widget navigation, Inbox/Today habit sections with check-in and hide controls, and full-width
widget rendering beyond360dp. It checks task-widget creation in the configured project,
quick-add-widget creation in Inbox, both action icons inside a compact 180dp widget, and each
widget's separate app-open button. It also downloads and installs a newer same-certificate APK through
Android's system installer, checks retained sign-in/check-ins/widget configuration, then verifies
three signed-in process restarts. An independent backend read checks
that the created task and widget actions persisted. It retains application data between starts.

Build the private platform-only controller and sign its test APK with the candidate's certificate:

```bash
apps/android/gradlew -p apps/android :app:assembleDebugAndroidTest -PreleaseMatrixSmoke=true
# zipalign and apksigner the test APK with the same certificate as the release.
# Never publish this helper APK: it contains a browser limited to the local fixture.
# Set the display during provisioning, before installing/starting the candidate.
"$ANDROID_HOME/platform-tools/adb" -s emulator-5562 shell wm size 1080x1920
"$ANDROID_HOME/platform-tools/adb" -s emulator-5562 shell wm density 400
ADB="$ANDROID_HOME/platform-tools/adb" python3 docker/android-matrix-device.py \
  --api 35 --serial emulator-5562 --apk /private/candidate.apk \
  --update-apk /private/newer-same-certificate.apk --tests /private/matrix-tests.apk --fixture /private/widget-fixture.json \
  --output /private/matrix-results/api35
```

The fixture must also serve `/downloads/android.json` and a strictly newer same-certificate APK
matching its version, package, size and checksum. `docker/android-matrix-ci.sh` builds this
throwaway upgrade using the `bokydoVersionCode`/`bokydoVersionName` Gradle overrides, mounts it
read-only under the fixture's static downloads directory, and never publishes it. The test uses
a432dp display and grants install-from-this-app permission on the disposable emulator; Android's
actual update confirmation remains part of the UI flow.

Prepare the fresh loopback fixture with `android-widgets-fixture.mjs`, as above. Its account is
`widget-fixture`, and its credentials are deliberately public test data. Each matrix row resets
only that fixture's project task and daily habit. Use a fresh AVD per Android version; the runner
waits for boot and verifies the emulator's API before installing. `--reuse-installed` avoids
reinstallation on a retry only after comparing both installed APK hashes with the supplied files.
The runner requires root on the disposable AOSP emulator and restricts both IPv4 and IPv6 egress
to loopback, including redirected WebView resources. Host API requests reject redirects. It
verifies the fixture username and project ownership before changing fixture records. The browser
clears retained cookies and checks the consent page's signed-in username before approving. Keep its output directory private:
raw instrumentation and system logs are diagnostic artifacts. The runner emits a sanitized
`result.json` with the APK digest, OS fingerprint and verified outcomes only after every check passes.
An earlier success marker is removed at the start of a rerun, and the new marker is published
atomically. Widget checks verify list headers and exclude unrelated fixture tasks; host recreation
retains widget IDs and configuration. Successful runs explicitly tear down the external widget host.

The helper browser submits the real login/consent pages on `http://127.0.0.1:18090` and forwards
the real OAuth redirect to the release app. Instrumentation selects this external browser for the
app's real authorization intent; Android's default-browser selection is outside this test. It does
not inject a session, bypass PKCE or replace
token exchange. This covers OAuth integration with a controlled WebView browser, rather than
Chrome/Brave-specific UI. The widget host runs under the test APK's separate UID and uses real
framework AppWidgetHost views and PendingIntents. Both activities are absent from the release APK.

Hardware acceleration is recommended. A software-only host may need Android's
[`ro.hw_timeout_multiplier`](https://android.googlesource.com/platform/frameworks/base/+/android16-qpr2-release/core/java/android/os/Build.java)
to avoid the OS watchdog killing its own framework during boot. Record any such adjustment with
results; those runs establish functional compatibility, not startup speed or ANR performance.
Stock AOSP emulators also do not reproduce Xiaomi HyperOS firmware or launcher behavior.

### Hardware-accelerated CI

`.github/workflows/android-device-matrix.yml` runs this matrix on disposable KVM-enabled Linux
runners. `docker/android-matrix-ci.sh` builds an optimized release and signs it and the test APK
with a temporary CI key. The personal release key is never read or uploaded. Each job starts
its own fresh loopback server, fixture account and emulator; cleanup destroys them afterwards.
Only sanitized JSON results, cold-start outcomes and failure screenshots of the
throwaway fixture UI are uploaded.

Optional repository variables `BOKYDO_RELEASE_APK_URL` and `BOKYDO_RELEASE_APK_SHA256` pin a public
HTTPS release artifact. When configured, every version also installs that exact APK and checks
three fresh cold starts before replacing the disposable emulator's installation with the CI
candidate. `payload-comparison.json` compares every non-signature ZIP entry, including DEX,
resources, manifest and AndroidX/Kotlin metadata. `identicalPayload: true` establishes that the
functional candidate contains the same app payload despite its temporary signing certificate.
Newer source can legitimately differ: then functional results cover the source candidate only,
and the published artifact's coverage remains its separate cold-start check. An APK download
with the wrong pinned SHA always fails. Without both variables, only the source candidate is tested.

The CI matrix uses default AOSP images for API 34/35 and the official Google APIs image for
API 36. The latter replaces the older default API 36 image whose bundled WebView crashes in
`partition_alloc_support.cc` inside the private fixture browser before login. Functional tests
still block all non-loopback traffic, including Google services. The OS fingerprint in each
result identifies the image actually tested; OEM firmware and default-browser UI remain outside
this coverage.
