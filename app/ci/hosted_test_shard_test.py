#!/usr/bin/env python3
"""ci/hosted-test-shard on synthetic logs and class lists; no simulator."""

import importlib.machinery
import importlib.util
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader("hosted_test_shard", str(HERE / "hosted-test-shard"))
spec = importlib.util.spec_from_loader(loader.name, loader)
shard = importlib.util.module_from_spec(spec)
loader.exec_module(shard)


class HostedTestShardTests(unittest.TestCase):
    def ran(self, last=("StreamHostedTests", "TasksHostedTests")):
        return {**{index: list(names) for index, names in enumerate(shard.SHARDS, start=1)}, shard.COUNT: list(last)}

    def test_listed_shards_run_their_classes_and_the_last_runs_every_other_class(self):
        self.assertEqual(shard.COUNT, 4)
        self.assertEqual(shard.selection(1), ["-only-testing:TalariaTests/TranscriptHostedTests"])
        self.assertEqual(shard.selection(2), ["-only-testing:TalariaTests/ChatHostedTests", "-only-testing:TalariaTests/DuoFoldHostedTests"])
        self.assertEqual(shard.selection(4), ["-only-testing:TalariaTests", *(f"-skip-testing:TalariaTests/{name}" for name in shard.LISTED)])
        for invalid in (0, 5, -1):
            with self.subTest(shard=invalid), self.assertRaisesRegex(ValueError, "between 1 and 4"):
                shard.selection(invalid)
        self.assertEqual(len(shard.LISTED), len(set(shard.LISTED)))

    def test_every_listed_class_is_a_hosted_test_class(self):
        # A renamed class would otherwise only fail once CI ran the shard.
        sources = "\n".join(path.read_text() for path in (HERE.parent / "TalariaTests").rglob("*.swift"))
        for name in shard.LISTED:
            with self.subTest(name=name):
                self.assertRegex(sources, rf"\bclass {name}\s*:")

    def test_the_workflow_runs_one_job_per_shard(self):
        workflow = (HERE.parents[1] / ".github/workflows/app-tests.yml").read_text()
        matrix = f"shard: [{', '.join(str(index) for index in range(1, shard.COUNT + 1))}]"
        self.assertTrue(matrix in workflow, f"app-tests.yml must list {matrix}")

    def test_classes_reads_each_suite_a_log_ran(self):
        log = "\n".join([
            "Test Suite 'Selected tests' started at 2026-10-27 11:21:22.100.",
            "Test Suite 'TalariaTests.xctest' started at 2026-10-27 11:21:22.100.",
            "Test Suite 'ChatHostedTests' started at 2026-10-27 11:21:22.200.",
            "Test Case '-[TalariaTests.ChatHostedTests testSend]' started.",
            "Test Suite 'ChatHostedTests' passed at 2026-10-27 11:21:23.200.",
            "    Test Suite 'DuoFoldHostedTests' started at 2026-10-27 11:21:23.300.",
            "Test Suite 'All tests' started at 2026-10-27 11:21:22.100.",
        ])
        self.assertEqual(shard.classes(log), ["ChatHostedTests", "DuoFoldHostedTests"])

    def test_check_requires_every_class_to_run_exactly_once(self):
        seen = shard.check(self.ran())
        self.assertEqual(seen["TranscriptHostedTests"], 1)
        self.assertEqual(seen["TasksHostedTests"], 4)
        broken = {
            "ran in shard 1 and shard 4": self.ran(last=("TranscriptHostedTests", "TasksHostedTests")),
            "ran in shard 3 and shard 4": self.ran(last=("TasksHostedTests", "TasksHostedTests")) | {3: [*shard.SHARDS[2], "TasksHostedTests"]},
            "shard 2 did not run DuoFoldHostedTests": self.ran() | {2: ["ChatHostedTests"]},
            "shard 1 ran unlisted TasksHostedTests": self.ran(last=("StreamHostedTests",)) | {1: ["TranscriptHostedTests", "TasksHostedTests"]},
            "shard 4 ran no classes": self.ran(last=()),
            "expected class lists for shards 1-4": {index: names for index, names in self.ran().items() if index != 3},
        }
        for message, ran in broken.items():
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, re.escape(message)):
                shard.check(ran)

    def test_command_line(self):
        script = str(HERE / "hosted-test-shard")
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "xcodebuild-test.log"
            log.write_text("Test Suite 'Selected tests' started at x.\nTest Suite 'ChatHostedTests' started at x.\n")
            self.assertEqual(subprocess.check_output([script, "classes", str(log)], text=True), "ChatHostedTests\n")
            lists = Path(directory) / "classes"
            lists.mkdir()
            for index, names in self.ran().items():
                (lists / f"shard-{index}.txt").write_text("\n".join(names) + "\n")
            report = subprocess.check_output([script, "check", str(lists)], text=True)
            self.assertIn("- Every one of 7 classes ran exactly once.", report)
            (lists / "shard-4.txt").write_text("TranscriptHostedTests\n")
            result = subprocess.run([script, "check", str(lists)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("TranscriptHostedTests ran in shard 1 and shard 4", result.stderr)
        self.assertEqual(subprocess.check_output([script, "args", "3"], text=True).split(),
                         ["-only-testing:TalariaTests/SessionListHostedTests", "-only-testing:TalariaTests/RegularSplitHostedTests"])


if __name__ == "__main__":
    unittest.main()
