#!/usr/bin/env python3
"""Require exactly the successful/skipped jobs selected by the release plan."""

import argparse
import json
import os


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
        # The full unit and UI suite gates every release that ships the App, dry runs included.
        if stage == "build" and component == "app" and needs.get("ui-suite", {}).get("result") != expected:
            raise ValueError(f"ui-suite must be {expected}")
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
