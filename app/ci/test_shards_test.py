#!/usr/bin/env python3
"""Shard assignment over synthetic test sources."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().with_name("test_shards.py")
spec = importlib.util.spec_from_file_location("test_shards", SCRIPT)
shards = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shards)

WEIGHTS = {"default": {"TalariaTests": 1.0, "TalariaUITests": 40.0},
           "classes": {"TalariaTests/HeavyTests": 30.0, "TalariaTests/UntrustedInputFuzzTests": 5.0,
                       "TalariaUITests/ChatUITests": 90.0, "TalariaUITests/ShareUITests": 60.0}}


class ShardTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="talaria-shards-")
        self.addCleanup(temporary.cleanup)
        self.app = Path(temporary.name)
        unit, ui = self.app / "TalariaTests", self.app / "TalariaUITests"
        (unit / "Nested").mkdir(parents=True)
        ui.mkdir()
        (unit / "A.swift").write_text(
            "import XCTest\n"
            "class APIClientTestCase: XCTestCase {}\n"
            "@MainActor\nfinal class HeavyTests: APIClientTestCase {}\n"
            "@MainActor final class LightTests: XCTestCase, Sendable {}\n"
            "final class Helper {}\n"
            "private final class Recorder: NSObject {}\n"
            "class UntrustedInputFuzzTests: XCTestCase {}\n"
            "final class UntrustedInputFuzzSoakTests: UntrustedInputFuzzTests {}\n")
        (unit / "Nested" / "B.swift").write_text("final class NewUnmeasuredTests: XCTest.XCTestCase {}\n"
                                                 "final class SupportedTests: SharedSupportTestCase {}\n")
        # TalariaTests also compiles the package's shared test support.
        support = self.app / "TalariaKit/Tests/TalariaKitTests/Support"
        support.mkdir(parents=True)
        (support / "Support.swift").write_text("class SharedSupportTestCase: XCTestCase {}\nfinal class MockURLProtocol: URLProtocol {}\n")
        (support.parent / "PackageOnlyTests.swift").write_text("final class PackageOnlyTests: XCTestCase {}\n")
        (ui / "UI.swift").write_text(
            "class TalariaUITestCase: XCTestCase {}\n"
            "final class ChatUITests: TalariaUITestCase {}\n"
            "final class ShareUITests: TalariaUITestCase {}\n"
            "final class BrandNewUITests: TalariaUITestCase {}\n"
            "final class SidebarPerformanceUITests: TalariaUITestCase {}\n")

    def plan(self, count, targets=shards.TARGETS):
        return shards.plan(count, targets, WEIGHTS, self.app)

    def test_discovery_finds_concrete_classes_and_measured_bases(self):
        # Support base classes resolve; package-only tests are not expected in the hosted bundle.
        self.assertEqual(shards.discover(self.app, measured=WEIGHTS["classes"]), [
            "TalariaTests/HeavyTests", "TalariaTests/LightTests", "TalariaTests/NewUnmeasuredTests",
            "TalariaTests/SupportedTests", "TalariaTests/UntrustedInputFuzzSoakTests", "TalariaTests/UntrustedInputFuzzTests",
            "TalariaUITests/BrandNewUITests", "TalariaUITests/ChatUITests", "TalariaUITests/ShareUITests",
            "TalariaUITests/SidebarPerformanceUITests"])

    def test_every_class_lands_in_exactly_one_shard(self):
        expected = {"TalariaTests/HeavyTests", "TalariaTests/LightTests", "TalariaTests/NewUnmeasuredTests",
                    "TalariaTests/SupportedTests", "TalariaTests/UntrustedInputFuzzSoakTests",
                    "TalariaTests/UntrustedInputFuzzTests", "TalariaUITests/BrandNewUITests",
                    "TalariaUITests/ChatUITests", "TalariaUITests/ShareUITests"}
        for count in range(1, 6):
            with self.subTest(count=count):
                buckets, _ = self.plan(count)
                flat = [item for bucket in buckets for item in bucket]
                self.assertEqual(len(flat), len(set(flat)))
                self.assertEqual(set(flat), expected)

    def test_unknown_classes_get_the_target_default_weight(self):
        buckets, loads = self.plan(1)
        self.assertEqual(loads, [30 + 1 + 1 + 1 + 1 + 5 + 40 + 90 + 60])
        self.assertEqual(shards.weight_of("TalariaUITests/BrandNewUITests", WEIGHTS), 40.0)
        self.assertEqual(shards.weight_of("TalariaTests/NewUnmeasuredTests", WEIGHTS), 1.0)
        # Greedy: 90 | 60 | 40, then HeavyTests (30) joins the lightest shard.
        buckets, loads = self.plan(3)
        self.assertEqual(buckets[2][0:2], ["TalariaTests/HeavyTests", "TalariaUITests/BrandNewUITests"])

    def test_output_is_deterministic(self):
        first = [shards.selection(index, self.plan(4)[0], shards.TARGETS) for index in range(4)]
        (self.app / "TalariaTests" / "Z.swift").write_text("// reordering files must not move classes\n")
        self.assertEqual(first, [shards.selection(index, self.plan(4)[0], shards.TARGETS) for index in range(4)])
        command = [sys.executable, str(SCRIPT), "--shards", "4", "--shard", "2"]
        self.assertEqual(subprocess.check_output(command), subprocess.check_output(command))

    def test_skips_apply_to_every_shard(self):
        buckets, _ = self.plan(3)
        for index in range(3):
            options = shards.selection(index, buckets, shards.TARGETS)
            for skipped in shards.SKIPPED:
                self.assertIn(f"-skip-testing:{skipped}", options)
                self.assertNotIn(f"-only-testing:{skipped}", options)
        # The live Web contract test moved to the TalariaKit package job (TAL-399).
        self.assertFalse(any("APIClientSessionListTests" in skipped for skipped in shards.SKIPPED))

    def test_catch_all_shard_covers_unlisted_classes(self):
        buckets, _ = self.plan(2)
        last = shards.selection(1, buckets, shards.TARGETS)
        self.assertEqual(last[:2], ["-only-testing:TalariaTests", "-only-testing:TalariaUITests"])
        for item in buckets[0]:
            self.assertIn(f"-skip-testing:{item}", last)
        first = shards.selection(0, buckets, shards.TARGETS)
        self.assertFalse(any(option in ("-only-testing:TalariaTests", "-only-testing:TalariaUITests") for option in first))

    def test_destination_classes_run_only_on_their_simulator(self):
        # RegularWidthNavigationUITests needs an iPad and SizeClassRoundTripUITests a Pro Max; on the shards' iPhone
        # they skip, which fails the suite (TAL-471). The catch-all shard owns them and every selection skips them.
        (self.app / "TalariaUITests" / "Destinations.swift").write_text(
            "final class RegularWidthNavigationUITests: TalariaUITestCase {}\n"
            "final class SizeClassRoundTripUITests: TalariaUITestCase {}\n")
        destinations = ["TalariaUITests/RegularWidthNavigationUITests", "TalariaUITests/SizeClassRoundTripUITests"]
        for count in range(1, 5):
            with self.subTest(count=count):
                buckets, _ = self.plan(count)
                for index in range(count):
                    options = shards.selection(index, buckets, shards.TARGETS)
                    self.assertTrue(any(option.startswith("-only-testing:") for option in options))
                    for item in destinations:
                        self.assertIn(f"-skip-testing:{item}", options)
                        self.assertNotIn(f"-only-testing:{item}", options)
                self.assertEqual(list(shards.DEVICE_CLASSES), destinations)
                self.assertEqual([item for item in buckets[-1] if item in destinations], destinations)
                self.assertFalse(any(item in destinations for bucket in buckets[:-1] for item in bucket))
                self.assertEqual([shards.shard_devices(index, buckets) for index in range(count)],
                                 [*([[]] * (count - 1)), destinations])

    def test_destination_classes_find_a_matching_simulator(self):
        ipad, pro_max, booted = "IPAD", "PROMAX", "BOOTED"
        devices = {"devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [dict(name="iPhone Duo", udid="DUO", state="Shutdown")],
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
                dict(name="iPhone 17", udid="PHONE", state="Shutdown"),
                dict(name="iPad Air 13-inch (M4)", udid=booted, state="Booted"),
                dict(name="iPad Pro 11-inch (M5)", udid=ipad, state="Shutdown"),
                dict(name="iPhone 18 Pro Max", udid=pro_max, state="Shutdown")],
            "com.apple.CoreSimulator.SimRuntime.tvOS-27-0": [dict(name="iPad TV", udid="TV", state="Shutdown")]}}
        regular, rotating = shards.DEVICE_CLASSES
        # A whole target selects both classes; a method selects itself; other selections select none.
        self.assertEqual(shards.device_runs(["TalariaUITests", "TalariaTests/Unit"], devices),
                         [(ipad, [regular]), (pro_max, [rotating])])
        self.assertEqual(shards.device_runs([f"{regular}/testOne", f"{regular}/testTwo"], devices),
                         [(ipad, [f"{regular}/testOne", f"{regular}/testTwo"])])
        self.assertEqual(shards.device_runs(["TalariaTests", "TalariaUITests/ChatUITests"], devices), [])
        # A booted simulator is taken only when nothing else matches; a missing model fails clearly.
        self.assertEqual(shards.simulator("^iPad", {"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
            dict(name="iPad Air 13-inch (M4)", udid=booted, state="Booted")]}}), booted)
        with self.assertRaisesRegex(LookupError, "Pro Max"):
            shards.device_runs([rotating], {"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-27-1": []}})
        with self.assertRaisesRegex(LookupError, "iPad"):
            shards.device_runs([regular], devices, runtime="com.apple.CoreSimulator.SimRuntime.iOS-27-1")
        # A scoped selection runs the rest on the shard's simulator and skips what a target would pull in.
        self.assertEqual(shards.scoped(["TalariaUITests", f"{regular}/testOne", "TalariaTests/Unit"]),
                         ["-only-testing:TalariaUITests", "-only-testing:TalariaTests/Unit",
                          f"-skip-testing:{regular}", f"-skip-testing:{rotating}"])
        self.assertEqual(shards.scoped([f"{regular}/testOne"]), [])

    def test_committed_weights_are_valid(self):
        weights = json.loads(shards.WEIGHTS.read_text())
        self.assertEqual(set(weights["default"]), set(shards.TARGETS))
        self.assertTrue(all(value > 0 for value in [*weights["default"].values(), *weights["classes"].values()]))
        # Every weighted class is in the hosted bundle; classes that moved to the TalariaKit package are not.
        hosted = set(shards.discover(measured=weights["classes"]))
        classes = {name.rsplit("/", 1)[0] if name.count("/") == 2 else name for name in weights["classes"]}
        self.assertEqual(sorted(classes - hosted), [])


if __name__ == "__main__":
    unittest.main()
