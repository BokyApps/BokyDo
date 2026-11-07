#!/usr/bin/env bash
# Disposable, hardware-accelerated CI only. Never reads the personal release signing key.
set -euo pipefail
: "${ANDROID_HOME:?Android SDK required}"
: "${RUNNER_TEMP:?Run on a disposable CI runner}"
: "${MATRIX_API:?Set MATRIX_API to 34, 35 or 36}"
case "$MATRIX_API" in 34|35|36) ;; *) exit 2 ;; esac
# API36's default image (BE2A.250530.026.D1) crashes its WebView in
# partition_alloc_support.cc before login. Use the newer official Google APIs image;
# the functional runner still blocks all non-loopback network traffic.
image_tag=default
if [ "$MATRIX_API" = 36 ]; then image_tag=google_apis; fi
system_image="system-images;android-$MATRIX_API;$image_tag;x86_64"
test -r /dev/kvm && test -w /dev/kvm
export JAVA_HOME="${JAVA_HOME_17_X64:?JDK 17 required}"
export ADB="$ANDROID_HOME/platform-tools/adb"
export BOKYDO_ANDROID_SERIAL=emulator-5562
task_tmp=$(mktemp -d "$RUNNER_TEMP/bokydo-matrix.XXXXXX")
# Current SDK tools and the emulator can choose different default preference directories.
# Pin both to this runner's disposable directory rather than relying on HOME/XDG defaults.
export ANDROID_USER_HOME="$task_tmp/android-user"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
mkdir -p "$ANDROID_AVD_HOME"
output="$PWD/android-matrix-results/api$MATRIX_API"
mkdir -p "$output"
chmod 700 "$output"
compose=(docker compose -p bokydo-android-matrix -f compose.yml -f "$task_tmp/compose.yml")
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -f "$task_tmp/emulator.log" ]; then
    echo 'Android emulator diagnostics:'
    tail -120 "$task_tmp/emulator.log"
  fi
  "$ADB" -s "$BOKYDO_ANDROID_SERIAL" emu kill >/dev/null 2>&1 || true
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
  'platforms;android-36' 'build-tools;36.0.0' 'emulator' \
  "$system_image" >/dev/null
printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
  --name bokydo-matrix --package "$system_image"
test -f "$ANDROID_AVD_HOME/bokydo-matrix.ini"
"$ANDROID_HOME/emulator/emulator" -list-avds | grep -Fx bokydo-matrix
"$ANDROID_HOME/emulator/emulator" -avd bokydo-matrix -port 5562 -no-window -no-audio \
  -no-boot-anim -no-snapshot -accel on -gpu swiftshader_indirect -feature -Vulkan \
  -cores 2 -memory 2560 > "$task_tmp/emulator.log" 2>&1 &
emulator_pid=$!
for attempt in {1..180}; do
  if ! kill -0 "$emulator_pid" 2>/dev/null; then
    echo 'Emulator exited before connecting to ADB.'
    exit 1
  fi
  if [ "$("$ADB" -s "$BOKYDO_ANDROID_SERIAL" get-state 2>/dev/null || true)" = device ]; then break; fi
  sleep 1
