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
    for _ in range(10):
        time.sleep(1)
        process = subprocess.run(
            [adb, "-s", serial, "shell", "pidof", package], capture_output=True, text=True,
            timeout=15,
        )
        if not process.stdout.strip():
            crash = command("logcat", "-b", "crash", "-d")
            raise AssertionError(f"Release exited on cold start {attempt + 1}:\n{crash}")
    command("shell", "uiautomator", "dump", "/sdcard/bokydo-release-startup.xml")
    xml = command("shell", "cat", "/sdcard/bokydo-release-startup.xml")
    root = ET.fromstring(xml)
    visible = [node.attrib.get("text", "") for node in root.iter("node")]
    expected = os.environ.get("BOKYDO_ANDROID_EXPECT_TEXT", "Server address")
    assert expected in visible, f"Expected usable screen ({expected!r}), got {visible}"
    crashes = command("logcat", "-b", "crash", "-d")
    assert not re.search(r"Process: com\.bokyapps\.bokydo(?:,|$)", crashes), crashes
print("PASS: signed release survives three cold starts and renders a usable screen")
