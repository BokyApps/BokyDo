# Android release verification (A7a)

How to check that a release APK is really built from the published source: build it twice
and compare. This is also what `.github/workflows/android-reproducible.yml` does in CI.

## Verify a build locally

You need JDK 17+ and the Android SDK (`ANDROID_HOME` set, `~/Android/Sdk` works;
`apps/android/local.properties` with `sdk.dir=` is gitignored). No keystore: a local
release build is unsigned.

```bash
# Two clean checkouts of the same commit, side by side.
git worktree add /tmp/bokydo-a <commit>      # or: git clone <url> /tmp/bokydo-a
git worktree add /tmp/bokydo-b <commit>
for d in /tmp/bokydo-a /tmp/bokydo-b; do
  (cd "$d/apps/android" && ./gradlew --no-daemon :app:assembleRelease)
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

## F-Droid metadata

Lives in `apps/android/fastlane/metadata/android/en-US/` (F-Droid reads
`<subdir>/fastlane/…` when the build recipe names the subdir):

- `title.txt` (≤ 50 chars), `short_description.txt` (≤ 80), `full_description.txt` (≤ 4000)
- `changelogs/<versionCode>.txt` (≤ 500) — add one per release, named by `versionCode`
- `images/icon.png` — the launcher artwork; phone screenshots land once the A2 screens settle

`dependenciesInfo { includeInApk = false }` is set in `app/build.gradle.kts` because
F-Droid's scanner flags Google's encrypted dependency-metadata block.

Keystores, signing and publishing are A7b (blocked by A6 hardening), not this card.
