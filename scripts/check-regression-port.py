#!/usr/bin/env python3
"""Verify the per-case regression port ledger (TAL-245).

``web/docs/architecture/regression-port-cases.tsv`` lists every Python
regression case at the ticket's merge base with a disposition:

  asserted   a TypeScript test carries the marker ``[py:<file>::<case>]`` in
             its title and asserts the same observable behaviour
  subject    the behaviour is covered by the named TypeScript suite without a
             one-to-one assertion (the ``ref`` column names the suite)
  dropped    no TypeScript counterpart; ``ref`` states why

The checker fails when an ``asserted`` row has no marker in any ``*.test.ts``
or ``*.test.tsx`` under ``web/packages``, when a marker in a test has no ledger
row, when a row has an unknown status or an empty ref, or when a case appears
twice. Run: ``python3 scripts/check-regression-port.py [--root DIR]``.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

LEDGER = Path("web/docs/architecture/regression-port-cases.tsv")
TEST_ROOT = Path("web/packages")
STATUSES = {"asserted", "subject", "dropped"}
MARKER_RE = re.compile(r"\[py:([A-Za-z0-9_.-]+\.py)::(test_[A-Za-z0-9_]+)\]")


def load_ledger(path: Path) -> tuple[dict[tuple[str, str], tuple[str, str]], list[str]]:
    rows: dict[tuple[str, str], tuple[str, str]] = {}
    errors: list[str] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 4:
            errors.append(f"{path}:{lineno}: expected 4 tab-separated columns, got {len(parts)}")
            continue
        file, case, status, ref = (p.strip() for p in parts)
        if lineno == 1 and file == "file":
            continue
        key = (file, case)
        if key in rows:
            errors.append(f"{path}:{lineno}: duplicate case {file}::{case}")
        if status not in STATUSES:
            errors.append(f"{path}:{lineno}: unknown status {status!r} for {file}::{case}")
        if not ref:
            errors.append(f"{path}:{lineno}: empty ref for {file}::{case}")
        rows[key] = (status, ref)
    return rows, errors


def collect_markers(root: Path) -> dict[tuple[str, str], list[str]]:
    found: dict[tuple[str, str], list[str]] = {}
    for test in list(root.rglob("*.test.ts")) + list(root.rglob("*.test.tsx")):
        if "node_modules" in test.parts:
            continue
        for match in MARKER_RE.finditer(test.read_text(encoding="utf-8", errors="replace")):
            found.setdefault((match.group(1), match.group(2)), []).append(str(test))
    return found


def check(root: Path) -> list[str]:
    ledger = root / LEDGER
    if not ledger.exists():
        return [f"missing ledger {ledger}"]
    rows, errors = load_ledger(ledger)
    markers = collect_markers(root / TEST_ROOT)
    for key, (status, _ref) in sorted(rows.items()):
        if status == "asserted" and key not in markers:
            errors.append(f"asserted case {key[0]}::{key[1]} has no [py:...] marker in any TypeScript test")
    for key, tests in sorted(markers.items()):
        if key not in rows:
            errors.append(f"marker {key[0]}::{key[1]} in {', '.join(sorted(set(tests)))} has no ledger row")
        elif rows[key][0] != "asserted":
            errors.append(f"marker {key[0]}::{key[1]} exists but the ledger says {rows[key][0]}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=".", help="repository root (default: cwd)")
    args = parser.parse_args()
    errors = check(Path(args.root))
    for error in errors:
        print(error)
    if errors:
        print(f"regression-port: {len(errors)} problem(s)")
        return 1
    rows, _ = load_ledger(Path(args.root) / LEDGER)
    counts = {s: sum(1 for st, _ in rows.values() if st == s) for s in sorted(STATUSES)}
    print(f"regression-port: {len(rows)} cases ok ({', '.join(f'{k}={v}' for k, v in counts.items())})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
