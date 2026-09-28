#!/usr/bin/env python3
"""Split the XCTest classes into N deterministic shards and print one shard's xcodebuild selection.

Classes are discovered from the target sources and assigned greedily, heaviest first, to the lightest
shard using app/ci/test-shard-weights.json; a class missing from that file gets its target's default
weight. The last shard selects whole targets and skips every class the other shards own, so a class
the source scan misses still runs exactly once. Output is one xcodebuild option per line.
"""

import argparse
import json
from pathlib import Path
import re
import sys

APP = Path(__file__).resolve().parent.parent
WEIGHTS = Path(__file__).resolve().with_name("test-shard-weights.json")
TARGETS = ("TalariaTests", "TalariaUITests")
# Source directories per target. TalariaTests also compiles the TalariaKit package's shared test support, which
# declares base classes such as APIClientTestCase; the package's own tests run with `swift test` (TAL-399).
SOURCES = {"TalariaTests": ("TalariaTests", "TalariaKit/Tests/TalariaKitTests/Support"), "TalariaUITests": ("TalariaUITests",)}
# Owned elsewhere: the scheduled Fuzz Soak (TAL-85) and UI Performance (TAL-287) workflows.
SKIPPED = (
    "TalariaTests/UntrustedInputFuzzSoakTests",
    "TalariaUITests/SidebarPerformanceUITests",
    "TalariaUITests/LaunchPerformanceUITests",
    "TalariaUITests/TranscriptPerformanceUITests",
    "TalariaUITests/NavigationPerformanceUITests",
)
DECLARATION = re.compile(
    r"^[ \t]*(?:@\w+(?:\([^)\n]*\))?\s+)*(?:(?:final|public|internal|private|fileprivate|open|nonisolated)\s+)*"
    r"class\s+(\w+)\s*:\s*(?:\w+\.)?(\w+)", re.MULTILINE)


def discover(app=APP, targets=TARGETS, measured=()):
    """Return "Target/Class" for every leaf XCTestCase subclass, plus base classes measured running tests of their own.

    Unmeasured base classes are left out because most only share setup; any that do hold tests run in the catch-all.
    """
    found = []
    for target in targets:
        bases = {}
        for source in sorted(path for directory in SOURCES[target] for path in (app / directory).rglob("*.swift")):
            bases.update(DECLARATION.findall(source.read_text(encoding="utf-8")))

        def is_test(name, seen=()):
            base = bases.get(name)
            return base == "XCTestCase" or (base in bases and base not in seen and is_test(base, (*seen, name)))

        tests = {name for name in bases if is_test(name)}
        parents = {bases[name] for name in tests}
        found += [f"{target}/{name}" for name in sorted(tests) if name not in parents or f"{target}/{name}" in measured]
    return found


def weight_of(identifier, weights):
    return float(weights["classes"].get(identifier, weights["default"][identifier.split("/", 1)[0]]))


def assign(items, shards, weights, pinned=(), last=()):
    """Greedy longest-first assignment; pinned items go to shard 0 and last items to the last shard first, so the
    greedy pass balances around them. Ties break by name and index."""
    buckets = [[] for _ in range(shards)]
    loads = [0.0] * shards
    for index, fixed in ((0, pinned), (shards - 1, last)):
        for item in fixed:
            buckets[index].append(item)
            loads[index] += weight_of(item, weights)
    for item in sorted(set(items) - set(pinned) - set(last), key=lambda item: (-weight_of(item, weights), item)):
        index = min(range(shards), key=lambda index: (loads[index], index))
        buckets[index].append(item)
        loads[index] += weight_of(item, weights)
    return [sorted(bucket) for bucket in buckets], loads


def selection(shard, buckets, targets):
    """xcodebuild options for one shard; the last shard is the catch-all over whole targets."""
    options = []
    if shard == len(buckets) - 1:
        options += [f"-only-testing:{target}" for target in targets]
        options += [f"-only-testing:{item}" for item in buckets[shard] if item.split("/", 1)[0] not in targets]
        options += [f"-skip-testing:{item}" for index, bucket in enumerate(buckets) if index != shard for item in bucket]
    else:
        options += [f"-only-testing:{item}" for item in buckets[shard]]
    return options + [f"-skip-testing:{item}" for item in SKIPPED]


def plan(shards, targets, extra=(), pinned=(), weights=None, app=APP):
    weights = weights or json.loads(WEIGHTS.read_text())
    skipped_classes = {item for item in SKIPPED if item.count("/") == 1}
    items = [item for item in discover(app, targets, weights["classes"]) if item not in skipped_classes]
    # Tests added outside --targets (the PR launch smoke) run in the last shard, away from shard 0's pinned
    # contract classes and live test.
    return assign(items, shards, weights, pinned, extra)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--shard", type=int, help="print this shard's xcodebuild options")
    parser.add_argument("--targets", default=",".join(TARGETS), help="comma-separated test targets to split")
    parser.add_argument("--add", action="append", default=[], help="also run this test outside --targets, in the last shard")
    parser.add_argument("--pin", action="append", default=[], help="always run this class in shard 0")
    args = parser.parse_args()
    targets = tuple(args.targets.split(","))
    if args.shards < 1 or not set(targets) <= set(TARGETS) or (args.shard is not None and not 0 <= args.shard < args.shards):
        parser.error("invalid --shards, --shard or --targets")
    buckets, loads = plan(args.shards, targets, args.add, args.pin)
    if args.shard is None:
        for index, (bucket, load) in enumerate(zip(buckets, loads)):
            print(f"shard {index}: {load:.1f}s, {len(bucket)} items{' + catch-all' if index == args.shards - 1 else ''}")
            for item in bucket:
                print(f"  {item}")
        return
    print("\n".join(selection(args.shard, buckets, targets)))


if __name__ == "__main__":
    sys.exit(main())
