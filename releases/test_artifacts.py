"""Synthetic handoffs through a stubbed Actions artifact service; no network or publication receipts."""

from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
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
        # The artifact service: {(run, artifact name): {"source": head SHA, "expired": bool, "files": {file: bytes}}}.
        self.service = {}
        self.downloads = []
        self.real = (artifacts.listing, artifacts.download)
        self.enterContext(patch.object(artifacts, "listing", self.fake_listing))
        self.enterContext(patch.object(artifacts, "download", self.fake_download))
        self.enterContext(patch.dict(os.environ, {
            "GITHUB_REPOSITORY": "MaudeCode/talaria", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_SHA": "a" * 40, "RUNNER_TEMP": str(self.temp), "GITHUB_OUTPUT": str(self.root / "outputs"),
        }, clear=True))

    def fake_listing(self, run):
        return [{"name": name, "expired": value["expired"], "workflow_run": {"id": int(key), "head_sha": value["source"]}}
                for (key, name), value in self.service.items() if key == run]

    def fake_download(self, run, artifact, directory):
        """``gh run download --name`` writes the artifact's files into the directory, or fails."""
        self.downloads.append((run, artifact))
        if (run, artifact) not in self.service:
            raise ValueError(f"artifact {artifact} is not in run {run}")
        directory.mkdir(parents=True)
        for name, data in self.service[(run, artifact)]["files"].items():
            (directory / name).write_bytes(data)

    def upload(self, artifact, directory, run="123", source="a" * 40):
        """What the workflow's actions/upload-artifact step does with put's outputs."""
        self.service[(run, artifact)] = {"source": source, "expired": False,
                                         "files": {path.name: path.read_bytes() for path in Path(directory).iterdir()}}

    def put(self, *pairs):
        result, artifact, directory = artifacts.put([(name, Path(path)) for name, path in pairs])
        self.upload(artifact, directory)
        return result

    def get(self, reference, destination):
        artifacts.get({str(reference.get("name")): reference}, destination)

    def tamper(self, name, data):
        for value in self.service.values():
            if name + ".tar" in value["files"]:
                value["files"][name + ".tar"] = data

    def test_round_trip_is_named_by_run_attempt_and_handoffs(self):
        result, artifact, directory = artifacts.put([("release-plan", self.source)])
        reference = result["release-plan"]
        self.assertEqual(set(reference), {"run", "attempt", "source", "name", "sha256"})
        self.assertEqual(artifact, "handoffs_123_1_release-plan")
        self.assertEqual(directory, self.temp / "release-handoffs" / artifact)
        self.assertEqual(hashlib.sha256((directory / "release-plan.tar").read_bytes()).hexdigest(), reference["sha256"])
        self.upload(artifact, directory)
        # A re-run attempt restores the earlier attempt's producer output.
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}):
            self.get(reference, self.root / "restored")
        self.assertEqual(self.downloads[-1], ("123", artifact))
        self.assertTrue((self.root / "restored/release-plan/link").is_symlink())
        self.assertEqual((self.root / "restored/release-plan/receipt.json").read_text(), '{"synthetic":true}\n')
        with self.assertRaises(FileExistsError):
            artifacts.put([("release-plan", self.source)])
        with self.assertRaises(FileExistsError):
            artifacts.put([("web-build", self.source), ("release-plan", self.source)])
        # Several handoffs share one artifact, and each is found by its own name.
        bundle = self.put(("web-build", self.source), ("web-image", self.source))
        self.assertIn(("123", "1"), [(value["run"], value["attempt"]) for value in bundle.values()])
        self.assertIn(("123", "handoffs_123_1_web-build.web-image"), self.service)
        self.get(bundle["web-image"], self.root / "image")
        self.assertEqual(self.downloads[-1], ("123", "handoffs_123_1_web-build.web-image"))

    def test_digest_mismatch_is_rejected(self):
        reference = self.put(("release-plan", self.source))["release-plan"]
        self.tamper("release-plan", b"changed after the successful producer job")
        with self.assertRaisesRegex(ValueError, "digest differs"):
            self.get(reference, self.root / "rejected")
        self.assertFalse((self.root / "rejected").exists())
        with self.assertRaisesRegex(ValueError, "digest differs"):
            self.get({**reference, "sha256": "c" * 64}, self.root / "rejected")
        self.assertFalse((self.root / "rejected").exists())

    def test_wrong_run_is_rejected(self):
        reference = self.put(("release-plan", self.source))["release-plan"]
        # Another run's reference is refused before any lookup, even when that run holds a matching artifact.
        self.service[("456", "handoffs_456_1_release-plan")] = deepcopy(self.service[("123", "handoffs_123_1_release-plan")])
        with self.assertRaisesRegex(ValueError, "different run"):
            self.get({**reference, "run": "456"}, self.root / "rejected")
        # An artifact the service attributes to another run or workflow source is refused as well.
        self.service[("123", "handoffs_123_1_release-plan")]["source"] = "b" * 40
        with self.assertRaisesRegex(ValueError, "different run or workflow source"):
            self.get(reference, self.root / "rejected")
        with self.assertRaisesRegex(ValueError, "different run"):
            self.get({**reference, "source": "b" * 40}, self.root / "rejected")
        self.assertEqual(self.downloads, [])
        self.assertFalse((self.root / "rejected").exists())

    def test_wrong_attempt_is_rejected(self):
        reference = self.put(("release-plan", self.source))["release-plan"]
        # In attempt 2 a reference claiming attempt 2 cannot resolve to the attempt-1 artifact that holds the name.
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}), self.assertRaisesRegex(ValueError, "missing"):
            self.get({**reference, "attempt": "2"}, self.root / "rejected")
        # A later attempt's artifact exists, but attempt 1 must not consume it.
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}):
            future = self.put(("release-plan", self.source))["release-plan"]
        self.assertEqual(future["attempt"], "2")
        for broken in (future, *({**reference, "attempt": attempt} for attempt in ("0", "../1", ""))):
            with self.subTest(attempt=broken["attempt"]), self.assertRaisesRegex(ValueError, "future or invalid attempt"):
                self.get(broken, self.root / "rejected")
        self.assertEqual(self.downloads, [])
        self.assertFalse((self.root / "rejected").exists())

    def test_missing_expired_or_ambiguous_handoffs_are_rejected(self):
        reference = self.put(("release-plan", self.source))["release-plan"]
        with self.assertRaisesRegex(ValueError, "missing"):
            self.get({**reference, "name": "web-build"}, self.root / "rejected")
        with self.assertRaisesRegex(ValueError, "invalid artifact name"):
            self.get({**reference, "name": "../escape"}, self.root / "rejected")
        self.service[("123", "handoffs_123_1_release-plan")]["expired"] = True
        with self.assertRaisesRegex(ValueError, "expired"):
            self.get(reference, self.root / "rejected")
        self.service[("123", "handoffs_123_1_release-plan")]["expired"] = False
        self.service[("123", "handoffs_123_1_other.release-plan")] = self.service[("123", "handoffs_123_1_release-plan")]
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            self.get(reference, self.root / "rejected")
        del self.service[("123", "handoffs_123_1_other.release-plan")]
        self.service[("123", "handoffs_123_1_release-plan")]["files"] = {}
        with self.assertRaisesRegex(ValueError, "not downloaded"):
            self.get(reference, self.root / "rejected")
        self.assertFalse((self.root / "rejected").exists())

    def test_unsafe_sources_are_not_staged(self):
        (self.source / "escape").symlink_to(self.root / "outputs")
        with self.assertRaisesRegex(ValueError, "link escapes"):
            artifacts.put([("unsafe", self.source)])
        self.assertFalse((self.temp / "release-handoffs").exists())

    def test_crafted_archive_members_cannot_escape_the_destination(self):
        crafted = io.BytesIO()
        with tarfile.open(fileobj=crafted, mode="w") as archive:
            member = tarfile.TarInfo("../escape.json")
            member.size = 2
            archive.addfile(member, io.BytesIO(b"{}"))
        self.service[("123", "handoffs_123_1_crafted")] = {"source": "a" * 40, "expired": False,
                                                          "files": {"crafted.tar": crafted.getvalue()}}
        reference = {"run": "123", "attempt": "1", "source": "a" * 40, "name": "crafted",
                     "sha256": hashlib.sha256(crafted.getvalue()).hexdigest()}
        with self.assertRaises(ValueError):
            self.get(reference, self.root / "restored")
        self.assertFalse((self.root / "escape.json").exists())
        self.assertFalse((self.root / "restored/escape.json").exists())
        # A forwarded key must name its own handoff, so no key can steer extraction elsewhere.
        with self.assertRaisesRegex(ValueError, "names another handoff"):
            artifacts.get({"../escape": reference}, self.root / "restored")

    def test_forwarded_outputs_cannot_conflict(self):
        reference = self.put(("release-plan", self.source))["release-plan"]
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

    def test_recovery_restores_another_runs_handoffs_only_by_producer_digest(self):
        reference = self.put(("ios-ipa", self.source))["ios-ipa"]
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "456", "GITHUB_SHA": "b" * 40}):
            with self.assertRaises(ValueError):
                self.get(reference, self.root / "rejected")
            artifacts.extract(*artifacts.stored(reference), self.root / "recovered")
            self.assertEqual(self.downloads[-1], ("123", "handoffs_123_1_ios-ipa"))
            self.assertEqual((self.root / "recovered/receipt.json").read_text(), '{"synthetic":true}\n')
            self.tamper("ios-ipa", b"tampered")
            with self.assertRaisesRegex(ValueError, "digest differs"):
                artifacts.stored(reference)

    def test_command_line_stages_and_restores_forwarded_names(self):
        with patch("sys.argv", ["artifacts.py", "put", "release-plan", str(self.source)]):
            artifacts.main()
        outputs = dict(line.split("=", 1) for line in (self.root / "outputs").read_text().splitlines())
        self.assertEqual(outputs["handoff_name"], "handoffs_123_1_release-plan")
        self.assertEqual(outputs["handoff_path"], str(self.temp / "release-handoffs/handoffs_123_1_release-plan"))
        self.upload(outputs["handoff_name"], outputs["handoff_path"])
        mapping = json.loads(outputs["artifacts"])
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

    def test_later_puts_report_every_handoff_the_job_staged(self):
        for name in ("app-build", "ios-ipa"):
            with patch("sys.argv", ["artifacts.py", "put", name, str(self.source)]):
                artifacts.main()
        lines = (self.root / "outputs").read_text().splitlines()
        outputs = [json.loads(line.split("=", 1)[1]) for line in lines if line.startswith("artifacts=")]
        self.assertEqual([set(value) for value in outputs], [{"app-build"}, {"app-build", "ios-ipa"}])
        self.assertIn("handoff_name=handoffs_123_1_ios-ipa", lines)

    def test_receipt_restore_skips_payload_handoffs(self):
        # Assembly reads receipts, the plan and npm tarballs; the Web image and iOS payloads are never downloaded.
        mapping = {**self.put(("release-plan", self.source)), **self.put(("web-image", self.source))}
        needs = {"build-gate": {"outputs": {"artifacts": json.dumps(mapping)}}}
        with patch.dict(os.environ, {"RELEASE_NEEDS": json.dumps(needs)}), \
                patch("sys.argv", ["artifacts.py", "get", str(self.root / "receipts"), "--receipts"]):
            artifacts.main()
        self.assertTrue((self.root / "receipts/release-plan/receipt.json").is_file())
        self.assertFalse((self.root / "receipts/web-image").exists())
        self.assertEqual([artifact for _, artifact in self.downloads], ["handoffs_123_1_release-plan"])

    def test_service_calls_use_the_job_token_through_gh_without_leaking_it(self):
        listing, download = self.real
        with patch.object(artifacts.subprocess, "check_output", return_value='{"name":"a"}\n{"name":"b"}\n') as run:
            self.assertEqual(listing("123"), [{"name": "a"}, {"name": "b"}])
        self.assertEqual(run.call_args.args[0], ["gh", "api", "--paginate", "repos/MaudeCode/talaria/actions/runs/123/artifacts?per_page=100",
                                                 "--jq", ".artifacts[]"])
        with patch.object(artifacts.subprocess, "run") as run:
            download("123", "handoffs_123_1_x", self.root / "x")
        self.assertEqual(run.call_args.args[0], ["gh", "run", "download", "123", "--repo", "MaudeCode/talaria",
                                                 "--name", "handoffs_123_1_x", "--dir", str(self.root / "x")])
        self.assertTrue(run.call_args.kwargs["check"])
        failure = subprocess.CalledProcessError(1, ["gh"], output="synthetic-token")
        with patch.dict(os.environ, {"GH_TOKEN": "synthetic-token"}):
            with patch.object(artifacts.subprocess, "run", side_effect=failure), \
                    self.assertRaisesRegex(ValueError, "^((?!synthetic-token).)*$") as failed:
                download("123", "handoffs_123_1_x", self.root / "x")
            self.assertIn("handoffs_123_1_x", str(failed.exception))
            with patch.object(artifacts.subprocess, "check_output", side_effect=failure), \
                    self.assertRaisesRegex(ValueError, "^((?!synthetic-token).)*$"):
                listing("123")


if __name__ == "__main__":
    unittest.main()