done
timeout 10 "$ADB" -s "$BOKYDO_ANDROID_SERIAL" wait-for-device
for attempt in {1..240}; do
  if [ "$("$ADB" -s "$BOKYDO_ANDROID_SERIAL" shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; then break; fi
  sleep 1
done
test "$("$ADB" -s "$BOKYDO_ANDROID_SERIAL" shell getprop sys.boot_completed | tr -d '\r')" = 1
# adbd restarts when switching to root; recent images can close the transport before
# the root command receives its reply. Recover that bounded startup race, then require
# the actual device UID rather than treating a successful request as proof of root.
root_ready=false
for attempt in {1..6}; do
  timeout 15 "$ADB" -s "$BOKYDO_ANDROID_SERIAL" root || true
  if timeout 15 "$ADB" -s "$BOKYDO_ANDROID_SERIAL" wait-for-device; then
    if [ "$(timeout 10 "$ADB" -s "$BOKYDO_ANDROID_SERIAL" shell id -u 2>/dev/null | tr -d '\r')" = 0 ]; then
      root_ready=true
      break
    fi
  fi
  sleep 1
done
if [ "$root_ready" != true ]; then
  echo 'Disposable emulator did not become root after bounded ADB recovery.' >&2
  exit 1
fi
"$ADB" -s "$BOKYDO_ANDROID_SERIAL" shell settings put global window_animation_scale 0
"$ADB" -s "$BOKYDO_ANDROID_SERIAL" shell settings put global transition_animation_scale 0
"$ADB" -s "$BOKYDO_ANDROID_SERIAL" shell settings put global animator_duration_scale 0
"$ADB" -s "$BOKYDO_ANDROID_SERIAL" shell input keyevent KEYCODE_WAKEUP
"$ADB" -s "$BOKYDO_ANDROID_SERIAL" shell wm dismiss-keyguard
# Configure the phone-sized test display before installing or launching either APK.
# Changing density immediately before a cold start can asynchronously restart its process.
"$ADB" -s "$BOKYDO_ANDROID_SERIAL" shell wm size 1080x1920
"$ADB" -s "$BOKYDO_ANDROID_SERIAL" shell wm density 400

apps/android/gradlew -p apps/android --no-daemon --max-workers=2 \
  -Dorg.gradle.jvmargs=-Xmx1600m :app:assembleRelease :app:assembleDebugAndroidTest \
  -PreleaseMatrixSmoke=true
tools="$ANDROID_HOME/build-tools/36.0.0"
unsigned=apps/android/app/build/outputs/apk/release/app-release-unsigned.apk

# This key exists only on this throwaway runner, and neither it nor either signed APK is uploaded.
keytool -genkeypair -noprompt -keystore "$task_tmp/test.p12" -storetype PKCS12 \
  -storepass disposable-ci-only -keypass disposable-ci-only -alias matrix \
  -keyalg RSA -keysize 2048 -validity 1 -dname 'CN=BokyDo disposable CI'
for kind in app tests; do
  input="$unsigned"
  if [ "$kind" = tests ]; then
    input=apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
  fi
  "$tools/zipalign" -f -P 16 4 "$input" "$task_tmp/$kind-aligned.apk"
  "$tools/apksigner" sign --ks "$task_tmp/test.p12" --ks-key-alias matrix \
    --ks-pass pass:disposable-ci-only --out "$task_tmp/$kind.apk" "$task_tmp/$kind-aligned.apk"
done

if [ -n "${BOKYDO_RELEASE_APK_URL:-}${BOKYDO_RELEASE_APK_SHA256:-}" ]; then
  : "${BOKYDO_RELEASE_APK_URL:?Set both published-release variables}"
  : "${BOKYDO_RELEASE_APK_SHA256:?Set both published-release variables}"
  [[ "$BOKYDO_RELEASE_APK_SHA256" =~ ^[a-f0-9]{64}$ ]]
  curl --fail --location --proto '=https' --proto-redir '=https' --max-redirs 5 \
    "$BOKYDO_RELEASE_APK_URL" -o "$task_tmp/published.apk"
  printf '%s  %s\n' "$BOKYDO_RELEASE_APK_SHA256" "$task_tmp/published.apk" | sha256sum -c
  python3 docker/android-apk-payload.py "$task_tmp/published.apk" "$task_tmp/app.apk" \
    --report "$output/payload-comparison.json" --allow-different
else
  echo 'No published APK configured: this run covers the minified source candidate only.'
fi

# Build a newer version from the same source, signed with the same disposable key.
# The first candidate remains the exact payload compared with the personal release above.
base_code=$("$tools/aapt" dump badging "$task_tmp/app.apk" | sed -n "s/.*versionCode='\\([0-9]*\\)'.*/\\1/p" | head -1)
base_version=$("$tools/aapt" dump badging "$task_tmp/app.apk" | sed -n "s/.*versionName='\\([^']*\\)'.*/\\1/p" | head -1)
update_code=$((base_code + 1))
update_version="$base_version-update-test"
apps/android/gradlew -p apps/android --no-daemon --max-workers=2 \
  -Dorg.gradle.jvmargs=-Xmx1600m -PbokydoVersionCode="$update_code" \
  -PbokydoVersionName="$update_version" :app:assembleRelease
"$tools/zipalign" -f -P 16 4 "$unsigned" "$task_tmp/update-aligned.apk"
"$tools/apksigner" sign --ks "$task_tmp/test.p12" --ks-key-alias matrix \
  --ks-pass pass:disposable-ci-only --out "$task_tmp/update.apk" "$task_tmp/update-aligned.apk"
mkdir "$task_tmp/downloads"
chmod 755 "$task_tmp/downloads"
cp "$task_tmp/update.apk" "$task_tmp/downloads/bokydo-matrix-update.apk"
python3 - "$task_tmp/downloads" "$update_code" "$update_version" <<'PYUPDATE'
import hashlib,json,sys
from pathlib import Path
directory=Path(sys.argv[1]);apk=directory/'bokydo-matrix-update.apk'
metadata={'version':sys.argv[3],'versionCode':int(sys.argv[2]),'url':'/downloads/'+apk.name,
          'minAndroid':'8.0','minSdk':26,'sizeBytes':apk.stat().st_size,
          'sha256':hashlib.sha256(apk.read_bytes()).hexdigest()}
(directory/'android.json').write_text(json.dumps(metadata)+'\n')
PYUPDATE
chmod 644 "$task_tmp/downloads/"*
export BOKYDO_MATRIX_DOWNLOADS="$task_tmp/downloads"

cat > "$task_tmp/compose.yml" <<'YAML'
services:
  app:
    ports: !override
      - '127.0.0.1:18090:8080'
    volumes:
      - '${BOKYDO_MATRIX_DOWNLOADS}:/app/public/downloads:ro'
YAML
"${compose[@]}" build app
"${compose[@]}" up -d
for attempt in {1..120}; do
  if curl -fsS http://127.0.0.1:18090/readyz >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:18090/readyz >/dev/null
npm install --prefix "$task_tmp/playwright" --no-audit --no-fund --ignore-scripts playwright-core@1.64.1
NODE_PATH="$task_tmp/playwright/node_modules" \
  BOKYDO_TEST_BASE_URL=http://127.0.0.1:18090 \
  BOKYDO_WIDGET_FIXTURE_PATH="$task_tmp/fixture.json" \
  node docker/android-widgets-fixture.mjs

if [ -f "$task_tmp/published.apk" ]; then
  "$ADB" -s "$BOKYDO_ANDROID_SERIAL" install --no-incremental "$task_tmp/published.apk"
  python3 docker/android-release-startup.py | tee "$output/published-startup.txt"
  # No account was created here; replace only the disposable emulator's fresh install.
  "$ADB" -s "$BOKYDO_ANDROID_SERIAL" uninstall com.bokyapps.bokydo
fi
python3 docker/android-matrix-device.py --api "$MATRIX_API" \
  --apk "$task_tmp/app.apk" --tests "$task_tmp/tests.apk" --update-apk "$task_tmp/update.apk" \
  --fixture "$task_tmp/fixture.json" --output "$output"
