#!/usr/bin/env python3
"""Classify a Git diff for component CI; unknown/shared paths run all checks."""

import argparse
import subprocess


COMPONENTS = {"app", "web", "relay", "contracts"}
INTERFACES = (
    "app/Talaria/Networking/", "app/Talaria/Models/", "app/Talaria/LiveActivities/",
    "web/api/", "relay/convex/", "contracts/",
)


def affected(paths):
    selected = set()
    for path in paths:
        component = path.split("/", 1)[0]
        if component not in {"app", "web", "relay"} or path.startswith(INTERFACES):
            return COMPONENTS
        selected.add(component)
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        assert affected(["app/Talaria/Features/Chat/ChatView.swift"]) == {"app"}
        assert affected(["web/frontend/src/main.tsx"]) == {"web"}
        assert affected(["relay/tests/crypto.test.ts"]) == {"relay"}
        assert affected(["docs/contributing.md"]) == COMPONENTS
        assert affected(["contracts/session.json"]) == COMPONENTS
        assert affected(["web/api/routes.py"]) == COMPONENTS
        assert affected(["app/Talaria/LiveActivities/TalariaRelay.swift"]) == COMPONENTS
        assert affected(["web/frontend/src/main.tsx", "relay/tests/crypto.test.ts"]) == {"web", "relay"}
        assert affected([".github/workflows/pr-ci.yml"]) == COMPONENTS
        assert affected([]) == set()
        print("CI routing checks passed.")
        return
    if not args.base:
        parser.error("--base is required")
    paths = subprocess.check_output([
        "git", "diff", "--no-renames", "--name-only", "-z", args.base, args.head, "--",
    ]).decode().split("\0")
    selected = affected(filter(None, paths))
    for component in sorted(COMPONENTS):
        print(f"{component}={str(component in selected).lower()}")


if __name__ == "__main__":
    main()
