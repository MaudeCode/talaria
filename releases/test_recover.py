"""Failed-run recovery authenticates GitHub evidence before touching artifacts."""

from copy import deepcopy
import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import recover
from artifacts import digest


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
        refs = {name: {"run": "123", "attempt": "1", "runner": "synthetic-runner", "source": "a" * 40,
                       "name": name, "sha256": "b" * 64}
                for name in ("release-plan", "contract-receipts", "agent-receipts", "relay-build", "web-build", "app-build",
                             "ios-ipa", "ios-dsyms", "relay-publish", "web-publish")}
        needs = {name: {"result": "failure" if name == "app-publish" else "success", "outputs": {}}
                 for name in ("prepare", "build-gate", "relay-publish", "web-publish", "app-publish")}
        needs["prepare"]["outputs"] = {"source": "c" * 40, "app_changed": "true", "web_changed": "true", "relay_changed": "true"}
        needs["build-gate"]["outputs"]["artifacts"] = json.dumps(refs)
        return metadata, jobs, needs, refs

    def verify(self, metadata, jobs, needs):
        return recover.authenticate("123", "4", metadata, jobs, "timestamp RELEASE_NEEDS: " + json.dumps(needs), "synthetic-runner")

    def test_original_jobs_and_references_are_authenticated(self):
        metadata, jobs, needs, refs = self.example()
        self.assertEqual(self.verify(metadata, jobs, needs), ("c" * 40, refs))
        # Job-level env is logged again for each executed step.
        repeated = ("timestamp RELEASE_NEEDS: " + json.dumps(needs) + "\n") * 2
        self.assertEqual(recover.authenticate("123", "4", metadata, jobs, repeated, "synthetic-runner"), ("c" * 40, refs))
        with self.assertRaisesRegex(ValueError, "conflicting"):
            recover.authenticate("123", "4", metadata, jobs, repeated + "RELEASE_NEEDS: {}", "synthetic-runner")
        for field, value in (("head_branch", "feature"), ("event", "pull_request"), ("conclusion", "success"),
                             ("path", ".github/workflows/release-set.yml"), ("run_attempt", 3), ("head_sha", "bad"),
                             ("head_repository", {"full_name": "untrusted/fork"})):
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.verify({**metadata, field: value}, jobs, needs)
        for index in range(len(jobs)):
            for key, value in (("conclusion", "skipped"), ("runner_name", "other"), ("run_id", 456), ("run_attempt", 5)):
                broken = deepcopy(jobs)
                broken[index][key] = value
                with self.subTest(index=index, key=key), self.assertRaises(ValueError):
                    self.verify(metadata, broken, needs)
        for key, value in (("run", "456"), ("attempt", "5"), ("attempt", "../4"), ("source", "d" * 40),
                           ("runner", "other"), ("name", "../escape"), ("sha256", "bad")):
            broken = deepcopy(needs)
            changed = deepcopy(refs)
            changed["ios-ipa"][key] = value
            broken["build-gate"]["outputs"]["artifacts"] = json.dumps(changed)
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.verify(metadata, jobs, broken)
        for text in ("", "RELEASE_NEEDS: {} RELEASE_NEEDS: {}"):
            with self.assertRaises(ValueError):
                recover.authenticate("123", "4", metadata, jobs, text, "synthetic-runner")

    def test_restored_files_preserve_original_receipts_and_reject_tampering(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "original"
            source.mkdir()
            receipt = b'{"runUrl":"https://github.com/MaudeCode/talaria/actions/runs/123/attempts/1"}\n'
            (source / "receipt.json").write_bytes(receipt)
            refs = {"app-build": {"sha256": digest(source)}}
            with patch.object(recover, "location", return_value=source):
                recover.restore(refs, root / "recovered")
                self.assertEqual((root / "recovered/app-build/receipt.json").read_bytes(), receipt)
                (source / "receipt.json").write_text("tampered")
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
                   "RUNNER_NAME": "synthetic-runner", "GITHUB_SHA": "d" * 40, "GITHUB_OUTPUT": str(output)}
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
