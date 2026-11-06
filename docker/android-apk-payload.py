"""Compare executable/resource APK payloads independently of ZIP layout and signing blocks."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("published", type=Path)
parser.add_argument("candidate", type=Path)
parser.add_argument("--report", type=Path, required=True)
parser.add_argument("--allow-different", action="store_true", help="Report newer source payloads without asserting release equivalence")
args = parser.parse_args()


def payload(path):
    with zipfile.ZipFile(path) as apk:
        result = {}
        for item in apk.infolist():
            name = item.filename
            # JAR signatures are the only ZIP entries excluded. The v2 signing block is
            # outside the ZIP entries; Kotlin/AndroidX metadata remains part of the check.
            if name == "META-INF/MANIFEST.MF" or (
                name.startswith("META-INF/") and name.count("/") == 1
                and name.endswith((".SF", ".RSA", ".DSA", ".EC"))
            ):
                continue
            assert name not in result, "Duplicate APK entry"
            result[name] = hashlib.sha256(apk.read(item)).hexdigest()
        return result


published, candidate = payload(args.published), payload(args.candidate)
different = sorted(name for name in published.keys() | candidate.keys()
                   if published.get(name) != candidate.get(name))
report = {
    "publishedApkSha256": hashlib.sha256(args.published.read_bytes()).hexdigest(),
    "candidateApkSha256": hashlib.sha256(args.candidate.read_bytes()).hexdigest(),
    "payloadEntries": len(published),
    "identicalPayload": not different,
    "differentEntries": different,
}
args.report.write_text(json.dumps(report, indent=2) + "\n")
if different:
    assert args.allow_different, f"Candidate differs from published APK: {different}"
    print("Source candidate differs from the published release; functional results apply to the source candidate only")
else:
    print(f"PASS: all {len(published)} non-signature APK entries match the published release")
