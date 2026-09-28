"""Failed-run recovery authenticates GitHub evidence before touching artifacts."""

from copy import deepcopy
import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import artifacts
import recover


class RecoveryTests(unittest.TestCase):
    def test_ansi_logs_are_captured_with_explicit_cli_opt_in(self):
        def gh(command, **kwargs):
            self.assertTrue(kwargs["text"])
            if command[2].endswith("/logs"):
                if "--allow-escape-sequences" not in command:
                    raise subprocess.CalledProcessError(1, command, stderr="the response contains terminal escape sequences")
                return "\x1b[36mjob\x1b[0m\nRELEASE_NEEDS: {}"
            self.assertNotIn("--allow-escape-sequences", command)
            return "{}"
        with patch.object(recover.subprocess, "check_output", side_effect=gh):
            self.assertIn("\x1b[36m", recover.api("actions/jobs/123/logs"))
            self.assertEqual(recover.api("actions/runs/123"), "{}")

    def example(self):
        metadata = {"id": 123, "run_attempt": 4, "event": "workflow_dispatch", "head_branch": "main",
                    "path": ".github/workflows/production-cutover.yml", "status": "completed", "conclusion": "failure",
                    "head_sha": "a" * 40, "repository": {"full_name": "MaudeCode/talaria"},
                    "head_repository": {"full_name": "MaudeCode/talaria"}}
        jobs = [{"name": "release / " + name, "conclusion": conclusion, "runner_name": "synthetic-runner",
                 "run_id": 123, "run_attempt": 4}
                for name, conclusion in (("prepare", "success"), ("build-gate", "success"), ("relay-publish", "success"),
                                         ("web-publish", "success"), ("Publish iOS app", "failure"), ("publish-set", "failure"))]
        refs = {name: {"run": "123", "attempt": "1", "source": "a" * 40, "name": name, "sha256": "b" * 64}
                for name in ("release-plan", "contract-receipts", "previous-app-receipts", "agent-receipts", "relay-build", "web-build", "app-build",
                             "ios-ipa", "ios-dsyms", "relay-publish", "web-publish")}
        needs = {name: {"result": "failure" if name == "app-publish" else "success", "outputs": {}}
                 for name in ("prepare", "build-gate", "relay-publish", "web-publish", "app-publish")}
        needs["prepare"]["outputs"] = {"source": "c" * 40, "app_changed": "true", "web_changed": "true", "relay_changed": "true"}
        # build-gate also forwards the Web OCI image; recovery authenticates it but never restores it.
        forwarded = {**refs, "web-image": {**refs["web-build"], "name": "web-image"}}
        needs["build-gate"]["outputs"]["artifacts"] = json.dumps(forwarded)
        return metadata, jobs, needs, refs

    def verify(self, metadata, jobs, needs):
        return recover.authenticate("123", "4", metadata, jobs, "timestamp RELEASE_NEEDS: " + json.dumps(needs))

    def test_original_jobs_and_references_are_authenticated(self):
        metadata, jobs, needs, refs = self.example()
        self.assertEqual(self.verify(metadata, jobs, needs), ("c" * 40, refs))
        # Job-level env is logged again for each executed step.
        repeated = ("timestamp RELEASE_NEEDS: " + json.dumps(needs) + "\n") * 2
        self.assertEqual(recover.authenticate("123", "4", metadata, jobs, repeated), ("c" * 40, refs))
        with self.assertRaisesRegex(ValueError, "conflicting"):
            recover.authenticate("123", "4", metadata, jobs, repeated + "RELEASE_NEEDS: {}")
        for field, value in (("head_branch", "feature"), ("event", "pull_request"), ("conclusion", "success"),
                             ("path", ".github/workflows/release-set.yml"), ("run_attempt", 3), ("head_sha", "bad"),
                             ("head_repository", {"full_name": "untrusted/fork"})):
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.verify({**metadata, field: value}, jobs, needs)
        for index in range(len(jobs)):
            for key, value in (("conclusion", "skipped"), ("run_id", 456), ("run_attempt", 5)):
                broken = deepcopy(jobs)
                broken[index][key] = value
                with self.subTest(index=index, key=key), self.assertRaises(ValueError):
                    self.verify(metadata, broken, needs)
        for name in ("ios-ipa", "web-image"):
            for key, value in (("run", "456"), ("attempt", "5"), ("attempt", "../4"), ("source", "d" * 40),
                               ("name", "../escape"), ("sha256", "bad")):
                broken = deepcopy(needs)
                changed = json.loads(broken["build-gate"]["outputs"]["artifacts"])
                changed[name][key] = value
                broken["build-gate"]["outputs"]["artifacts"] = json.dumps(changed)
                with self.subTest(name=name, key=key), self.assertRaises(ValueError):
                    self.verify(metadata, jobs, broken)
        for text in ("", "RELEASE_NEEDS: {} RELEASE_NEEDS: {}"):
            with self.assertRaises(ValueError):
                recover.authenticate("123", "4", metadata, jobs, text)

    def test_restored_files_preserve_original_receipts_and_reject_tampering(self):
        # The original run's artifacts are downloaded, never copied from a runner's disk; only their producer
        # digests authorize them, and every archive is checked before any is extracted.
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "original"
            source.mkdir()
            receipt = b'{"runUrl":"https://github.com/MaudeCode/talaria/actions/runs/123/attempts/1"}\n'
            (source / "receipt.json").write_bytes(receipt)
            service, downloads = {}, []

            def listing(run):
                return [{"name": name, "expired": False, "workflow_run": {"id": int(run), "head_sha": "a" * 40}}
                        for key, name in service if key == run]

            def download(run, artifact, directory):
                downloads.append(artifact)
                directory.mkdir(parents=True)
                for name, data in service[(run, artifact)].items():
                    (directory / name).write_bytes(data)

            env = {"GITHUB_REPOSITORY": "MaudeCode/talaria", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
                   "GITHUB_SHA": "a" * 40, "RUNNER_TEMP": str(root)}
            with patch.dict(os.environ, env, clear=True):
                refs, artifact, directory = artifacts.put([("app-build", source), ("ios-ipa", source)])
            service[("123", artifact)] = {path.name: path.read_bytes() for path in directory.iterdir()}
            recovery = {**env, "GITHUB_RUN_ID": "456", "GITHUB_SHA": "d" * 40, "RUNNER_TEMP": str(root / "recovery")}
            with patch.dict(os.environ, recovery, clear=True), patch.object(artifacts, "listing", listing), \
                    patch.object(artifacts, "download", download):
                recover.restore(refs, root / "recovered")
                # The original run's artifact is downloaded once for all the handoffs it holds.
                self.assertEqual(downloads, [artifact])
                self.assertEqual((root / "recovered/app-build/receipt.json").read_bytes(), receipt)
                self.assertEqual((root / "recovered/ios-ipa/receipt.json").read_bytes(), receipt)
                service[("123", artifact)]["ios-ipa.tar"] = b"tampered"
                with self.assertRaisesRegex(ValueError, "original producer"):
                    recover.restore(refs, root / "rejected")
                self.assertFalse((root / "rejected").exists())

    def test_superseded_recovery_fails_before_providing_upload_source(self):
        metadata, jobs, needs, _ = self.example()
        for index, job in enumerate(jobs):
            job["id"] = index + 1
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan = root / "release-plan/plan.json"
            plan.parent.mkdir()
            plan.write_text(json.dumps({"dryRun": False, "releaseSet": "c" * 40}))
            output = root / "outputs"
            env = {"GITHUB_RUN_ID": "456", "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "workflow_dispatch",
                   "GITHUB_WORKFLOW_REF": "MaudeCode/talaria/.github/workflows/recover-cutover.yml@refs/heads/main",
                   "GITHUB_SHA": "d" * 40, "GITHUB_OUTPUT": str(output)}
            with patch.dict(os.environ, env), patch("sys.argv", ["recover.py", "123", "4", str(root)]), \
                    patch.object(recover, "api", side_effect=[json.dumps(metadata), json.dumps({"total_count": len(jobs), "jobs": jobs}),
                                                            "RELEASE_NEEDS: " + json.dumps(needs)]), \
                    patch.object(recover, "git"), patch.object(recover, "restore"), \
                    patch.object(recover, "require_current_predecessor", side_effect=ValueError("superseded"), create=True) as guard:
                with self.assertRaisesRegex(ValueError, "superseded"):
                    recover.main()
                guard.assert_called_once_with({"dryRun": False, "releaseSet": "c" * 40}, None)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
