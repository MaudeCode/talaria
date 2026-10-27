#!/usr/bin/env python3
"""Require exactly the successful/skipped jobs selected by the release plan."""

import argparse
import json
import os


def check_hosted_tests(needs, app_changed):
    """The App's hosted unit tests gate every release that ships the App, dry runs included (TAL-877): either the
    lookup found main CI's successful hosted tests on the exact source and the suite was skipped, or it found none and
    the suite succeeded (TAL-1550). A failed lookup skips the suite and fails here; it never counts as reuse."""
    lookup = needs.get("app-hosted-tests-lookup", {})
    suite = needs.get("app-hosted-tests", {}).get("result")
    if not app_changed:
        if lookup.get("result") != "skipped" or suite != "skipped":
            raise ValueError("app-hosted-tests-lookup and app-hosted-tests must be skipped")
        return
    if lookup.get("result") != "success":
        raise ValueError("app-hosted-tests-lookup did not succeed")
    outputs = lookup.get("outputs", {})
    reused, url = outputs.get("reused"), outputs.get("job_url", "")
    if reused == "true" and url.startswith("https://github.com/MaudeCode/talaria/actions/runs/") and suite == "skipped":
        return
    if reused == "false" and not url and suite == "success":
        return
    raise ValueError(f"app-hosted-tests must reuse main CI's successful run or succeed (reused={reused!r}, app-hosted-tests {suite})")


def check(needs, stage, dry_run):
    # agent-release checks each supported Agent release in its own job; agent requires that they covered them all.
    required = ["prepare", "contracts", "component-contracts", "agent-release", "agent"] if stage == "build" else ["prepare", "build-gate"]
    for name in required:
        if needs.get(name, {}).get("result") != "success":
            raise ValueError(f"required job {name} did not succeed")
    flags = needs["prepare"]["outputs"]
    for component in ("app", "web", "relay"):
        flag = flags.get(component + "_changed")
        if flag not in ("true", "false"):
            raise ValueError("missing component selection")
        if stage == "publication":
            job = component + "-publish"
        elif component == "app":
            job = "app-dry-build" if dry_run else "app-signed-build"
        else:
            job = component + "-build"
        expected = "success" if flag == "true" else "skipped"
        if needs.get(job, {}).get("result") != expected:
            raise ValueError(f"{job} must be {expected}")
        if stage == "build" and component == "app":
            check_hosted_tests(needs, flag == "true")
    if stage == "build":
        inactive = "app-signed-build" if dry_run else "app-dry-build"
        if needs.get(inactive, {}).get("result") != "skipped":
            raise ValueError("unexpected App build mode")
    elif dry_run:
        raise ValueError("dry runs cannot publish")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("build", "publication"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    check(json.loads(os.environ["RELEASE_NEEDS"]), args.stage, args.dry_run)
