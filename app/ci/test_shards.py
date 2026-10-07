#!/usr/bin/env python3
"""Split the XCTest classes into N deterministic shards and print one shard's xcodebuild selection.

Classes are discovered from the target sources and assigned greedily, heaviest first, to the lightest
shard using app/ci/test-shard-weights.json; a class missing from that file gets its target's default
weight. The last shard selects whole targets and skips every class the other shards own, so a class
the source scan misses still runs exactly once. Output is one xcodebuild option per line.

The shards run on iPhone 17; classes that need another destination run in one job per device (DEVICES).
--matrix prints the UI suite's jobs as JSON for app-tests.yml.
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
# Owned elsewhere: the scheduled UI Performance workflow (TAL-287).
SKIPPED = (
    "TalariaUITests/SidebarPerformanceUITests",
    "TalariaUITests/LaunchPerformanceUITests",
    "TalariaUITests/TranscriptPerformanceUITests",
    "TalariaUITests/NavigationPerformanceUITests",
)
SHARD_DEVICE = "iPhone 17"
# Classes that skip on the shards' iPhone 17 run on their own device instead (TAL-661).
DEVICES = {
    "iPad Pro 11-inch (M5)": ("TalariaUITests/RegularWidthNavigationUITests",),
    "iPhone 17 Pro Max": ("TalariaUITests/SizeClassRoundTripUITests",),
}
DEVICE_OWNED = tuple(item for items in DEVICES.values() for item in items)
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


def assign(items, shards, weights):
    """Greedy longest-first assignment. Ties break by name and index."""
    buckets = [[] for _ in range(shards)]
    loads = [0.0] * shards
    for item in sorted(set(items), key=lambda item: (-weight_of(item, weights), item)):
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
    return options + [f"-skip-testing:{item}" for item in (*SKIPPED, *DEVICE_OWNED)]


def device_selection(device):
    return [f"-only-testing:{item}" for item in DEVICES[device]]


def owner(identifier):
    """The device whose class the identifier names, or None for the shards."""
    return next((device for device, items in DEVICES.items()
                 for item in items if identifier == item or identifier.startswith(item + "/")), None)


def scoped_selection(only_testing, device):
    """A scoped dispatch's options for one job: the identifiers it owns, and a whole target's device classes."""
    identifiers = only_testing.split()
    if device:
        owned = [item for item in DEVICES[device] if item.split("/", 1)[0] in identifiers]
        owned += [identifier for identifier in identifiers if owner(identifier) == device and identifier not in owned]
        return [f"-only-testing:{item}" for item in owned]
    options = [f"-only-testing:{identifier}" for identifier in identifiers if owner(identifier) is None]
    return options + [f"-skip-testing:{item}" for item in DEVICE_OWNED if item.split("/", 1)[0] in identifiers]


def shard_count(shards):
    """The UI suite's iPhone shard count: 1 to 6, another count runs one."""
    return shards if 1 <= shards <= 6 else 1


def matrix(shards, only_testing):
    """The UI suite's test jobs: its iPhone shards (one when scoped, if any identifier is theirs), then one per device."""
    count = shard_count(shards) if not only_testing else int(bool(scoped_selection(only_testing, None)))
    jobs = [{"shard": index, "device": SHARD_DEVICE, "name": f"shard {index}", "artifact": f"shard-{index}"}
            for index in range(count)]
    return jobs + [{"device": device, "name": device, "artifact": re.sub(r"[^a-z0-9]+", "-", device.lower()).strip("-")}
                   for device in DEVICES if not only_testing or scoped_selection(only_testing, device)]


def plan(shards, targets, weights=None, app=APP):
    weights = weights or json.loads(WEIGHTS.read_text())
    skipped_classes = {item for item in (*SKIPPED, *DEVICE_OWNED) if item.count("/") == 1}
    items = [item for item in discover(app, targets, weights["classes"]) if item not in skipped_classes]
    return assign(items, shards, weights)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--shard", type=int, help="print this shard's xcodebuild options")
    parser.add_argument("--device", choices=DEVICES, help="print this device job's xcodebuild options")
    parser.add_argument("--only-testing", default="", help="a scoped dispatch's space-separated test identifiers")
    parser.add_argument("--matrix", action="store_true", help="print the UI suite's test jobs as JSON")
    parser.add_argument("--targets", default=",".join(TARGETS), help="comma-separated test targets to split")
    args = parser.parse_args()
    if args.matrix:
        print(json.dumps(matrix(args.shards, args.only_testing.strip())))
        return
    if args.only_testing.strip():
        print("\n".join(scoped_selection(args.only_testing, args.device)))
        return
    if args.device:
        print("\n".join(device_selection(args.device)))
        return
    if args.shard is not None:
        args.shards = shard_count(args.shards)
    targets = tuple(args.targets.split(","))
    if args.shards < 1 or not set(targets) <= set(TARGETS) or (args.shard is not None and not 0 <= args.shard < args.shards):
        parser.error("invalid --shards, --shard or --targets")
    buckets, loads = plan(args.shards, targets)
    if args.shard is None:
        for index, (bucket, load) in enumerate(zip(buckets, loads)):
            print(f"shard {index}: {load:.1f}s, {len(bucket)} items{' + catch-all' if index == args.shards - 1 else ''}")
            for item in bucket:
                print(f"  {item}")
        for device, items in DEVICES.items():
            print(f"{device}: {', '.join(items)}")
        return
    print("\n".join(selection(args.shard, buckets, targets)))


if __name__ == "__main__":
    sys.exit(main())
