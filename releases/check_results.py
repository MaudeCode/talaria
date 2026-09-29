#!/usr/bin/env python3
"""Require exactly the successful/skipped jobs selected by the release plan."""

import argparse
import json
import os


def check_ui_suite(needs, app_changed):
    lookup = needs.get("ui-suite-lookup", {})
    suite = needs.get("ui-suite", {}).get("result")
    if not app_changed:
        if lookup.get("result") != "skipped" or suite != "skipped":
            raise ValueError("ui-suite-lookup and ui-suite must be skipped")
        return
    if lookup.get("result") != "success":
        raise ValueError("ui-suite-lookup did not succeed")
    outputs = lookup.get("outputs", {})
    reused, url = outputs.get("reused"), outputs.get("run_url", "")
    if reused == "true" and url.startswith("https://github.com/") and suite == "skipped":
        return
    if reused == "false" and not url and suite == "success":
        return
    raise ValueError(f"ui-suite must reuse a successful run or succeed (reused={reused!r}, ui-suite {suite})")


def check(needs, stage, dry_run):
    required = ["prepare", "contracts", "previous-app-contracts", "component-contracts", "agent"] if stage == "build" else ["prepare", "build-gate"]
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
        # The full unit and UI suite gates every release that ships the App, dry runs included: either the lookup
        # found a successful run on the exact source to reuse and the call was skipped, or the lookup found none and
        # the call succeeded (TAL-408).
        if stage == "build" and component == "app":
            check_ui_suite(needs, flag == "true")
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
