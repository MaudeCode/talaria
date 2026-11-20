#!/usr/bin/env python3
"""The Agent main canary's plan and report (TAL-211) against a synthetic GitHub API; no network, Git or Agent."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("canary", ROOT / "scripts/agent-main-canary.py")
canary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canary)

REPOSITORY, REPOSITORY_ID, RUN_ID = "MaudeCode/talaria", 7, 500
OLD, NEW = "a" * 40, "b" * 40
ENV = {"GITHUB_REPOSITORY": REPOSITORY, "GITHUB_REPOSITORY_ID": str(REPOSITORY_ID), "GITHUB_RUN_ID": str(RUN_ID)}


def state_zip(state):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("state.json", json.dumps(state))
    return buffer.getvalue()


def artifact(identifier, created, run_id, branch="main", head_repository=REPOSITORY_ID):
    return {"id": identifier, "name": canary.ARTIFACT, "expired": False, "created_at": created,
            "workflow_run": {"id": run_id, "repository_id": REPOSITORY_ID, "head_repository_id": head_repository,
                             "head_branch": branch}}


class FakeGitHub:
    """Answers the artifact listing, artifact downloads and compare pages the canary reads; refuses anything else."""

    def __init__(self, artifacts=(), states=None, compare=None):
        self.routes = {f"repos/{REPOSITORY}/actions/artifacts?name={canary.ARTIFACT}&per_page=100":
                       json.dumps({"artifacts": list(artifacts)}).encode()}
        for identifier, state in (states or {}).items():
            self.routes[f"repos/{REPOSITORY}/actions/artifacts/{identifier}/zip"] = state_zip(state)
        for path, body in (compare or {}).items():
            self.routes[path] = json.dumps(body).encode()

    def __call__(self, path):
        if path not in self.routes:
            raise subprocess.CalledProcessError(1, ["gh", "api", path], stderr=b"HTTP 404: Not Found")
        return self.routes[path]


def run(argv, github, agent_main=NEW):
    stdout = io.StringIO()
    with patch.object(canary, "gh", github), patch.object(canary, "agent_main", return_value=agent_main), \
            patch.dict(os.environ, ENV), patch("sys.argv", ["agent-main-canary.py", *argv]), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
        try:
            canary.main()
            code = 0
        except SystemExit as exit:
            code = exit.code
    return code, stdout.getvalue()


class PlanTests(unittest.TestCase):
    def test_skips_only_a_commit_another_main_run_checked(self):
        # This run's own earlier attempt and a fork's pull request both saw NEW; only the older main run counts.
        github = FakeGitHub(
            artifacts=[artifact(3, "2026-11-19T03:00:00Z", RUN_ID), artifact(2, "2026-11-19T02:00:00Z", 400, head_repository=99),
                       artifact(1, "2026-11-18T03:00:00Z", 300)],
            states={1: {"lastObserved": OLD, "lastObservedResult": "failure", "lastPassing": None},
                    2: {"lastObserved": NEW}, 3: {"lastObserved": NEW}})
        for main, expected in ((NEW, "run=true"), (OLD, "run=false")):
            with self.subTest(main=main), tempfile.TemporaryDirectory() as directory:
                code, output = run(["plan", "--state-dir", directory], github, agent_main=main)
                self.assertEqual((code, output.splitlines()), (0, [f"sha={main}", expected]))
                self.assertEqual(json.loads((Path(directory) / "previous.json").read_text())["lastObserved"], OLD)

    def test_refuses_a_state_that_does_not_name_exact_commits(self):
        github = FakeGitHub(artifacts=[artifact(1, "2026-11-18T03:00:00Z", 300)], states={1: {"lastObserved": "main"}})
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "lastObserved is not an exact commit"):
            run(["plan", "--state-dir", directory], github)


class ReportTests(unittest.TestCase):
    def setUp(self):
        # 120 commits, oldest first, over two compare pages: the last holds only 20, fewer than the 50 listed.
        commits = [{"sha": f"{index:040x}", "commit": {"message": f"fix: change {index}\n\nbody"}} for index in range(120)]
        base = f"repos/{canary.AGENT_REPOSITORY}/compare/{OLD}...{NEW}?per_page=100"
        self.github = FakeGitHub(compare={
            base: {"status": "ahead", "total_commits": 120, "commits": commits[:100],
                   "files": [{"filename": "gateway/run_api.py"}, {"filename": "gateway/hub.py"}, {"filename": "README.md"}]},
            f"{base}&page=2": {"status": "ahead", "total_commits": 120, "commits": commits[100:]}})

    def report(self, directory, receipt, log=""):
        root = Path(directory)
        (root / "previous.json").write_text(json.dumps({"lastObserved": OLD, "lastObservedResult": "success", "lastPassing": OLD}))
        (root / "receipt.json").write_text(json.dumps(receipt))
        (root / "check.log").write_text(log)
        code, output = run(["report", "--state-dir", directory, "--sha", NEW, "--receipt", str(root / "receipt.json"),
                            "--log", str(root / "check.log")], self.github)
        return code, output, json.loads((root / "state.json").read_text())

    def test_a_pass_advances_both_commits_and_lists_the_range_newest_first(self):
        with tempfile.TemporaryDirectory() as directory:
            code, output, state = self.report(directory, {"kind": "canary", "sourceRevision": NEW, "result": "success",
                                                          "python": "3.14.1", "tests": {"passed": 5, "failed": 0, "skipped": 1}})
        self.assertEqual((code, state), (0, {"lastObserved": NEW, "lastObservedResult": "success", "lastPassing": NEW}))
        self.assertIn("Sidecar tests: 5 passed, 0 failed, 1 skipped.", output)
        self.assertIn("| fix: change 70 |", output)
        self.assertLess(output.index("fix: change 119 "), output.index("fix: change 70 "))
        self.assertNotIn("fix: change 69 ", output)
        self.assertIn("70 older commits", output)
        self.assertIn("`gateway` 2, `(root)` 1", output)

    def test_a_failure_keeps_the_last_passing_commit_and_shows_bounded_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            junit = Path(directory) / "receipt.junit.xml"
            junit.write_text('<testsuite><testcase classname="tests.test_state" name="test_write">'
                             '<failure message="AssertionError: session not written">trace</failure></testcase></testsuite>')
            # The checker prints its receipt, then re-raises with only the command; the probe's own error comes before.
            log = "\n".join([*(f"setup line {index}" for index in range(100)), "AssertionError: sync_session_start",
                              '{"kind": "canary", "result": "failure"}', "subprocess.CalledProcessError: reraised"])
            code, output, state = self.report(directory, {"kind": "canary", "sourceRevision": NEW, "result": "failure",
                                                          "failure": "probe exited 1"}, log)
        self.assertEqual((code, state), (1, {"lastObserved": NEW, "lastObservedResult": "failure", "lastPassing": OLD}))
        self.assertIn(f"Last passing Agent main: [`{OLD[:10]}`]", output)
        self.assertIn("tests.test_state::test_write: AssertionError: session not written", output)
        self.assertIn("AssertionError: sync_session_start", output)
        self.assertNotIn("setup line 60\n", output)
        self.assertNotIn("reraised", output)
        self.assertIn("::error title=Agent main canary failed::", output)

    def test_a_receipt_for_another_commit_is_a_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            code, output, state = self.report(directory, {"kind": "canary", "sourceRevision": OLD, "result": "success"})
        self.assertEqual((code, state["lastPassing"]), (1, OLD))
        self.assertIn("not a canary of this Agent commit", output)


if __name__ == "__main__":
    unittest.main()
