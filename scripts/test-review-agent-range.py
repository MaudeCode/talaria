#!/usr/bin/env python3
"""Agent range review helper over synthetic disposable Git repositories."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("review-agent-range.py")
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@example.invalid", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], env=ENV, text=True, capture_output=True, check=True).stdout.strip()


class ReviewAgentRangeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="talaria-agent-review-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.upstream = self.root / "upstream"
        git(self.root, "init", "--quiet", "-b", "main", str(self.upstream))
        git(self.upstream, "config", "uploadpack.allowAnySHA1InWant", "true")
        self.commit("hermes_cli/profiles.py", "def list_profiles(): pass\n", "profiles")
        git(self.upstream, "tag", "-a", "v0.1.0", "-m", "v0.1.0")
        self.base = git(self.upstream, "rev-parse", "HEAD")
        for number in range(6):
            self.commit(f"docs/{number}.md", "x\n", f"docs {number}")
        self.commit("hermes_cli/profiles.py", "def list_profiles(): pass\ndef stop_profile(): pass\n", "per-profile stop")
        git(self.upstream, "tag", "-a", "v0.2.0", "-m", "v0.2.0")
        self.candidate = git(self.upstream, "rev-parse", "HEAD")

    def commit(self, path, text, message):
        file = self.upstream / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)
        git(self.upstream, "add", path)
        git(self.upstream, "commit", "--quiet", "-m", message)

    def run_script(self, *args, check=True):
        result = subprocess.run([sys.executable, str(SCRIPT), *args], env=ENV, text=True, capture_output=True)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        return result

    def prepare(self, *args):
        return self.run_script("prepare", "--remote", f"file://{self.upstream}", "--deepen", "2",
                               "--checkout", str(self.root / "checkout"), *args)

    def test_shallow_checkout_deepens_to_the_complete_release_range(self):
        manifest = self.prepare("--base", "v0.1.0", "--candidate", "v0.2.0")
        self.assertEqual(manifest["status"], "complete")
        self.assertEqual((manifest["base"]["sha"], manifest["candidate"]["sha"]), (self.base, self.candidate))
        self.assertEqual(manifest["candidate"]["kind"], "release")
        self.assertEqual(manifest["commits"], 7)
        self.assertEqual(manifest["areas"], {"docs": 6, "hermes_cli": 1})
        self.assertIn({"module": "hermes_cli.profiles", "path": "hermes_cli/profiles.py", "commits": 1}, manifest["sidecarModules"])
        self.assertEqual(git(self.root / "checkout", "rev-parse", "HEAD"), self.candidate)
        self.assertEqual(self.prepare("--base", "v0.1.0", "--candidate", "v0.2.0"), manifest)

    def test_main_resolves_to_an_exact_unreleased_sha(self):
        self.commit("gateway/run.py", "pass\n", "unreleased")
        head = git(self.upstream, "rev-parse", "HEAD")
        manifest = self.prepare("--base", self.candidate, "--candidate", "main")
        self.assertEqual((manifest["status"], manifest["candidate"]["sha"], manifest["candidate"]["kind"]), ("complete", head, "unreleased"))
        self.assertEqual(manifest["commits"], 1)

    def test_old_side_branch_merged_after_the_base_is_not_counted_as_new(self):
        git(self.upstream, "checkout", "--quiet", "-b", "side", "v0.1.0")
        self.commit("tools/side.py", "pass\n", "side")
        git(self.upstream, "checkout", "--quiet", "main")
        self.commit("gateway/run.py", "pass\n", "after base")
        git(self.upstream, "merge", "--quiet", "--no-ff", "-m", "merge side", "side")
        manifest = self.prepare("--base", "v0.2.0", "--candidate", "main")
        self.assertEqual((manifest["status"], manifest["commits"], manifest["changedFiles"]), ("complete", 2, 2))

    def test_rewritten_history_is_reported_not_narrowed(self):
        git(self.upstream, "checkout", "--quiet", "--orphan", "rewritten")
        self.commit("README.md", "rewritten\n", "rewritten root")
        rewritten = git(self.upstream, "rev-parse", "HEAD")
        self.assertEqual(self.prepare("--base", self.base, "--candidate", rewritten)["status"], "not_ancestor")

    def test_missing_base_is_reported(self):
        self.assertEqual(self.prepare("--base", "0" * 40, "--candidate", "v0.2.0")["status"], "history_missing")

    def test_watermark_advances_only_its_own_field_and_is_idempotent(self):
        state = self.root / "state.json"
        state.write_text(json.dumps({"lastObserved": {"sha": "a" * 40}, "lastPassing": {"sha": "b" * 40},
                                     "lastReviewed": {"ref": "v0.1.0", "sha": self.base}}))
        manifest = self.prepare("--state", str(state), "--candidate", "v0.2.0")
        self.assertEqual((manifest["status"], manifest["base"]["sha"]), ("complete", self.base))
        report = self.root / "report.md"
        report.write_text(f"Reviewed {self.base}..{self.candidate}\n")
        self.run_script("advance", "--state", str(state), "--ref", "v0.2.0", "--sha", self.candidate, "--report", str(report))
        recorded = state.read_text()
        self.assertEqual(json.loads(recorded), {"lastObserved": {"sha": "a" * 40}, "lastPassing": {"sha": "b" * 40},
                                                "lastReviewed": {"ref": "v0.2.0", "sha": self.candidate}})
        self.run_script("advance", "--state", str(state), "--ref", "v0.2.0", "--sha", self.candidate, "--report", str(report))
        self.assertEqual(state.read_text(), recorded)
        self.assertEqual(self.prepare("--state", str(state), "--candidate", "v0.2.0")["status"], "already_reviewed")

    def test_watermark_refuses_incomplete_or_leaky_reports(self):
        state, report = self.root / "state.json", self.root / "report.md"
        for text in ("no candidate named\n", f"{self.candidate} in /Users/someone/agent\n",
                     f"{self.candidate} token ghp_{'a' * 36}\n"):
            report.write_text(text)
            result = self.run_script("advance", "--state", str(state), "--ref", "v0.2.0", "--sha", self.candidate,
                                     "--report", str(report), check=False)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse(state.exists())


if __name__ == "__main__":
    unittest.main()
