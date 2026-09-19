"""Synthetic local handoffs; no Actions uploads or publication receipts."""

from copy import deepcopy
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import artifacts


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix="talaria-artifact-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "input"
        self.source.mkdir()
        (self.source / "receipt.json").write_text('{"synthetic":true}\n')
        (self.source / "link").symlink_to("receipt.json")
        self.enterContext(patch.object(Path, "home", return_value=self.root / "home"))
        self.enterContext(patch.dict(os.environ, {
            "GITHUB_REPOSITORY": "MaudeCode/talaria", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_SHA": "a" * 40, "RUNNER_NAME": "synthetic-runner",
            "GITHUB_OUTPUT": str(self.root / "outputs"),
        }, clear=True))

    def test_round_trip_and_same_run_retry(self):
        reference = artifacts.put("release-plan", self.source)
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}):
            artifacts.get(reference, self.root / "restored")
        self.assertTrue((self.root / "restored/link").is_symlink())
        self.assertEqual(artifacts.digest(self.root / "restored"), reference["sha256"])
        with self.assertRaises(FileExistsError):
            artifacts.put("release-plan", self.source)

    def test_tampering_cross_run_and_invalid_paths_fail(self):
        reference = artifacts.put("release-plan", self.source)
        for key, value in (("run", "456"), ("runner", "another-runner"), ("source", "b" * 40),
                           ("attempt", "2"), ("name", "../escape"), ("attempt", "../escape")):
            broken = {**reference, key: value}
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                artifacts.get(broken, self.root / "rejected")
            self.assertFalse((self.root / "rejected").exists())
        stored = artifacts.location(reference, "release-plan")
        (stored / "receipt.json").write_text("changed after successful producer job")
        with self.assertRaisesRegex(ValueError, "digest differs"):
            artifacts.get(reference, self.root / "rejected")
        (self.source / "escape").symlink_to(self.root / "outputs")
        with self.assertRaisesRegex(ValueError, "link escapes"):
            artifacts.put("unsafe", self.source)

    def test_forwarded_outputs_cannot_conflict(self):
        reference = artifacts.put("release-plan", self.source)
        mapping = {"release-plan": reference}
        needs = {"prepare": {"outputs": {"artifacts": json.dumps(mapping)}},
                 "gate": {"outputs": {"artifacts": json.dumps(mapping)}}}
        with patch.dict(os.environ, {"RELEASE_NEEDS": json.dumps(needs)}):
            self.assertEqual(artifacts.references(), mapping)
        other = deepcopy(mapping)
        other["release-plan"]["sha256"] = "c" * 64
        needs["gate"]["outputs"]["artifacts"] = json.dumps(other)
        with patch.dict(os.environ, {"RELEASE_NEEDS": json.dumps(needs)}), self.assertRaises(ValueError):
            artifacts.references()

    def test_cleanup_keeps_evidence_and_other_runs(self):
        retained = artifacts.put("release-set-candidate", self.source)
        discarded = artifacts.put("web-build", self.source)
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "456"}):
            other = artifacts.put("web-build", self.source)
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}):
            retried = artifacts.put("web-build", self.source)
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}), patch("sys.argv", ["artifacts.py", "clean", "release-set-candidate"]):
            artifacts.main()
        self.assertTrue(artifacts.location(retained, retained["name"]).exists())
        self.assertFalse(artifacts.location(discarded, discarded["name"]).exists())
        self.assertFalse(artifacts.location(retried, retried["name"]).exists())
        self.assertTrue(artifacts.location(other, other["name"]).exists())


if __name__ == "__main__":
    unittest.main()
