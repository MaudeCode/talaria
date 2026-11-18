#!/usr/bin/env python3
"""Fail a test run whose tests break the per-test run-time budget (TAL-2403, test-audit rules heavy and oversized).

Reads JUnit XML (vitest, Playwright, pytest) and `xcrun xcresulttool get test-results tests` JSON (App hosted tests).
A test over `budgetSeconds` in scripts/test-durations.json fails unless `overBudget` lists it with its ticket.
A listed key is `suite::test`; it matches a JUnit case whose name ends with the test's title after its describe
blocks, and every parameter of a parametrized pytest case.

Run: python3 scripts/check-test-durations.py REPORT...
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

BUDGET = Path(__file__).with_name("test-durations.json")


def junit(path):
    for case in ET.parse(path).getroot().iter("testcase"):
        yield case.get("classname", ""), case.get("name", ""), float(case.get("time") or 0)


def xcresult(path):
    def visit(node, suite):
        if node.get("nodeType") == "Test Case" and isinstance(node.get("durationInSeconds"), (int, float)):
            yield suite, node["name"].removesuffix("()"), node["durationInSeconds"]
        for child in node.get("children", []):
            yield from visit(child, node["name"] if node.get("nodeType") == "Test Suite" else suite)

    for root in json.loads(Path(path).read_text())["testNodes"]:
        yield from visit(root, "")


def cases(path):
    return xcresult(path) if path.endswith(".json") else junit(path)


def listed(suite, name, over_budget):
    bare = re.sub(r"\[.*\]$", "", name)
    for key in over_budget:
        listed_suite, _, title = key.partition("::")
        if listed_suite == suite and (title in (name, bare) or name.endswith((f" > {title}", f" › {title}"))):
            return True
    return False


def main(paths):
    budget = json.loads(BUDGET.read_text())
    limit, over_budget = budget["budgetSeconds"], budget["overBudget"]
    if not paths:
        print("check-test-durations: no test report given", file=sys.stderr)
        return 1
    measured, failures = 0, []
    for path in paths:
        for suite, name, seconds in cases(path):
            measured += 1
            if seconds > limit and not listed(suite, name, over_budget):
                failures.append(f"  {suite}::{name} took {seconds:.1f} s")
    if not measured:
        print(f"check-test-durations: no test cases in {', '.join(paths)}", file=sys.stderr)
        return 1
    if failures:
        print(f"check-test-durations: {len(failures)} test(s) over the {limit} s per-test budget. Split the test or prove"
              " it at a cheaper layer (test-audit rules heavy and oversized, docs/testing.md):", file=sys.stderr)
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"check-test-durations: {measured} test case(s), none over the {limit} s budget outside the listed ones")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
