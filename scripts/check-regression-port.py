#!/usr/bin/env python3
"""Verify the per-case regression port ledger (TAL-245).

``web/docs/architecture/regression-port-cases.tsv`` lists every Python test
case at the ticket's creation commit (``web/tests/test_*.py`` at db3f02679,
enumerated in ``regression-port-baseline.tsv``) with a disposition:

  asserted   a TypeScript test carries the marker ``[py:<file>::<case>]`` in
             its title and asserts the same observable behaviour
  subject    the behaviour is covered by the named TypeScript suite without a
             one-to-one assertion (the ``ref`` column names the suite)
  dropped    no TypeScript counterpart; ``ref`` states why

The baseline manifest is immutable: its SHA-256 is pinned below, so a removed
or edited baseline row fails the check, and the ledger must contain exactly
the manifest's cases (no missing rows, no rows outside the baseline). The
checker also fails when an ``asserted`` row has no marker in any ``*.test.ts``
or ``*.test.tsx`` under ``web/packages``, when a marker in a test has no ledger
row, when a row has an unknown status or an empty ref, or when a case appears
twice. Run: ``python3 scripts/check-regression-port.py [--root DIR]``.
Regenerate the manifest only for a new baseline commit:
``git ls-tree -r --name-only <rev> -- web/tests`` + ``def test_`` extraction,
then update ``BASELINE_SHA256`` in the same change.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

LEDGER = Path("web/docs/architecture/regression-port-cases.tsv")
BASELINE = Path("web/docs/architecture/regression-port-baseline.tsv")
BASELINE_COMMIT = "db3f026797162068e6815a1c284dbd78dd7cb74b"
BASELINE_SHA256 = "a7f7ca0a3e877c4b6414011ea83be0634dcfa2145ebc984d4175981248c9cca7"
TEST_ROOT = Path("web/packages")
STATUSES = {"asserted", "subject", "dropped"}
MARKER_RE = re.compile(r"\[py:([A-Za-z0-9_.-]+\.py)::(test_\w+)\]")


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


def load_baseline(path: Path, expected_sha256: str | None = BASELINE_SHA256) -> tuple[set[tuple[str, str]], list[str]]:
    """The immutable baseline case set; a digest mismatch means the manifest was edited."""
    raw = path.read_bytes()
    errors: list[str] = []
    if expected_sha256 is not None and hashlib.sha256(raw).hexdigest() != expected_sha256:
        errors.append(f"{path}: SHA-256 does not match the pinned baseline digest; the manifest must not change")
    cases: set[tuple[str, str]] = set()
    for lineno, line in enumerate(raw.decode("utf-8").splitlines(), 1):
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) != 2:
            errors.append(f"{path}:{lineno}: expected 2 tab-separated columns, got {len(parts)}")
            continue
        if lineno == 1 and parts[0] == "file":
            continue
        cases.add((parts[0], parts[1]))
    return cases, errors


def collect_markers(root: Path) -> dict[tuple[str, str], list[str]]:
    found: dict[tuple[str, str], list[str]] = {}
    for test in list(root.rglob("*.test.ts")) + list(root.rglob("*.test.tsx")):
        if "node_modules" in test.parts:
            continue
        for match in MARKER_RE.finditer(test.read_text(encoding="utf-8", errors="replace")):
            found.setdefault((match.group(1), match.group(2)), []).append(str(test))
    return found


def check(root: Path, baseline_sha256: str | None = BASELINE_SHA256) -> list[str]:
    ledger = root / LEDGER
    if not ledger.exists():
        return [f"missing ledger {ledger}"]
    baseline = root / BASELINE
    if not baseline.exists():
        return [f"missing baseline manifest {baseline}"]
    rows, errors = load_ledger(ledger)
    cases, baseline_errors = load_baseline(baseline, baseline_sha256)
    errors.extend(baseline_errors)
    for key in sorted(cases - rows.keys()):
        errors.append(f"baseline case {key[0]}::{key[1]} has no ledger row")
    for key in sorted(rows.keys() - cases):
        errors.append(f"ledger row {key[0]}::{key[1]} is not a baseline case")
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
