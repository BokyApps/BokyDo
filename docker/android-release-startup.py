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
command("logcat", "-b", "crash", "-c")
for attempt in range(3):
    command("shell", "am", "force-stop", package)
    started = command("shell", "am", "start", "-n", f"{package}/.MainActivity")
    assert "Error:" not in started, started
    # ActivityManager may queue process creation after am-start returns, especially under
    # software emulation. Distinguish that delay from a process which actually exited.
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        process = subprocess.run(
            [adb, "-s", serial, "shell", "pidof", package], capture_output=True, text=True,
            timeout=15,
        ).stdout.strip()
        crashes = command("logcat", "-b", "crash", "-d")
        assert not re.search(r"Process: com\.bokyapps\.bokydo(?:,|$)", crashes), crashes
        if process:
            break
        time.sleep(1)
    else:
        raise AssertionError("Release process was not created within 90 seconds")
    print(f"Cold start {attempt + 1}: process created", flush=True)
    # Keep the ten one-second liveness probes on-device, avoiding a new adb transport
    # and remote shell for every probe on a software emulator.
    watched = subprocess.run(
        [adb, "-s", serial, "shell",
         f"for n in 1 2 3 4 5 6 7 8 9 10; do pidof {package} >/dev/null || exit 12; sleep 1; done"],
        capture_output=True, text=True, timeout=90,
    )
    if watched.returncode:
        def diagnostic(*parts):
            try:
                return command(*parts, timeout=15)
            except (AssertionError, subprocess.TimeoutExpired) as error:
                return f"Diagnostic unavailable: {error}"
        crash = diagnostic("logcat", "-b", "crash", "-d")
        exits = diagnostic("shell", "dumpsys", "activity", "exit-info", package)
        raise AssertionError(
            f"Release liveness probe failed on cold start {attempt + 1} "
            f"(exit {watched.returncode}):\n{watched.stdout}\n{watched.stderr}"
            f"\nCrash buffer:\n{crash}\nProcess exit history:\n{exits}"
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
    assert not re.search(r"Process: com\.bokyapps\.bokydo(?:,|$)", crashes), crashes
print("PASS: signed release survives three cold starts and renders a usable screen")
