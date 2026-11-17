#!/usr/bin/env python3
"""Require exactly the successful/skipped jobs selected by the release plan."""

import argparse
import json
import os


# Each component's suite: its job in this run, the prepare output saying main CI already passed it, and the prefix of the
# release-preflight checks that name its main CI jobs (production-cutover.yml lists them).
SUITES = {"app": ("app-hosted-tests", "hosted_tests", "ci.yml: App / App hosted tests"),
          "web": ("web-tests", "web_tests", "ci.yml: web / "),
          "relay": ("relay-tests", "relay_tests", "ci.yml: relay / ")}


def reused(checks):
    """Whether main CI already passed each component's suite on the release source: release-preflight reported every
    one of its named jobs passed (TAL-2396). A suite with no named job, as in a dry run, is not reused."""
    result = {}
    for _, output, prefix in SUITES.values():
        passed = [ok for name, ok in checks.items() if name.startswith(prefix)]
        result[output] = bool(passed) and all(ok is True for ok in passed)
    return result


def check_suite(needs, component, changed):
    """Every release that ships a component, dry runs included, needs its suite passed on the exact source (TAL-877):
    either main CI already passed it there and this run skipped it, or this run's suite succeeded (TAL-1550, TAL-2396).
    An unchanged component runs no suite."""
    job, output, _ = SUITES[component]
    reuse = needs["prepare"]["outputs"].get(output)
    suite = needs.get(job, {}).get("result")
    if not changed:
        if suite != "skipped":
            raise ValueError(f"{job} must be skipped")
        return
    if (reuse, suite) in (("true", "skipped"), ("false", "success")):
        return
    raise ValueError(f"{job} must reuse main CI's passed suite or succeed (reused {reuse!r}, {job} {suite})")


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
    parser.add_argument("stage", choices=("reused", "build", "publication"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.stage == "reused":
        for output, value in reused(json.loads(os.environ.get("CHECKS") or "{}")).items():
            print(f"{output}={str(value).lower()}")
    else:
        check(json.loads(os.environ["RELEASE_NEEDS"]), args.stage, args.dry_run)
