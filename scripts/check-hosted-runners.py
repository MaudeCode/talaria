#!/usr/bin/env python3
"""Fail when a job in the scoped workflows, or in a local reusable workflow they call, can run on a runner
that is not GitHub-hosted for any event, or when those workflows reference the NAS S3 credentials."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
# Widen to every workflow once the release workflows leave the self-hosted runners (TAL-381).
SCOPE = ("pr-ci.yml", "web-verify.yml", "relay-verify.yml", "repository-tooling.yml", "web-docker-smoke.yml",
         "web-docs.yml")
HOSTED = re.compile(r"(?:ubuntu|macos|windows)-[a-z0-9.-]+|ubuntu-slim|xcode-\d+")
NAS_CREDENTIALS = re.compile(r"TALARIA_(?:CI_)?S3_")
LITERAL = re.compile(r"'((?:[^']|'')*)'")
COMPARISON = re.compile(r"(?:==|!=)\s*$")


def load(path):
    # Ruby's standard library parses YAML; Python's does not.
    return json.loads(subprocess.check_output(
        ["ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))", str(path)],
        text=True))


def candidates(label, job):
    """Every label an expression can yield: its non-compared string literals and the matrix values it names."""
    if "${{" not in label:
        return [label]
    found = []
    for match in LITERAL.finditer(label):
        before, after = label[:match.start()], label[match.end():]
        if not COMPARISON.search(before) and not re.match(r"\s*(?:==|!=)", after):
            found.append(match.group(1))
    matrix = (job.get("strategy") or {}).get("matrix") or {}
    for key in re.findall(r"matrix\.([A-Za-z0-9_-]+)", label):
        values = matrix.get(key)
        entries = [*(values if isinstance(values, list) else [values] if values is not None else []),
                   *(entry.get(key) for entry in matrix.get("include", []) if isinstance(entry, dict) and key in entry)]
        found += [value if isinstance(value, str) else json.dumps(value) for value in entries]
    return found or [label]


def runner_labels(job):
    runs_on = job.get("runs-on")
    if isinstance(runs_on, str):
        runs_on = [runs_on]
    if not isinstance(runs_on, list) or not runs_on or not all(isinstance(label, str) for label in runs_on):
        return [json.dumps(runs_on)]  # Groups and unparsed forms are not provably GitHub-hosted.
    return [value for label in runs_on for value in candidates(label, job)]


def violations(root=ROOT, scope=SCOPE):
    workflows = root / ".github/workflows"
    found, pending, seen = [], list(scope), set()
    while pending:
        name = pending.pop(0)
        if name in seen:
            continue
        seen.add(name)
        path = workflows / name
        if not path.is_file():
            found.append(f"{name}: workflow not found")
            continue
        if NAS_CREDENTIALS.search(path.read_text(encoding="utf-8")):
            found.append(f"{name}: references TALARIA_S3_* or TALARIA_CI_S3_* NAS credentials")
        for job_name, job in (load(path).get("jobs") or {}).items():
            uses = job.get("uses")
            if uses:
                if uses.startswith("./.github/workflows/"):
                    pending.append(uses.removeprefix("./.github/workflows/"))
                else:
                    found.append(f"{name}: job {job_name} calls {uses}, which this check cannot follow")
                continue
            for label in runner_labels(job):
                if not HOSTED.fullmatch(label):
                    found.append(f"{name}: job {job_name} can run on {label!r}, which is not a GitHub-hosted runner")
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="repository root to check")
    args = parser.parse_args()
    found = violations(args.root)
    for violation in found:
        print(violation, file=sys.stderr)
    if found:
        return 1
    print(f"Hosted runners only: {', '.join(SCOPE)} and the reusable workflows they call.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
