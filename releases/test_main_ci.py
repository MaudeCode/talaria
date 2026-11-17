"""main_ci.find against synthetic run and job listings; never calls GitHub (TAL-2396)."""

import subprocess
import unittest
from unittest.mock import patch

import main_ci

SHA, OTHER = "a" * 40, "b" * 40
HOSTED = "App / App hosted tests"
WEB = ["web / frontend / checks", *(f"web / frontend / e2e ({shard}/6)" for shard in range(1, 7)),
       *(f"web / server ({storage} storage, {shard})" for storage in ("json", "sqlite") for shard in ("1/3", "checks"))]


def run(identifier, sha=SHA, branch="main", event="push", path=".github/workflows/ci.yml", conclusion="success"):
    return {"id": identifier, "head_sha": sha, "head_branch": branch, "event": event, "path": path,
            "status": "completed" if conclusion else "in_progress", "conclusion": conclusion}


def job(run_id, name, conclusion="success", sha=SHA):
    return {"name": name, "head_sha": sha, "status": "completed" if conclusion else "in_progress", "conclusion": conclusion,
            "html_url": f"https://github.com/MaudeCode/talaria/actions/runs/{run_id}/job/{abs(hash(name)) % 1000}"}


class MainCITests(unittest.TestCase):
    def find(self, runs, jobs, *checks):
        self.reads = []

        def api(path):
            self.reads.append(path)
            if path.startswith(f"repos/MaudeCode/talaria/actions/workflows/ci.yml/runs?head_sha={SHA}&branch=main&event=push"):
                return [{"workflow_runs": runs}]
            identifier = int(path.split("/runs/")[1].split("/")[0])
            return [{"jobs": jobs.get(identifier, [])}]

        with patch.object(main_ci, "api", side_effect=api):
            return main_ci.find(SHA, list(checks or main_ci.CHECKS))

    def test_a_passed_suite_is_reused_whatever_its_siblings_did(self):
        # The suite's own jobs count, not the run's: a failed sibling, or a run still going, still lends its passed
        # suites. Each check finds its own suite.
        jobs = [job(7, HOSTED), job(7, "App / App hosted tests 1"), *(job(7, name) for name in WEB), job(7, "relay / check"),
                job(7, "web / Sidecar pytest against Agent v0.23.1 (2/3)", "failure"), job(7, "CI Gate", "failure")]
        for conclusion in ("failure", "cancelled", None):
            with self.subTest(run=conclusion):
                found = self.find([run(7, conclusion=conclusion)], {7: jobs})
                self.assertEqual(found, {"hosted_tests": jobs[0]["html_url"], "web_tests": jobs[2]["html_url"],
                                         "relay_tests": jobs[-3]["html_url"]})

    def test_a_partial_unfinished_or_failed_suite_is_never_reused(self):
        # Any job of the suite skipped, failed, cancelled, still running or on another commit, or a suite main CI left
        # out (its required jobs absent), means the release runs it; a single shard is not the suite.
        for broken in ("skipped", "failure", "cancelled", None, "other-sha"):
            for index in (0, 3, len(WEB) - 1):
                jobs = [job(7, name) for name in WEB]
                jobs[index] = job(7, WEB[index], sha=OTHER) if broken == "other-sha" else job(7, WEB[index], broken)
                with self.subTest(broken=broken, job=WEB[index]):
                    self.assertEqual(self.find([run(7)], {7: jobs}, "web_tests"), {"web_tests": ""})
        for missing in ("web / frontend / checks", "web / frontend / e2e (1/6)", "web / server (json storage, checks)"):
            with self.subTest(missing=missing):
                jobs = [job(7, name) for name in WEB if name != missing]
                self.assertEqual(self.find([run(7)], {7: jobs}, "web_tests"), {"web_tests": ""})
        partial = [job(7, "App / App hosted tests 1"), job(7, "release / app-hosted-tests / App hosted tests"),
                   job(7, "relay", "skipped")]
        self.assertEqual(self.find([run(7)], {7: partial}, "hosted_tests", "relay_tests"), {"hosted_tests": "", "relay_tests": ""})

    def test_only_a_main_push_run_of_ci_yml_on_exactly_the_sha_counts(self):
        # Another commit, branch, event (a pull request's run included) or workflow never counts, and its jobs are
        # never read.
        runs = [run(1, sha=OTHER), run(2, branch="feature"), run(3, event="pull_request"), run(4, event="workflow_dispatch"),
                run(5, path=".github/workflows/other.yml")]
        jobs = {identifier: [job(identifier, HOSTED)] for identifier in range(1, 6)}
        self.assertEqual(self.find(runs, jobs, "hosted_tests"), {"hosted_tests": ""})
        self.assertEqual(len(self.reads), 1)
        # A later qualifying run is found after an earlier one without the suite.
        found = self.find([run(5), run(6)], {5: [job(5, "App / App build")], 6: [job(6, HOSTED)]}, "hosted_tests")
        self.assertEqual(found, {"hosted_tests": job(6, HOSTED)["html_url"]})

    def test_a_lookup_that_cannot_finish_fails_and_only_a_full_sha_is_accepted(self):
        with patch.object(main_ci, "api", side_effect=subprocess.CalledProcessError(1, "gh-api-poll")):
            with self.assertRaises(subprocess.CalledProcessError):
                main_ci.find(SHA, ["hosted_tests"])
        for sha in ("", "main", SHA[:12], SHA + "0", SHA.upper()):
            with self.subTest(sha=sha), patch.object(main_ci, "api") as api, self.assertRaises(ValueError):
                main_ci.find(sha, ["hosted_tests"])
            api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
