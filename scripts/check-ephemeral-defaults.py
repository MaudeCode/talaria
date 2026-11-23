#!/usr/bin/env python3
"""Fail when a TalariaKit package test opens a `UserDefaults` suite outside `UserDefaults.ephemeral` (TAL-2711).

A plain-named suite leaves `~/Library/Preferences/<suite>.plist` on the Mac that runs `swift test`:
`removePersistentDomain(forName:)` keeps the file, and cfprefsd writes a deleted one back.
`Support/EphemeralDefaults.swift` names each suite by a path in the process's temporary directory and deletes that
directory when the test bundle finishes, so it is the only file that may call `UserDefaults(suiteName:)`, apart from
calls that open the real app group through an `appGroupIdentifier`."""

import argparse
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
TESTS = Path("app/TalariaKit/Tests")
HELPER = TESTS / "TalariaKitTests/Support/EphemeralDefaults.swift"
CALL = re.compile(r"UserDefaults\(\s*suiteName:")


def argument(text, start):
    """The call's argument list from its opening parenthesis, matched by balance so a one-line call ends at its own
    closing parenthesis."""
    depth = 0
    for index in range(start, len(text)):
        if text[index] == "(":
            depth += 1
        elif text[index] == ")":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return text[start:]


def violations(root=ROOT):
    found = []
    for path in sorted((root / TESTS).rglob("*.swift")):
        relative = path.relative_to(root)
        if relative == HELPER:
            continue
        text = path.read_text()
        for match in CALL.finditer(text):
            if "appGroupIdentifier" in argument(text, text.index("(", match.start())):
                continue
            line = text.count("\n", 0, match.start()) + 1
            found.append(f"{relative}:{line}: open test defaults with UserDefaults.ephemeral(_:); "
                         "UserDefaults(suiteName:) leaves a plist in ~/Library/Preferences")
    return found


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    found = violations()
    for violation in found:
        print(violation, file=sys.stderr)
    if found:
        return 1
    print(f"TalariaKit tests open UserDefaults suites only through {HELPER.name}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
