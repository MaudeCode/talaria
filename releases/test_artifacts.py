"""Synthetic cross-runner handoffs; no Actions uploads or publication receipts."""

from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
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
        self.temp = self.root / "runner-temp"
        self.temp.mkdir()
        self.enterContext(patch.object(Path, "home", return_value=self.root / "home"))
        self.enterContext(patch.dict(os.environ, {
            "GITHUB_REPOSITORY": "MaudeCode/talaria", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_SHA": "a" * 40, "RUNNER_NAME": "synthetic-runner", "RUNNER_TEMP": str(self.temp),
            "GITHUB_OUTPUT": str(self.root / "outputs"),
        }, clear=True))

    def transfer(self):
        """The Actions artifact round trip: staged archives arrive under the download directory byte for byte."""
        shutil.copytree(self.temp / "release-handoffs", self.temp / "release-handoffs-in", dirs_exist_ok=True)

    def test_round_trip_and_same_run_retry_on_another_runner(self):
        reference = artifacts.put("release-plan", self.source)
        self.assertEqual(set(reference), {"run", "attempt", "source", "name", "sha256"})
        staged = self.temp / "release-handoffs/123/1/release-plan.tar"
        self.assertEqual(hashlib.sha256(staged.read_bytes()).hexdigest(), reference["sha256"])
        self.assertFalse((self.root / "home").exists())
        self.transfer()
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2", "RUNNER_NAME": "another-runner"}):
            artifacts.get(reference, self.root / "restored")
        self.assertTrue((self.root / "restored/link").is_symlink())
        self.assertEqual((self.root / "restored/receipt.json").read_text(), '{"synthetic":true}\n')
        with self.assertRaises(FileExistsError):
            artifacts.put("release-plan", self.source)

    def test_tampering_cross_run_and_invalid_paths_fail(self):
        reference = artifacts.put("release-plan", self.source)
        self.transfer()
        for key, value in (("run", "456"), ("source", "b" * 40), ("attempt", "2"), ("sha256", "c" * 64),
                           ("name", "../escape"), ("attempt", "../escape"), ("name", "web-build")):
            broken = {**reference, key: value}
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                artifacts.get(broken, self.root / "rejected")
            self.assertFalse((self.root / "rejected").exists())
        downloaded = self.temp / "release-handoffs-in/123/1/release-plan.tar"
        downloaded.write_bytes(b"changed after successful producer job")
        with self.assertRaisesRegex(ValueError, "digest differs"):
            artifacts.get(reference, self.root / "rejected")
        self.assertFalse((self.root / "rejected").exists())
        # An archive that no authenticated producer output names is never restored.
        forged = self.temp / "release-handoffs-in/123/1/web-build.tar"
        forged.write_bytes(b"forged")
        with self.assertRaises(ValueError):
            artifacts.get({**reference, "name": "web-build"}, self.root / "rejected")
        (self.source / "escape").symlink_to(self.root / "outputs")
        with self.assertRaisesRegex(ValueError, "link escapes"):
            artifacts.put("unsafe", self.source)
        self.assertFalse((self.temp / "release-handoffs/123/1/unsafe.tar").exists())

    def test_crafted_archive_members_cannot_escape_the_destination(self):
        crafted = self.temp / "release-handoffs-in/123/1/crafted.tar"
        crafted.parent.mkdir(parents=True)
        with tarfile.open(crafted, "w") as archive:
            member = tarfile.TarInfo("../escape.json")
            member.size = 2
            archive.addfile(member, io.BytesIO(b"{}"))
        reference = {"run": "123", "attempt": "1", "source": "a" * 40, "name": "crafted",
                     "sha256": hashlib.sha256(crafted.read_bytes()).hexdigest()}
        with self.assertRaises(ValueError):
            artifacts.get(reference, self.root / "restored")
        self.assertFalse((self.root / "escape.json").exists())

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

    def test_recovery_restores_another_runs_archives_only_by_producer_digest(self):
        reference = artifacts.put("ios-ipa", self.source)
        self.transfer()
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "456"}):
            with self.assertRaises(ValueError):
                artifacts.get(reference, self.root / "rejected")
            artifacts.restore(reference, self.root / "recovered")
            self.assertEqual((self.root / "recovered/receipt.json").read_text(), '{"synthetic":true}\n')
            (self.temp / "release-handoffs-in/123/1/ios-ipa.tar").write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "digest differs"):
                artifacts.restore(reference, self.root / "rejected")
        self.assertFalse((self.root / "rejected").exists())

    def test_command_line_stores_and_restores_forwarded_names(self):
        with patch("sys.argv", ["artifacts.py", "put", "release-plan", str(self.source)]):
            artifacts.main()
        recorded = (self.root / "outputs").read_text()
        self.assertTrue(recorded.startswith("artifacts={"))
        mapping = json.loads(recorded.split("=", 1)[1])
        self.assertEqual(set(mapping), {"release-plan"})
        self.transfer()
        needs = {"prepare": {"outputs": {"artifacts": json.dumps(mapping)}}}
        with patch.dict(os.environ, {"RELEASE_NEEDS": json.dumps(needs)}):
            with patch("sys.argv", ["artifacts.py", "get", str(self.root / "all")]):
                artifacts.main()
            with patch("sys.argv", ["artifacts.py", "get", str(self.root / "named"), "release-plan"]):
                artifacts.main()
            with patch("sys.argv", ["artifacts.py", "get", str(self.root / "missing"), "web-build"]), \
                    self.assertRaises(KeyError):
                artifacts.main()
        self.assertTrue((self.root / "all/release-plan/receipt.json").is_file())
        self.assertTrue((self.root / "named/release-plan/receipt.json").is_file())
        self.assertFalse((self.root / "missing").exists())


if __name__ == "__main__":
    unittest.main()
