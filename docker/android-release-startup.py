"""Cold-start smoke for the installed release on a disposable emulator, retaining its data.

BOKYDO_ANDROID_SERIAL=emulator-5562 python3 docker/android-release-startup.py
Install the exact signed release first. A successful am-start response is insufficient.
"""
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET

serial = os.environ.get("BOKYDO_ANDROID_SERIAL", "")
adb = os.environ.get("ADB", "adb")
package = "com.bokyapps.bokydo"
assert serial.startswith("emulator-"), "Use an explicitly selected disposable emulator"


def command(*args, timeout=25):
    result = subprocess.run(
        [adb, "-s", serial, *args], capture_output=True, text=True, timeout=timeout
    )
    assert result.returncode == 0, result.stderr or result.stdout
    return result.stdout


assert command("shell", "getprop", "ro.kernel.qemu").strip() == "1"
assert command("shell", "getprop", "sys.boot_completed").strip() == "1"
package_info = command("shell", "dumpsys", "package", package)
assert not re.search(r"(?:pkgFlags|flags)=\[[^\]]*\bDEBUGGABLE\b", package_info), (
    "Install the signed release APK; debug startup does not exercise shrinking"
)

def failure_details():
    def diagnostic(*parts):
        try:
            return command(*parts, timeout=15)
        except (AssertionError, subprocess.TimeoutExpired) as error:
            return f"Diagnostic unavailable: {error}"
    crash = diagnostic("logcat", "-b", "crash", "-d")
    exits = diagnostic("shell", "dumpsys", "activity", "exit-info", package)
    main = diagnostic("logcat", "-d", "-v", "brief", "-s", "ActivityManager:I",
                      "ActivityTaskManager:I", "AndroidRuntime:E", "libc:E", "DEBUG:E", "*:S")
    details = f"Crash buffer:\n{crash}\nProcess exit history:\n{exits}\nSystem process log:\n{main[-18000:]}"
    return re.sub(r"(?:https?|com\.bokyapps\.bokydo):[^\s]+", "[fixture URL omitted]", details)


command("logcat", "-b", "crash", "-c")
for attempt in range(3):
    command("shell", "am", "force-stop", package)
    try:
        started = command("shell", "am", "start", "-W", "-n", f"{package}/.MainActivity", timeout=90)
        assert "Error:" not in started and "Status: ok" in started, started
    except (AssertionError, subprocess.TimeoutExpired) as error:
        raise AssertionError(f"Activity launch did not complete: {error}\n{failure_details()}") from error
    # Find the launched activity's main process before tracking its identity. Startup
    # bookkeeping can take longer to become visible on a busy software emulator.
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        process = subprocess.run(
            [adb, "-s", serial, "shell", "pidof", package], capture_output=True, text=True,
            timeout=15,
        ).stdout.strip()
        crashes = command("logcat", "-b", "crash", "-d")
        assert not re.search(r"(?:Process|Cmdline): com\.bokyapps\.bokydo(?:,|\s|$)", crashes), crashes
        if process:
            break
        time.sleep(1)
    else:
        raise AssertionError("Release process was not created within 90 seconds")
    assert re.fullmatch(r"\d+", process), f"Expected one main process PID, got {process!r}"
    print(f"Cold start {attempt + 1}: activity launched, process {process}", flush=True)
    # Keep the ten one-second liveness probes on-device, avoiding a new adb transport
    # and remote shell for every probe on a software emulator.
    watched = subprocess.run(
        [adb, "-s", serial, "shell",
         f'for n in 1 2 3 4 5 6 7 8 9 10; do current=$(pidof {package}) || exit 12; [ "$current" = "{process}" ] || {{ echo "Process changed: $current"; exit 13; }}; sleep 1; done'],
        capture_output=True, text=True, timeout=90,
    )
    if watched.returncode:
        raise AssertionError(
            f"Release liveness probe failed on cold start {attempt + 1} "
            f"(exit {watched.returncode}):\n{watched.stdout}\n{watched.stderr}\n{failure_details()}"
        )
    expected = os.environ.get("BOKYDO_ANDROID_EXPECT_TEXT", "Server address")
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        command("shell", "uiautomator", "dump", "/sdcard/bokydo-release-startup.xml", timeout=90)
        xml = command("shell", "cat", "/sdcard/bokydo-release-startup.xml")
        root = ET.fromstring(xml)
        visible = [node.attrib.get("text", "") for node in root.iter("node")]
        if expected in visible:
            break
        time.sleep(1)
    else:
        raise AssertionError(f"Expected usable screen ({expected!r}), got {visible}")
    assert command("shell", "pidof", package).strip(), "Release exited before its screen check"
    print(f"Cold start {attempt + 1}: usable screen", flush=True)
    crashes = command("logcat", "-b", "crash", "-d")
    assert not re.search(r"(?:Process|Cmdline): com\.bokyapps\.bokydo(?:,|\s|$)", crashes), crashes
print("PASS: signed release survives three cold starts and renders a usable screen")
