#!/usr/bin/env python3
"""Split the XCTest classes into N deterministic shards and print one shard's xcodebuild selection.

Classes are discovered from the target sources and assigned greedily, heaviest first, to the lightest
shard using app/ci/test-shard-weights.json; a class missing from that file gets its target's default
weight. The last shard selects whole targets and skips every class the other shards own, so a class
the source scan misses still runs exactly once. Output is one xcodebuild option per line.

Classes in DEVICE_CLASSES never run on a shard's own iPhone: the last shard owns them, and --devices prints the
simulator each runs on and its identifiers, one tab-separated line per simulator.
"""

import argparse
import json
from pathlib import Path
import re
import subprocess
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
# Classes whose tests skip themselves on the shards' iPhone 17, keyed to the pattern a simulator's name must match:
# RegularWidthNavigationUITests needs the iPad idiom, SizeClassRoundTripUITests a Pro Max name. Every selection skips
# them; the catch-all shard runs them on a matching simulator of the hosted image after its own tests, and
# scripts/test-ios on a matching local one, where the suite's no-skip rule holds as everywhere else (TAL-471).
DEVICE_CLASSES = {
    "TalariaUITests/RegularWidthNavigationUITests": "^iPad",
    "TalariaUITests/SizeClassRoundTripUITests": "Pro Max",
}
# Each destination simulator costs the catch-all this long before its first test: boot, install and launch (about
# 250 s for the iPad in UI suite run 37608067616). The plan charges it up front so the other shards take more classes.
DESTINATION_SETUP_SECONDS = 250.0
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


def assign(items, shards, weights, loads=None):
    """Greedy longest-first assignment onto the given starting loads. Ties break by name and index."""
    buckets = [[] for _ in range(shards)]
    loads = list(loads or [0.0] * shards)
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
        options += [f"-only-testing:{item}" for item in buckets[shard] if item not in DEVICE_CLASSES]
    return options + [f"-skip-testing:{item}" for item in (*SKIPPED, *DEVICE_CLASSES)]


def shard_devices(shard, buckets):
    """The destination classes this shard runs after its own tests."""
    return [item for item in buckets[shard] if item in DEVICE_CLASSES]


def scoped(identifiers):
    """xcodebuild options for a scoped run's own simulator: destination classes run on theirs instead."""
    own = [item for item in identifiers if not any(item == cls or item.startswith(cls + "/") for cls in DEVICE_CLASSES)]
    covered = [cls for cls in DEVICE_CLASSES if cls.split("/", 1)[0] in own]
    return [f"-only-testing:{item}" for item in own] + [f"-skip-testing:{cls}" for cls in covered]


def simulator(pattern, devices, runtime=""):
    """The first shut-down iOS simulator whose name matches, newest runtime first. A booted one belongs to another
    run, and the pool never leases a booted device."""
    runtimes = [key for key in devices["devices"]
                if key.startswith("com.apple.CoreSimulator.SimRuntime.iOS-") and runtime in ("", key)]
    for key in sorted(runtimes, key=lambda key: [int(part) for part in key.rsplit("iOS-", 1)[1].split("-")], reverse=True):
        matches = [device for device in devices["devices"][key]
                   if re.search(pattern, device["name"]) and device.get("state") == "Shutdown"]
        for device in sorted(matches, key=lambda device: device["name"]):
            return device["udid"]
    raise LookupError(f"No shut-down iOS simulator's name matches {pattern!r}"
                      f"{' on ' + runtime if runtime else ''}; shut down a booted one or create one with `xcrun simctl create`.")


def device_runs(identifiers, devices, runtime=""):
    """[(simulator, identifiers)] for the destination classes these identifiers select, in DEVICE_CLASSES order."""
    runs = {}
    for cls, pattern in DEVICE_CLASSES.items():
        chosen = [cls] if cls.split("/", 1)[0] in identifiers or cls in identifiers else \
            [item for item in identifiers if item.startswith(cls + "/")]
        if chosen:
            runs.setdefault(simulator(pattern, devices, runtime), []).extend(chosen)
    return list(runs.items())


def plan(shards, targets, weights=None, app=APP):
    weights = weights or json.loads(WEIGHTS.read_text())
    skipped_classes = {item for item in SKIPPED if item.count("/") == 1}
    items = [item for item in discover(app, targets, weights["classes"]) if item not in skipped_classes]
    destinations = [item for item in DEVICE_CLASSES if item in items]
    # The catch-all always selects tests of its own, so a shard never runs destination classes alone.
    start = [0.0] * shards
    start[-1] = sum(weight_of(item, weights) for item in destinations) + \
        DESTINATION_SETUP_SECONDS * len({DEVICE_CLASSES[item] for item in destinations})
    buckets, loads = assign([item for item in items if item not in destinations], shards, weights, start)
    buckets[-1] = sorted(buckets[-1] + destinations)
    return buckets, loads


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--shards", type=int)
    parser.add_argument("--shard", type=int, help="print this shard's xcodebuild options")
    parser.add_argument("--targets", default=",".join(TARGETS), help="comma-separated test targets to split")
    parser.add_argument("--only-testing", nargs="+", metavar="IDENTIFIER", help="a scoped run's identifiers instead of a shard")
    parser.add_argument("--devices", action="store_true", help="print each destination simulator and its identifiers")
    parser.add_argument("--runtime", default="", help="find destination simulators on this runtime identifier only")
    args = parser.parse_args()
    targets = tuple(args.targets.split(","))
    if args.only_testing is None and (args.shards is None or args.shards < 1 or not set(targets) <= set(TARGETS)
                                      or (args.shard is not None and not 0 <= args.shard < args.shards)
                                      or (args.devices and args.shard is None)):
        parser.error("invalid --shards, --shard or --targets")
    if args.only_testing is None:
        buckets, loads = plan(args.shards, targets)
    if args.devices:
        identifiers = args.only_testing or shard_devices(args.shard, buckets)
        try:
            runs = device_runs(identifiers, json.loads(subprocess.check_output(
                ["xcrun", "simctl", "list", "devices", "available", "--json"])), args.runtime) if identifiers else []
        except LookupError as error:
            sys.exit(f"error: {error}")
        for device, selected in runs:
            print(device + "\t" + " ".join(selected))
        return
    if args.only_testing is not None:
        options = scoped(args.only_testing)
        if options:
            print("\n".join(options))
        return
    if args.shard is None:
        for index, (bucket, load) in enumerate(zip(buckets, loads)):
            print(f"shard {index}: {load:.1f}s, {len(bucket)} items{' + catch-all' if index == args.shards - 1 else ''}")
            for item in bucket:
                print(f"  {item}")
        return
    print("\n".join(selection(args.shard, buckets, targets)))


if __name__ == "__main__":
    sys.exit(main())
