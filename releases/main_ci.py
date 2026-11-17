#!/usr/bin/env python3
"""Find main CI's passed suites for a release's checks on exactly one commit (TAL-2396, after TAL-1550).

A release never waits for main CI. It reuses a check main CI already passed: a ci.yml push run on main at exactly the
release source whose jobs for that check all completed successfully, whatever its other jobs did and whether or not
the run is still going. Each check names its full suite's jobs, and every one present must have succeeded, so a
partial selection (a suite main CI left out, or a job skipped, failed, cancelled or still running) never counts and
nothing waits for it; the release runs that check itself. Prints `<check>=<job URL or empty>` for $GITHUB_OUTPUT.
Read-only; a lookup error fails rather than reporting "none"."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

REPOSITORY = "MaudeCode/talaria"
POLL = Path(__file__).resolve().parents[1] / "app/ci/gh-api-poll"
# Each check: the pattern of its suite's jobs in a ci.yml run, and the jobs that show main CI ran the full suite. The
# first required job's URL is the evidence the summary records.
CHECKS = {
    # The App's simulator-hosted tests: their join passes only once every shard passed and each class ran once.
    "hosted_tests": (re.compile(r"App / App hosted tests$"), ("App / App hosted tests",)),
    # Web's server suite on every storage backend, its frontend checks and its Playwright shards. The release's Agent
    # gate runs the sidecar suite against every supported Agent release itself.
    "web_tests": (re.compile(r"web / (server \(|frontend / )"),
                  ("web / frontend / checks", "web / frontend / e2e (1/6)", "web / server (json storage, checks)")),
    "relay_tests": (re.compile(r"relay / check$"), ("relay / check",)),
}


def api(path):
    """Every page of one REST listing, with gh-api-poll riding out transient errors."""
    return json.loads(subprocess.check_output([str(POLL), "--paginate", "--slurp", "-H", "Cache-Control: no-cache", path], text=True))


def find(sha, checks):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError(f"expected a full commit SHA, got {sha!r}")
    found = dict.fromkeys(checks, "")
    runs = [run for page in api(f"repos/{REPOSITORY}/actions/workflows/ci.yml/runs?head_sha={sha}&branch=main&event=push&per_page=100")
            for run in page["workflow_runs"]
            if run["head_sha"] == sha and run["head_branch"] == "main" and run["event"] == "push"
            and run["path"] == ".github/workflows/ci.yml"]
    for run in runs:
        if all(found.values()):
            break
        jobs = [job for page in api(f"repos/{REPOSITORY}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100") for job in page["jobs"]]
        for check in checks:
            pattern, required = CHECKS[check]
            suite = [job for job in jobs if pattern.match(job["name"])]
            names = {job["name"] for job in suite}
            if found[check] or not all(name in names for name in required):
                continue
            if all(job["head_sha"] == sha and job["status"] == "completed" and job["conclusion"] == "success" for job in suite):
                found[check] = next(job["html_url"] for job in suite if job["name"] == required[0])
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sha")
    parser.add_argument("checks", nargs="*", choices=sorted(CHECKS))
    args = parser.parse_args()
    found = find(args.sha, args.checks)
    for check, url in found.items():
        print(f"{check}={url}")
        line = f"Reused main CI's passed suite: {url}" if url else "Main CI has not passed it on this commit; this release runs it."
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write(f"- `{check}` on {args.sha}: {line}\n")


if __name__ == "__main__":
    main()
