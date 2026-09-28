"""Synthetic cross-runner handoffs through a stubbed object store; no network or publication receipts."""

from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
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
        self.store = {}
        self.requests = []
        self.real_transfer = getattr(artifacts, "transfer", None)
        self.enterContext(patch.object(Path, "home", return_value=self.root / "home"))
        self.enterContext(patch.object(artifacts, "transfer", self.fake_transfer, create=True))
        self.enterContext(patch.dict(os.environ, {
            "GITHUB_REPOSITORY": "MaudeCode/talaria", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_SHA": "a" * 40, "RUNNER_NAME": "synthetic-runner", "RUNNER_TEMP": str(self.temp),
            "GITHUB_WORKFLOW_REF": "MaudeCode/talaria/.github/workflows/ci.yml@refs/pull/1/merge",
            "GITHUB_OUTPUT": str(self.root / "outputs"),
        }, clear=True))

    def fake_transfer(self, operation, key, path):
        """The NAS store as a dictionary; ``get`` of an unknown key fails like the helper does."""
        self.requests.append((operation, key))
        if operation == "put":
            self.store[key] = Path(path).read_bytes()
        elif key in self.store:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_bytes(self.store[key])
        else:
            raise ValueError(f"object {key} is not in the store")

    def test_round_trip_keys_are_namespaced_by_workflow_run_and_attempt(self):
        reference = artifacts.put("release-plan", self.source)
        self.assertEqual(set(reference), {"run", "attempt", "source", "name", "sha256"})
        key = "handoffs/ci/123/1/release-plan.tar"
        self.assertEqual(list(self.store), [key])
        self.assertEqual(hashlib.sha256(self.store[key]).hexdigest(), reference["sha256"])
        self.assertFalse((self.root / "home").exists())
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2", "RUNNER_NAME": "another-runner"}):
            artifacts.get(reference, self.root / "restored")
        self.assertEqual(self.requests[-1], ("get", key))
        self.assertTrue((self.root / "restored/link").is_symlink())
        self.assertEqual((self.root / "restored/receipt.json").read_text(), '{"synthetic":true}\n')
        with self.assertRaises(FileExistsError):
            artifacts.put("release-plan", self.source)
        # A reusable workflow's handoffs live under the calling workflow's namespace.
        with patch.dict(os.environ, {"GITHUB_WORKFLOW_REF": "MaudeCode/talaria/.github/workflows/production-cutover.yml@refs/heads/main"}):
            artifacts.put("web-build", self.source)
        self.assertIn("handoffs/production-cutover/123/1/web-build.tar", self.store)
        with patch.dict(os.environ, {"GITHUB_WORKFLOW_REF": "untrusted"}), self.assertRaises(ValueError):
            artifacts.put("agent-receipts", self.source)

    def test_tampering_cross_run_missing_objects_and_invalid_paths_fail(self):
        reference = artifacts.put("release-plan", self.source)
        for key, value in (("run", "456"), ("source", "b" * 40), ("attempt", "2"),
                           ("name", "../escape"), ("attempt", "../escape")):
            broken = {**reference, key: value}
            requests = len(self.requests)
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                artifacts.get(broken, self.root / "rejected")
            self.assertEqual(len(self.requests), requests, "identity checks precede any download")
            self.assertFalse((self.root / "rejected").exists())
        for key, value in (("sha256", "c" * 64), ("name", "web-build")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                artifacts.get({**reference, key: value}, self.root / "rejected")
            self.assertFalse((self.root / "rejected").exists())
        self.store["handoffs/ci/123/1/release-plan.tar"] = b"changed after successful producer job"
        with self.assertRaisesRegex(ValueError, "digest differs"):
            artifacts.get(reference, self.root / "rejected")
        self.assertFalse((self.root / "rejected").exists())
        (self.source / "escape").symlink_to(self.root / "outputs")
        with self.assertRaisesRegex(ValueError, "link escapes"):
            artifacts.put("unsafe", self.source)
        self.assertNotIn("handoffs/ci/123/1/unsafe.tar", self.store)

    def test_crafted_archive_members_cannot_escape_the_destination(self):
        crafted = self.root / "crafted.tar"
        with tarfile.open(crafted, "w") as archive:
            member = tarfile.TarInfo("../escape.json")
            member.size = 2
            archive.addfile(member, io.BytesIO(b"{}"))
        self.store["handoffs/ci/123/1/crafted.tar"] = crafted.read_bytes()
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

    def test_recovery_restores_the_authenticated_original_runs_objects_only_by_producer_digest(self):
        with patch.dict(os.environ, {"GITHUB_WORKFLOW_REF": "MaudeCode/talaria/.github/workflows/production-cutover.yml@refs/heads/main"}):
            reference = artifacts.put("ios-ipa", self.source)
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "456", "GITHUB_WORKFLOW_REF": "MaudeCode/talaria/.github/workflows/recover-cutover.yml@refs/heads/main"}):
            with self.assertRaises(ValueError):
                artifacts.get(reference, self.root / "rejected")
            with self.assertRaises(ValueError):
                artifacts.restore(reference, self.root / "rejected")  # the recovery workflow's own namespace is empty
            artifacts.restore(reference, self.root / "recovered", "production-cutover")
            self.assertEqual(self.requests[-1], ("get", "handoffs/production-cutover/123/1/ios-ipa.tar"))
            self.assertEqual((self.root / "recovered/receipt.json").read_text(), '{"synthetic":true}\n')
            self.store["handoffs/production-cutover/123/1/ios-ipa.tar"] = b"tampered"
            with self.assertRaisesRegex(ValueError, "digest differs"):
                artifacts.restore(reference, self.root / "rejected", "production-cutover")
        self.assertFalse((self.root / "rejected").exists())

    def test_command_line_stores_and_restores_forwarded_names(self):
        with patch("sys.argv", ["artifacts.py", "put", "release-plan", str(self.source)]):
            artifacts.main()
        recorded = (self.root / "outputs").read_text()
        self.assertTrue(recorded.startswith("artifacts={"))
        mapping = json.loads(recorded.split("=", 1)[1])
        self.assertEqual(set(mapping), {"release-plan"})
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

    def test_receipt_restore_skips_payload_handoffs(self):
        # Assembly reads receipts, the plan and npm tarballs; the Web image and iOS payloads stay on the NAS.
        with patch("sys.argv", ["artifacts.py", "put", "release-plan", str(self.source), "web-image", str(self.source)]):
            artifacts.main()
        mapping = json.loads((self.root / "outputs").read_text().split("=", 1)[1])
        needs = {"build-gate": {"outputs": {"artifacts": json.dumps(mapping)}}}
        with patch.dict(os.environ, {"RELEASE_NEEDS": json.dumps(needs)}), \
                patch("sys.argv", ["artifacts.py", "get", str(self.root / "receipts"), "--receipts"]):
            artifacts.main()
        self.assertTrue((self.root / "receipts/release-plan/receipt.json").is_file())
        self.assertFalse((self.root / "receipts/web-image").exists())

    def test_transfer_runs_the_shared_helper_and_reports_failures_without_secrets(self):
        helper = Path(artifacts.__file__).resolve().parents[1] / "scripts/s3-artifact"
        self.assertTrue(self.real_transfer, "artifacts.transfer must delegate to the shared NAS helper")
        with patch.object(artifacts.subprocess, "run") as run:
            self.real_transfer("put", "handoffs/ci/123/1/x.tar", self.root / "x.tar")
        self.assertEqual(run.call_args.args[0], [str(helper), "put", "handoffs/ci/123/1/x.tar", str(self.root / "x.tar")])
        self.assertTrue(run.call_args.kwargs["check"])
        failure = artifacts.subprocess.CalledProcessError(22, ["s3-artifact"])
        with patch.dict(os.environ, {"TALARIA_S3_SECRET_ACCESS_KEY": "synthetic-secret"}), \
                patch.object(artifacts.subprocess, "run", side_effect=failure), \
                self.assertRaisesRegex(ValueError, "^((?!synthetic-secret).)*$") as failed:
            self.real_transfer("get", "handoffs/ci/123/1/x.tar", self.root / "x.tar")
        self.assertIn("handoffs/ci/123/1/x.tar", str(failed.exception))

if __name__ == "__main__":
    unittest.main()
