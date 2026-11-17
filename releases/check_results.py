#!/usr/bin/env python3
"""Require exactly the successful/skipped jobs selected by the release plan."""

import argparse
import json
import os


# Each changed component's suite: its job in this run and the prepare output naming main CI's passed run of it.
SUITES = {"app": ("app-hosted-tests", "hosted_tests"), "web": ("web-tests", "web_tests"), "relay": ("relay-tests", "relay_tests")}


def check_suite(needs, component, changed):
    """Every release that ships a component, dry runs included, needs its suite passed on the exact source (TAL-877):
    either prepare found main CI's passed suite there and this run skipped it, or found none and this run's suite
    succeeded (TAL-1550, TAL-2396). An unchanged component runs no suite."""
    job, output = SUITES[component]
    url = needs["prepare"]["outputs"].get(output, "")
    suite = needs.get(job, {}).get("result")
    if not changed:
        if url or suite != "skipped":
            raise ValueError(f"{job} must be skipped")
        return
    if url.startswith("https://github.com/MaudeCode/talaria/actions/runs/") and suite == "skipped":
        return
    if not url and suite == "success":
        return
    raise ValueError(f"{job} must reuse main CI's passed suite or succeed (reused {url!r}, {job} {suite})")


def check(needs, stage, dry_run):
    # agent-release checks each supported Agent release in its own job; agent requires that they covered them all.
    required = ["prepare", "contracts", "component-contracts", "agent-release", "agent"] if stage == "build" else ["prepare", "build-gate"]
    for name in required:
        if needs.get(name, {}).get("result") != "success":
            raise ValueError(f"required job {name} did not succeed")
    flags = needs["prepare"]["outputs"]
    # The feedback bridge image builds and publishes exactly when Relay does.
    for component, selection in (("app", "app"), ("web", "web"), ("relay", "relay"), ("bridge", "relay")):
        flag = flags.get(selection + "_changed")
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
        if stage == "build" and component != "bridge":
            check_suite(needs, component, flag == "true")
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
