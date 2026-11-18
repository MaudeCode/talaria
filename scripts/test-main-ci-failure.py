#!/usr/bin/env python3
"""Main CI failure handoff and the pull request failure report over fake GitHub, HTTP and T3 inventories; no live
service is contacted."""

import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import re
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout

SCRIPT = Path(__file__).with_name("main-ci-failure.py")
spec = importlib.util.spec_from_file_location("handoff", SCRIPT)
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)

REPO = "MaudeCode/talaria"
RUN = 39044400896
HEAD = "a7ed1110117b732aad8a765fb6eea50c4bd6d393"
NEWER = "b" * 40
SECRET = "synthetic-signing-secret"
SIDECAR = [f"web / Sidecar pytest against Agent v0.22.{patch}" for patch in range(3)]
TIMEOUT = [{"message": "The job running on runner X has exceeded the maximum execution time of 30 minutes."}]


def job(identifier, name, conclusion="success", status="completed", attempt=1, step="Run the suite",
        completed="2026-11-17T10:00:00Z"):
    """A completed job of one attempt; a failed one names its failed step, as GitHub does unless the runner was lost."""
    steps = [{"name": "Set up job", "conclusion": "success"}]
    if conclusion == "failure" and step:
        steps.append({"name": step, "conclusion": "failure"})
    return {"id": identifier, "name": name, "status": status, "conclusion": conclusion, "run_attempt": attempt,
            "steps": steps, "started_at": "2026-11-17T09:00:00Z", "completed_at": completed,
            "html_url": f"https://github.com/{REPO}/actions/runs/{RUN}/job/{identifier}"}


def tal_1102_jobs():
    """The TAL-1102 incident: three failed sidecar jobs, skipped suites and the failed gate."""
    return [job(1, "Detect changed paths"), job(2, "tooling / Repository Tooling"), job(3, "web / server"),
            job(4, "relay", "skipped"), job(5, "App / App build", "skipped"),
            *(job(10 + index, name, "failure") for index, name in enumerate(SIDECAR)),
            job(20, "CI Gate", "failure"), job(21, handoff.ALERT, None, "in_progress")]


def main_run(**fields):
    return {"id": RUN, "run_attempt": 1, "run_number": 1975, "head_sha": HEAD, "head_branch": "main", "event": "push",
            "path": ".github/workflows/ci.yml", "conclusion": "failure", "updated_at": "2026-11-17T10:00:00Z",
            "html_url": f"https://github.com/{REPO}/actions/runs/{RUN}", "pull_requests": [],
            "repository": {"full_name": REPO}, "head_repository": {"full_name": REPO}, **fields}


class FakeGitHub:
    """GitHub as the scripts read it. Jobs carry their attempt: filter=latest serves each job's latest attempt, as
    GitHub does, and filter=all every attempt. Other runs are served by ID; any other path fails the test."""

    def __init__(self, jobs, annotations=None, run=None, runs=(), pulls=(), position="identical", logs=None,
                 others=None, workflows=None):
        self.jobs, self.annotations, self.paths, self.logs = jobs, annotations or {}, [], logs or {}
        self.run = main_run(**(run or {}))
        self.runs, self.pulls, self.position = list(runs), list(pulls), position
        self.others, self.workflows = others or {}, workflows or {}

    def get(self, path):
        self.paths.append(path)
        if "/jobs?" in path:
            run_id = int(re.search(r"/runs/(\d+)/jobs", path).group(1))
            found = self.others[run_id][1] if run_id in self.others else self.jobs
            if "filter=latest" in path:
                latest = {}
                for item in found:
                    latest[item["name"]] = max(latest.get(item["name"], 0), item.get("run_attempt", 1))
                found = [item for item in found if item.get("run_attempt", 1) == latest[item["name"]]]
            else:
                assert "filter=all" in path, path
            page = int(re.search(r"page=(\d+)$", path).group(1))
            return {"total_count": len(found), "jobs": found[(page - 1) * 100:page * 100]}
        if "/annotations" in path:
            return self.annotations.get(int(path.split("/")[-2]), [])
        if path.endswith(f"/actions/runs/{RUN}"):
            return self.run
        if (found := re.search(r"/actions/runs/(\d+)$", path)) and int(found.group(1)) in self.others:
            return self.others[int(found.group(1))][0]
        if "/compare/" in path:
            return {"status": self.position}
        if "/workflows/ci.yml/runs?branch=main" in path:
            return {"workflow_runs": self.runs}
        if (found := re.search(r"/workflows/([\w-]+\.yml)/runs\?per_page=100$", path)):
            return {"workflow_runs": self.workflows.get(found.group(1), [])}
        if "/pulls?" in path:
            return self.pulls
        raise AssertionError(path)

    def log(self, job_id):
        self.paths.append(f"log {job_id}")
        return self.logs.get(job_id, "")


def env(**overrides):
    return {"GITHUB_REPOSITORY": REPO, "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/main",
            "GITHUB_WORKFLOW_REF": f"{REPO}/.github/workflows/ci.yml@refs/heads/main", "GITHUB_WORKFLOW": "CI",
            "GITHUB_RUN_ID": str(RUN), "GITHUB_RUN_ATTEMPT": "1", "GITHUB_SHA": HEAD,
            "GITHUB_SERVER_URL": "https://github.com", "GATE_RESULT": "failure",
            "WEBHOOK_URL": "http://127.0.0.1:9/synthetic-token", "WEBHOOK_SECRET": SECRET, **overrides}


class Receiver:
    """A local stand-in for T3's native webhook receiver: records requests and answers a scripted status list.

    Like the real receiver's edge, it refuses Python's default `Python-urllib/*` User-Agent with HTTP 403 (Cloudflare
    error 1010) before the request reaches T3: every main handoff from October to TAL-2397 was refused that way.
    """

    def __init__(self, statuses):
        self.statuses, self.requests = list(statuses), []
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["content-length"]))
                if (self.headers.get("user-agent") or "").startswith("Python-urllib/"):
                    self.send_response(403)
                    self.end_headers()
                    return
                receiver.requests.append(({key.lower(): value for key, value in self.headers.items()}, body))
                self.send_response(receiver.statuses.pop(0) if receiver.statuses else 200)
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/hooks/synthetic-token"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def verify(header, body, secret=SECRET):
    """T3's configured check: x-hub-signature-256, hex encoding, sha256= prefix, HMAC-SHA256 of the exact body."""
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header, expected)


class SendTests(unittest.TestCase):
    def send(self, github, receiver=None, **overrides):
        lines = []
        if receiver:
            overrides.setdefault("WEBHOOK_URL", receiver.url)
        status = handoff.send(env(**overrides), github, sleep=lambda _: None, out=lines.append)
        return status, "\n".join(lines)

    def receiver(self, statuses=()):
        receiver = Receiver(statuses)
        self.addCleanup(receiver.close)
        return receiver

    def test_other_events_refs_repositories_and_workflows_send_nothing(self):
        for overrides in ({"GITHUB_EVENT_NAME": "pull_request"}, {"GITHUB_REF": "refs/heads/feature"},
                          {"GITHUB_REPOSITORY": "someone/talaria"},
                          {"GITHUB_WORKFLOW_REF": f"{REPO}/.github/workflows/web-verify.yml@refs/heads/main"}):
            github = FakeGitHub(tal_1102_jobs())
            status, output = self.send(github, self.receiver(), **overrides)
            self.assertEqual((status, github.paths), (0, []), overrides)
            self.assertIn("nothing to send", output)

    def test_clean_run_and_skipped_suites_send_nothing(self):
        receiver = self.receiver()
        status, output = self.send(FakeGitHub([job(1, "Detect changed paths"), job(2, "relay", "skipped"),
                                               job(3, "CI Gate")]), receiver)
        self.assertEqual((status, receiver.requests), (0, []))
        self.assertIn("nothing to send", output)

    def test_manual_cancellation_without_a_failure_sends_nothing(self):
        receiver = self.receiver()
        jobs = [job(1, "Detect changed paths"), job(2, "web / server", "cancelled"), job(3, "CI Gate", "failure")]
        status, _ = self.send(FakeGitHub(jobs), receiver)
        self.assertEqual((status, receiver.requests), (0, []))

    def test_timeout_alerts_even_when_cancellation_masks_the_gate(self):
        jobs = [job(1, "web / server", "cancelled"), job(2, "App / App hosted tests", "cancelled"),
                job(3, "CI Gate", "failure")]
        failures = handoff.failed_jobs(FakeGitHub(jobs, {2: TIMEOUT}), RUN)
        self.assertEqual([(item["name"], item["conclusion"]) for item in failures],
                         [("App / App hosted tests", "timed_out")])

    def test_each_component_failure_alerts(self):
        for name in ("App / App build", "App tooling", "web / frontend / checks", "web-docker", "relay",
                     "Web contract probe", "tooling / Repository Tooling", "Detect changed paths"):
            failures = handoff.failed_jobs(FakeGitHub([job(1, name, "failure"), job(2, "CI Gate", "failure")]), RUN)
            self.assertEqual([item["name"] for item in failures], [name, "CI Gate"])

    def test_gate_failure_alone_alerts(self):
        failures = handoff.failed_jobs(FakeGitHub([job(1, "Detect changed paths"), job(2, "CI Gate", "failure")]), RUN)
        self.assertEqual([item["name"] for item in failures], ["CI Gate"])

    def test_jobs_are_paginated_from_the_latest_attempt(self):
        jobs = [job(index, f"web / frontend / e2e {index}") for index in range(1, 150)] + [job(150, "relay", "failure")]
        github = FakeGitHub(jobs)
        self.assertEqual([item["name"] for item in handoff.failed_jobs(github, RUN)], ["relay"])
        self.assertEqual(sum("/jobs?" in path for path in github.paths), 2)

    def test_exact_body_is_signed_bounded_and_carries_no_secret(self):
        receiver = self.receiver()
        status, output = self.send(FakeGitHub(tal_1102_jobs()), receiver)
        self.assertEqual((status, len(receiver.requests)), (0, 1))
        headers, body = receiver.requests[0]
        self.assertTrue(verify(headers["x-hub-signature-256"], body))
        self.assertFalse(verify(headers["x-hub-signature-256"], body + b" "))
        self.assertFalse(verify(headers["x-hub-signature-256"], body, "another-secret"))
        report = json.loads(body)
        self.assertEqual((report["repository"], report["workflow"]["path"], report["run"]["id"],
                          report["run"]["attempt"], report["head_sha"], report["gate"]),
                         (REPO, ".github/workflows/ci.yml", RUN, 1, HEAD, "failure"))
        self.assertEqual([item["name"] for item in report["failed_jobs"]], [*SIDECAR, "CI Gate"])
        self.assertNotIn(SECRET.encode(), body)
        self.assertNotIn(b"synthetic-token", body)
        self.assertIn("4 failed job(s)", output)

    def test_report_is_bounded(self):
        jobs = [job(index, "relay " + "x" * 500, "failure") for index in range(1, 31)]
        report = json.loads(handoff.report(env(), handoff.failed_jobs(FakeGitHub(jobs), RUN)))
        self.assertEqual((len(report["failed_jobs"]), report["failed_jobs_truncated"]), (20, True))
        self.assertTrue(all(len(item["name"]) == handoff.MAX_NAME for item in report["failed_jobs"]))

    def test_transient_errors_retry_then_deliver(self):
        receiver = self.receiver([503, 429])
        status, _ = self.send(FakeGitHub(tal_1102_jobs()), receiver)
        self.assertEqual((status, len(receiver.requests)), (0, 3))
        self.assertEqual(len({body for _, body in receiver.requests}), 1)

    def test_delivery_failure_is_visible_bounded_and_redacted(self):
        receiver = self.receiver([500, 500, 500, 500])
        status, output = self.send(FakeGitHub(tal_1102_jobs()), receiver)
        self.assertEqual((status, len(receiver.requests)), (1, 3))
        self.assertIn("::error::", output)
        self.assertIn("HTTP 500 after 3 attempts", output)
        self.assertNotIn(receiver.url, output)
        self.assertNotIn("synthetic-token", output)
        self.assertNotIn(SECRET, output)

    def test_rejected_signature_is_not_retried(self):
        receiver = self.receiver([401])
        status, output = self.send(FakeGitHub(tal_1102_jobs()), receiver)
        self.assertEqual((status, len(receiver.requests)), (1, 1))
        self.assertIn("HTTP 401", output)

    def test_unreachable_receiver_fails_visibly(self):
        status, output = self.send(FakeGitHub(tal_1102_jobs()))
        self.assertEqual(status, 1)
        self.assertIn("delivery failed", output)
        self.assertNotIn("127.0.0.1", output)

    def test_missing_secrets_fail_visibly(self):
        status, output = self.send(FakeGitHub(tal_1102_jobs()), WEBHOOK_SECRET="")
        self.assertEqual(status, 1)
        self.assertIn("MAIN_CI_WEBHOOK_SECRET", output)


# The ticket's cases (TAL-2397): PR run 44167520053's first hosted shard failed a named XCTest assertion and attempt 2
# passed; release run 44101199226 failed preparing its simulator; release run 44079683758 failed an Agent shard.
FLAKY = "TalariaTests/DuoFoldHostedTests/testAnExpandedDisclosureStaysExpandedAcrossClosingAndOpening"
FLAKY_LOG = ("App / App hosted tests 4\tTest without building\t2026-11-17T20:29:26Z Test Case "
             "'-[TalariaTests.DuoFoldHostedTests testAnExpandedDisclosureStaysExpandedAcrossClosingAndOpening]' "
             "failed (17.614 seconds).\n")
PULL = {"event": "pull_request", "head_branch": "fix/TAL-1978-deep-link-root-replacement",
        "pull_requests": [{"number": 1810}]}
RELEASE = {"event": "workflow_dispatch", "path": ".github/workflows/production-cutover.yml"}


def thread(identity, status="running", identifier="repair-1"):
    return {"threadId": identifier, "title": handoff.title(identity), "status": status}


def flaky_shard(passed=True, shard="App / App hosted tests 4", gate="CI Gate"):
    jobs = [job(1, "Detect changed paths"), job(4, shard, "failure", step="Test without building"),
            job(9, gate, "failure")]
    if passed:
        jobs += [job(14, shard, attempt=2, completed="2026-11-17T11:00:00Z"), job(19, gate, attempt=2)]
    return jobs


class TriageTests(unittest.TestCase):
    def triage(self, threads=(), run_id=RUN, since=None, **github):
        github.setdefault("logs", {4: FLAKY_LOG})
        scanned = {"since": since} if since else {}
        return handoff.triage(FakeGitHub(github.pop("jobs", tal_1102_jobs()), **github), run_id, list(threads), **scanned)

    def test_tal_1102_incident_launches_one_repair_for_all_sidecar_jobs(self):
        decision = self.triage()
        self.assertEqual(decision["action"], "launch")
        first = f"{SIDECAR[0]} › Run the suite"
        self.assertEqual((decision["title"], decision["incident"]), (handoff.title(first), handoff.key(first)))
        self.assertEqual(decision["workspaceStrategy"], {"type": "worktree", "baseRef": "main", "startFromOrigin": True})
        for name in SIDECAR:
            self.assertIn(f"- {name} (failed step, attempt 1): step “Run the suite”. Focused command: `scripts/check "
                          "web`.", decision["message"])
        self.assertIn(f"main-ci-incident: {handoff.key(first)}", decision["message"])
        self.assertNotIn("CI Gate", decision["message"])
        self.assertNotIn("synthetic-token", json.dumps(decision))

    def test_malformed_and_untrusted_runs_are_rejected(self):
        for run_id in ("", "0", "12; rm -rf /", "1" * 21, "../runs/1"):
            self.assertEqual(self.triage(run_id=run_id)["action"], "reject", run_id)
        for run in ({"event": "workflow_dispatch"}, {"head_branch": "feature"}, {"path": ".github/workflows/x.yml"},
                    {"head_repository": {"full_name": "someone/talaria"}}, {"repository": {"full_name": "a/b"}},
                    {"head_sha": "not-a-sha"}, RELEASE | {"head_branch": "feature"},
                    RELEASE | {"head_repository": {"full_name": "someone/talaria"}}, RELEASE | {"event": "push"}):
            self.assertEqual(self.triage(run=run)["action"], "reject", run)
        self.assertEqual(self.triage(position="diverged")["action"], "reject")
        self.assertEqual(self.triage(run=RELEASE, position="diverged")["action"], "reject")

    def test_a_later_green_main_run_supersedes_only_a_failure_no_rerun_passed(self):
        self.assertEqual(self.triage(jobs=[job(1, "relay"), job(2, "CI Gate")])["action"], "noop")
        later = [{"id": 2, "run_number": 1980, "head_sha": NEWER, "conclusion": "success"}]
        decision = self.triage(runs=later)
        self.assertEqual(decision["action"], "noop")
        self.assertIn("superseded", decision["reason"])
        older = [{"id": 3, "run_number": 1970, "head_sha": NEWER, "conclusion": "success"},
                 {"id": 4, "run_number": 1981, "head_sha": NEWER, "conclusion": "failure"}]
        self.assertEqual(self.triage(runs=older)["action"], "launch")
        # A green rerun of the same head is intermittent evidence, not a fix.
        decision = self.triage(jobs=flaky_shard(), runs=later)
        self.assertEqual((decision["action"], decision["incident"]), ("launch", handoff.key(FLAKY)))

    def test_a_pull_request_failure_a_rerun_passed_names_the_failing_test(self):
        decision = self.triage(jobs=flaky_shard(), run=PULL)
        self.assertEqual((decision["action"], decision["title"]), ("launch", handoff.title(FLAKY)))
        self.assertIn(f"test `{FLAKY}`; attempt 2 passed the same job, so it is intermittent", decision["message"])
        self.assertIn(f"`app/scripts/test-ios --repeat 3 {FLAKY}`", decision["message"])
        self.assertIn(f"pull request #1810 run at its head {HEAD}", decision["message"])
        self.assertIn(f"Check out {HEAD} detached", decision["message"])

    def test_a_pull_request_failure_no_rerun_passed_stays_with_its_owner(self):
        decision = self.triage(jobs=flaky_shard(passed=False), run=PULL)
        self.assertEqual(decision["action"], "noop")
        self.assertIn("owner", decision["reason"])
        # Unless that test already has a repair: the report is more evidence for it.
        decision = self.triage([thread(FLAKY)], jobs=flaky_shard(passed=False), run=PULL)
        self.assertEqual((decision["action"], decision["threadId"]), ("reuse", "repair-1"))

    def test_a_fork_failure_is_reproduced_on_main_only(self):
        decision = self.triage(jobs=flaky_shard(), run=PULL | {"head_repository": {"full_name": "someone/talaria"}})
        self.assertEqual(decision["action"], "launch")
        self.assertIn("Never check out, build or run this fork's code", decision["message"])
        self.assertNotIn(f"Check out {HEAD}", decision["message"])

    def test_a_simulator_preparation_fault_is_routed_not_repaired_as_a_test(self):
        jobs = [job(1, "release / prepare"),
                job(2, "release / app-hosted-tests / App hosted tests 1", "failure", step="Wait for the simulator"),
                job(3, "release / build-gate", "failure", step="Require every selected build and compatibility gate")]
        notes = {2: [{"annotation_level": "failure", "message": "Process completed with exit code 124."}]}
        decision = self.triage(jobs=jobs, run=RELEASE, annotations=notes)
        self.assertEqual(decision["action"], "noop")
        self.assertIn("App hosted tests 1: runner fault", decision["reason"])
        self.assertIn("harness owner", decision["reason"])

    def test_a_release_agent_shard_failure_launches_a_repair_and_publication_is_routed(self):
        jobs = [job(1, "release / agent v0.23.2 3/3", "failure",
                    step="Verify recorded Web and Agent identity and this supported Agent release's shard"),
                job(2, "release / web-publish", "failure", step="Publish the npm package"),
                job(3, "release / build-gate", "failure", step="Require every selected build and compatibility gate")]
        decision = self.triage(jobs=jobs, run=RELEASE)
        self.assertEqual(decision["action"], "launch")
        message = decision["message"]
        self.assertIn("`python3 scripts/check-agent-compatibility.py --skip-docker --release v0.23.2 --shard 3/3`",
                      message)
        self.assertIn("Not yours: release / web-publish (Publish the npm package): release publication", message)
        self.assertIn("release recovery path can re-release from; you never start a release", message)
        self.assertNotIn("build-gate (", message)

    def test_repeat_deliveries_attempts_and_lanes_reuse_the_incident_thread(self):
        for status in ("preparing", "starting", "running", "waiting", "idle", "interrupted", "completed"):
            for run, jobs in ((None, flaky_shard()), (PULL, flaky_shard()), (RELEASE, flaky_shard(
                    shard="release / app-hosted-tests / App hosted tests 4", gate="release / build-gate"))):
                decision = self.triage([thread(FLAKY, status)], jobs=jobs, run=run)
                self.assertEqual((decision["action"], decision["threadId"]), ("reuse", "repair-1"), (status, run))
                self.assertIn("reported again", decision["message"])

    def test_failed_launches_are_retried_within_a_bound(self):
        first = f"{SIDECAR[0]} › Run the suite"
        self.assertEqual(self.triage([thread(first, "failed")])["action"], "launch")
        decision = self.triage([thread(first, "failed"), thread(SIDECAR[2] + " › Run the suite", "cancelled", "t2")])
        self.assertEqual(decision["action"], "noop")
        self.assertIn("operator", decision["reason"])

    def test_an_open_repair_pr_owns_its_incident(self):
        first = f"{SIDECAR[1]} › Run the suite"
        pulls = [{"number": 7, "body": f"main-ci-incident: {HEAD}"},
                 {"number": 9, "body": f"Fix\n\nmain-ci-incident: {handoff.key(first)}"}]
        decision = self.triage(pulls=pulls)
        self.assertEqual(decision["action"], "noop")
        self.assertIn("#9", decision["reason"])
        self.assertEqual(self.triage(pulls=pulls[:1])["action"], "launch")

    def test_a_scan_skips_failures_it_already_saw(self):
        decision = self.triage(since="2026-11-17T10:00:01Z")
        self.assertEqual((decision["action"], decision.get("quiet")), ("noop", True))
        # A rerun that passed after the window opened is news: the failure turned out intermittent.
        self.assertEqual(self.triage(jobs=flaky_shard(), since="2026-11-17T10:30:00Z")["action"], "launch")


class ScanTests(unittest.TestCase):
    def test_one_launch_per_incident_and_only_runs_updated_in_the_window(self):
        pull_run = main_run(id=RUN + 1, **PULL, run_attempt=2, conclusion="success", updated_at="2026-11-17T11:00:00Z")
        stale = main_run(id=RUN + 2, updated_at="2026-11-17T08:00:00Z")
        clean = main_run(id=RUN + 3, conclusion="success", updated_at="2026-11-17T11:00:00Z")
        github = FakeGitHub(flaky_shard(), logs={4: FLAKY_LOG}, others={
            RUN + 1: (pull_run, flaky_shard()), RUN + 2: (stale, tal_1102_jobs()), RUN + 3: (clean, [])},
            workflows={"ci.yml": [main_run(updated_at="2026-11-17T11:00:00Z"), pull_run, stale, clean]})
        decisions = handoff.scan(github, [], "2026-11-17T10:30:00Z")
        self.assertEqual([(item["run"], item["action"]) for item in decisions], [(RUN, "launch"), (RUN + 1, "noop")])
        self.assertIn(f"same incident as run {RUN}", decisions[1]["reason"])
        self.assertFalse(any(f"/runs/{RUN + 2}" in path or f"/runs/{RUN + 3}" in path for path in github.paths))


class LandTests(unittest.TestCase):
    BODY = "Fix\n\nmain-ci-incident: 0123456789ab\n\n## Regression proof\n\nred then green"

    def github(self, head=HEAD, gate="success", body=BODY, fork=False, contains=True):
        github = FakeGitHub([])
        pull = {"number": 42, "state": "open", "title": "TAL-1: Fix the leak", "body": body, "base": {"ref": "main"},
                "head": {"sha": head, "repo": {"full_name": "someone/talaria" if fork else REPO}}}
        sent = []

        def get(path):
            github.paths.append(path)
            if path.endswith("/pulls/42"):
                return pull
            if "/check-runs?" in path:
                return {"check_runs": [{"name": "CI Gate", "conclusion": gate}] if gate else []}
            if "/compare/" in path:
                return {"status": "ahead" if contains else "diverged"}
            raise AssertionError(path)

        github.get, github.sent = get, sent
        github.send = lambda method, path, body: sent.append((method, path, body)) or {"sha": NEWER}
        return github

    def land(self, github, head=HEAD):
        lines = []
        return handoff.land(github, 42, head, lines.append), "\n".join(lines)

    def test_merges_the_exact_head_and_reads_it_back(self):
        github = self.github()
        status, output = self.land(github)
        self.assertEqual(status, 0)
        self.assertEqual(github.sent, [("PUT", f"repos/{REPO}/pulls/42/merge",
                                        {"sha": HEAD, "merge_method": "squash", "commit_title": "TAL-1: Fix the leak (#42)"})])
        self.assertEqual(json.loads(output), {"merged": 42, "commit": NEWER, "verified_on": "main"})

    def test_refuses_a_moved_head_a_red_gate_a_fork_or_a_missing_proof(self):
        for github, reason in ((self.github(head=NEWER), f"the head moved to {NEWER}"),
                               (self.github(gate="failure"), "CI Gate has not passed"),
                               (self.github(gate=None), "CI Gate has not passed"),
                               (self.github(fork=True), "not in this repository"),
                               (self.github(body="Fix\n\n## Regression proof"), "no `main-ci-incident:` line"),
                               (self.github(body="main-ci-incident: 0123456789ab"), "no Regression proof")):
            status, output = self.land(github)
            self.assertEqual((status, github.sent), (1, []), reason)
            self.assertIn(reason, output)

    def test_a_refused_or_unverified_merge_is_not_reported_merged(self):
        status, output = self.land(self.github(contains=False))
        self.assertEqual(status, 1)
        self.assertIn("read it back before closing", output)
        github = self.github()

        def refuse(method, path, body):
            raise subprocess.CalledProcessError(1, "gh", stderr="HTTP 405: Required status check is expected")

        github.send = refuse
        status, output = self.land(github)
        self.assertEqual(status, 1)
        self.assertIn("GitHub refused to merge PR #42", output)


# The repair path end to end (TAL-2397): a disposable origin and clone hold a synthetic test that fails only after its
# predecessor (the `leak` rule), and a GitHub stand-in merges into that origin. The worker's steps are scripted here;
# in T3 the repair thread follows its brief.
SUITE = """import unittest

CACHE = {}


class Cache(unittest.TestCase):
    def test_a_fills_the_cache(self):
        CACHE["user"] = "a"

    def test_b_starts_empty(self):
        self.assertEqual(CACHE, {}, "a predecessor left its cache behind")
"""
FIXED = SUITE.replace('        CACHE["user"]', '        self.addCleanup(CACHE.clear)\n        CACHE["user"]')
# Git reads no host configuration (identity, signing, hooks): the repository is the test's own.
GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "Synthetic",
           "GIT_AUTHOR_EMAIL": "synthetic@example.invalid", "GIT_COMMITTER_NAME": "Synthetic",
           "GIT_COMMITTER_EMAIL": "synthetic@example.invalid"}


class DisposableRepository:
    def __init__(self, root):
        self.root, self.origin, self.work = root, root / "origin.git", root / "work"
        self.git("init", "-q", "--bare", "-b", "main", str(self.origin), cwd=root)
        self.git("clone", "-q", str(self.origin), str(self.work), cwd=root)
        self.write(SUITE, "Add the cache suite")
        self.git("push", "-q", "origin", "HEAD:main")

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.work, env=GIT_ENV, capture_output=True, text=True,
                              check=True).stdout.strip()

    def write(self, suite, message):
        (self.work / "tests").mkdir(exist_ok=True)
        (self.work / "tests" / "__init__.py").write_text("")
        (self.work / "tests" / "test_cache.py").write_text(suite)
        self.git("add", "tests")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def main(self):
        return self.git("rev-parse", "main", cwd=self.origin)

    def contains(self, commit):
        return subprocess.run(["git", "merge-base", "--is-ancestor", commit, "main"], cwd=self.origin, env=GIT_ENV,
                              capture_output=True).returncode == 0

    def squash(self, branch, title):
        self.git("checkout", "-q", "main")
        self.git("pull", "-q", "--ff-only", "origin", "main")
        self.git("merge", "-q", "--squash", f"origin/{branch}")
        self.git("commit", "-q", "-m", title)
        self.git("push", "-q", "origin", "HEAD:main")
        return self.git("rev-parse", "HEAD")

    def repeat(self, attempts, target, cwd=None):
        """Runs one unittest target up to `attempts` times; returns (runs, the first failure's output or None)."""
        for run in range(1, attempts + 1):
            result = subprocess.run([sys.executable, "-B", "-m", "unittest", target], cwd=cwd or self.work,
                                    capture_output=True, text=True)
            if result.returncode:
                return run, result.stderr
        return attempts, None


class RepositoryGitHub(FakeGitHub):
    """The disposable repository's GitHub: its run, its one repair PR, CI Gate per commit, and a squash merge."""

    def __init__(self, repository, jobs):
        super().__init__(jobs, run={"head_sha": repository.main()})
        self.repository, self.pull, self.gate = repository, None, {}

    def get(self, path):
        if self.pull and path.endswith(f"/pulls/{self.pull['number']}"):
            self.paths.append(path)
            return self.pull
        if "/pulls?" in path:
            self.paths.append(path)
            return [self.pull] if self.pull and self.pull["state"] == "open" else []
        if found := re.search(r"/commits/([0-9a-f]{40})/check-runs\?check_name=CI%20Gate", path):
            self.paths.append(path)
            gate = self.gate.get(found.group(1))
            return {"check_runs": [{"name": "CI Gate", "conclusion": gate}] if gate else []}
        if (found := re.search(r"/compare/([0-9a-f]{40})\.\.\.main$", path)) and found.group(1) != HEAD:
            self.paths.append(path)
            return {"status": "ahead" if self.repository.contains(found.group(1)) else "diverged"}
        return super().get(path)

    def send(self, method, path, body):
        self.paths.append(path)
        assert (method, path) == ("PUT", f"repos/{REPO}/pulls/{self.pull['number']}/merge"), path
        if body["sha"] != self.pull["head"]["sha"]:
            raise subprocess.CalledProcessError(1, "gh", stderr="HTTP 409: Head branch was modified")
        self.pull["state"] = "closed"
        return {"sha": self.repository.squash(self.pull["head"]["ref"], body["commit_title"])}


class RepairPathTests(unittest.TestCase):
    def test_an_intermittent_test_goes_from_failure_to_a_verified_merge_with_no_operator(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        repository = DisposableRepository(Path(os.path.realpath(root.name)))
        github = RepositoryGitHub(repository, [job(1, "tooling / Repository Tooling", "failure",
                                                   step="Run the synthetic suite"), job(2, "CI Gate", "failure")])
        receiver = Receiver([])
        self.addCleanup(receiver.close)

        # CI signs its report; the receiver verifies it and hands the run ID to triage, as the T3 webhook task does.
        sent = []
        self.assertEqual(handoff.send(env(WEBHOOK_URL=receiver.url, GITHUB_SHA=repository.main()), github,
                                      sleep=lambda _: None, out=sent.append), 0)
        headers, body = receiver.requests[0]
        self.assertTrue(verify(headers["x-hub-signature-256"], body))
        run_id = json.loads(body)["run"]["id"]
        decision = handoff.triage(github, run_id, [])
        self.assertEqual(decision["action"], "launch")
        threads = [{"threadId": "worker", "title": decision["title"], "status": "running"}]

        # A redelivery and a green rerun of the same commit reach the same worker and keep the incident.
        github.jobs += [job(11, "tooling / Repository Tooling", attempt=2), job(12, "CI Gate", attempt=2)]
        again = handoff.triage(github, run_id, threads)
        self.assertEqual((again["action"], again["threadId"]), ("reuse", "worker"))
        self.assertIn("attempt 2 passed the same job, so it is intermittent", again["message"])

        # The worker reproduces at the failing commit: the test passes alone and fails after its predecessor.
        self.assertEqual(repository.repeat(5, "tests.test_cache.Cache.test_b_starts_empty"), (5, None))
        runs, failure = repository.repeat(5, "tests.test_cache")
        self.assertEqual(runs, 1)
        self.assertIn("a predecessor left its cache behind", failure)

        # The root-cause patch (rule `leak`) passes the same command and repetitions.
        repository.git("checkout", "-q", "-b", "fix/TAL-9999-cache-leak")
        head = repository.write(FIXED, "TAL-9999: Clear the cache test_a_fills_the_cache fills")
        self.assertEqual(repository.repeat(5, "tests.test_cache"), (5, None))
        repository.git("push", "-q", "origin", "HEAD")
        github.pull = {"number": 42, "state": "open", "title": "TAL-9999: Clear the cache the first test fills",
                       "base": {"ref": "main"}, "head": {"sha": head, "ref": "fix/TAL-9999-cache-leak",
                                                         "repo": {"full_name": REPO}},
                       "body": f"Defect rule: leak\n\nmain-ci-incident: {decision['incident']}\n\n## Regression proof\n\n"
                               f"`python3 -m unittest tests.test_cache` failed at attempt 1 on {repository.main()} "
                               f"and passed 5 of 5 at {head}."}

        # A restarted dispatcher that lost the thread finds the PR and opens no competing repair.
        self.assertEqual(handoff.triage(github, run_id, [])["action"], "noop")

        # Merging waits for CI Gate on the exact head, then merges it and reads the merge back on main.
        out = []
        self.assertEqual(handoff.land(github, 42, head, out.append), 1)
        github.gate[head] = "success"
        self.assertEqual(handoff.land(github, 42, head, out.append), 0)
        merged = json.loads(out[-1])["commit"]
        self.assertTrue(repository.contains(merged))
        clone = repository.root / "verify"
        repository.git("clone", "-q", str(repository.origin), str(clone), cwd=repository.root)
        self.assertEqual(repository.repeat(5, "tests.test_cache", cwd=clone), (5, None))

        # Only this repository's GitHub API took part: no Factory API, job or ticket claim.
        self.assertEqual([path for path in github.paths if not path.startswith((f"repos/{REPO}/", "log "))], [])


PR = 1810
TESTED = "c" * 40
START, EARLIER, LATER = "2026-11-17T10:00:00Z", "2026-11-17T09:00:00Z", "2026-11-17T10:05:00Z"
SHARD = "App / App hosted tests 1"
PACKAGE = "App / App package tests"
E2E = "web / frontend / e2e (3/6)"


def pjob(identifier, name, conclusion=None, failed=None, started=START):
    """A pull request job: running without a conclusion, else completed; failed names its failed step."""
    steps = [{"name": "Set up job", "conclusion": "success"}] + ([{"name": failed, "conclusion": "failure"}] if failed else [])
    return {"id": identifier, "name": name, "status": "completed" if conclusion else "in_progress",
            "conclusion": conclusion, "started_at": started, "steps": steps,
            "html_url": f"https://github.com/{REPO}/actions/runs/{RUN}/job/{identifier}"}


def gate(conclusion="failure", attempt=1):
    return pjob(99, "CI Gate", conclusion, "Check selected suite results" if conclusion == "failure" else None) | {
        "run_attempt": attempt}


def status(context, test, updated=LATER, state="failure"):
    return {"context": context, "state": state, "description": f"1 failed, latest {test}", "updated_at": updated}


def report_comment(head=HEAD, run=RUN, attempt=1, login="github-actions[bot]"):
    return {"id": 501, "user": {"login": login},
            "body": f"<!-- pr-ci-failure-report head={head} run={run} attempt={attempt} -->\n**1 failed.**"}


class FakePullRun(FakeGitHub):
    """A pull request run seen through scripted polls; each sleep moves to the next poll's jobs, statuses and head."""

    def __init__(self, polls, notes=None, comments=(), forbidden=False):
        super().__init__(polls[0]["jobs"], notes)
        self.polls, self.index, self.forbidden = polls, 0, forbidden
        self.comments, self.writes, self.published = [dict(comment) for comment in comments], [], []

    def advance(self, seconds):
        assert seconds == handoff.POLL_SECONDS, seconds
        assert self.index + 1 < len(self.polls), "the reporter polled past the end of the run"
        self.index += 1
        self.jobs = self.polls[self.index]["jobs"]

    def get(self, path):
        poll = self.polls[self.index]
        if path.endswith(f"/commits/{TESTED}/status?per_page=100"):
            return {"statuses": poll.get("statuses", [])}
        if f"/runs/{RUN}/artifacts" in path:
            return {"artifacts": poll.get("artifacts", [])}
        if path.endswith(f"/pulls/{PR}"):
            return {"head": {"sha": poll.get("head", HEAD)}}
        if f"/issues/{PR}/comments?" in path:
            return self.comments if path.endswith("page=1") else []
        return super().get(path)

    def send(self, method, path, body):
        if self.forbidden:
            raise subprocess.CalledProcessError(1, "gh", stderr="gh: Resource not accessible by integration (HTTP 403)")
        self.writes.append((self.index, method))
        self.published.append(body["body"])
        if method == "POST":
            assert path.endswith(f"/issues/{PR}/comments"), path
            self.comments.append({"id": 777, "user": {"login": "github-actions[bot]"}, "body": body["body"]})
        else:
            next(comment for comment in self.comments if path.endswith(f"/comments/{comment['id']}"))["body"] = body["body"]
        return {}

    def body(self):
        return next(comment["body"] for comment in self.comments if "pr-ci-failure-report" in comment["body"])


class PullRequestReportTests(unittest.TestCase):
    def watch(self, github, fork=False, **overrides):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        repository = "someone/talaria" if fork else REPO
        (directory / "event.json").write_text(json.dumps(
            {"pull_request": {"number": PR, "head": {"sha": HEAD, "repo": {"full_name": repository}}}}))
        summary = directory / "summary.md"
        lines = []
        variables = {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_SHA": TESTED, "GITHUB_REF": f"refs/pull/{PR}/merge",
                     "GITHUB_EVENT_PATH": str(directory / "event.json"), "GITHUB_STEP_SUMMARY": str(summary), **overrides}
        status = handoff.watch(env(**variables), github, sleep=github.advance, out=lines.append)
        return status, "\n".join(lines), summary.read_text() if summary.exists() else ""

    def test_first_failure_is_reported_once_while_another_job_runs(self):
        polls = [{"jobs": [pjob(1, SHARD), pjob(2, E2E)],
                  "statuses": [status("App hosted test failures 1", "ChatViewTests.testSendsDraft")]},
                 {"jobs": [pjob(1, SHARD), pjob(2, E2E, "success")],
                  "statuses": [status("App hosted test failures 1", "ChatViewTests.testSendsDraft")]},
                 {"jobs": [pjob(1, SHARD, "failure", "Test without building"), pjob(2, E2E, "success"), gate()],
                  "statuses": [status("App hosted test failures 1", "ChatViewTests.testSendsDraft")]}]
        github = FakePullRun(polls)
        status_code, _, summary = self.watch(github)
        self.assertEqual(status_code, 1)
        self.assertEqual(github.writes, [(0, "POST"), (2, "PATCH")])
        body = github.body()
        for required in (f"PR head `{HEAD[:12]}`", f"tested merge commit `{TESTED[:12]}`", f"run {RUN}, attempt 1",
                         "`TalariaTests/ChatViewTests/testSendsDraft`",
                         "`app/scripts/test-ios --repeat 3 TalariaTests/ChatViewTests/testSendsDraft`",
                         f"[job log](https://github.com/{REPO}/actions/runs/{RUN}/job/1)", "CI Gate: failure."):
            self.assertIn(required, body)
        self.assertNotIn(E2E, body)
        self.assertIn("ChatViewTests/testSendsDraft", summary)

    def test_each_later_failure_updates_the_one_report(self):
        notes = {3: [{"annotation_level": "failure", "path": "web/packages/frontend/e2e/chat.spec.ts", "start_line": 42}]}
        artifact = [{"id": 88, "name": "frontend-e2e-test-results-3-1"}]
        polls = [{"jobs": [pjob(1, PACKAGE), pjob(3, E2E)],
                  "statuses": [status("App package test failures", "APIClientTests.testDecodesRun")]},
                 # The browser step's failure reaches the jobs API before the job ends and its annotations exist.
                 {"jobs": [pjob(1, PACKAGE), pjob(3, E2E, None, "Run ./.github/actions/web-browser")],
                  "statuses": [status("App package test failures", "APIClientTests.testDecodesRun")]},
                 {"jobs": [pjob(1, PACKAGE, "failure", "Run ./.github/actions/app-package-tests"),
                           pjob(3, E2E, "failure", "Run ./.github/actions/web-browser"),
                           pjob(4, "relay / check", "failure", "Run ../scripts/check relay"),
                           pjob(5, "tooling / Repository Tooling", "failure", "Validate release fragments"), gate()],
                  "statuses": [status("App package test failures", "APIClientTests.testDecodesRun")],
                  "artifacts": artifact}]
        github = FakePullRun(polls, notes)
        self.assertEqual(self.watch(github)[0], 1)
        self.assertEqual(github.writes, [(0, "POST"), (1, "PATCH"), (2, "PATCH")])
        self.assertEqual(sum("pr-ci-failure-report" in comment["body"] for comment in github.comments), 1)
        body = github.body()
        for required in ("**4 failed.**", "`app/scripts/test-ios --repeat 3 TalariaKitTests/APIClientTests/testDecodesRun`",
                         "`scripts/check-web-browser e2e/chat.spec.ts:42`",
                         f"[frontend-e2e-test-results-3-1](https://github.com/{REPO}/actions/runs/{RUN}/artifacts/88)",
                         "`scripts/check relay`", "`scripts/check tooling`", "step “Validate release fragments”"):
            self.assertIn(required, body)
        self.assertNotIn("**CI Gate**", body)

    def test_hosted_mode_build_job_owns_package_failures_beside_a_skipped_package_job(self):
        # Hosted mode runs the package tests inside App build; the standalone package job is listed, skipped.
        polls = [{"jobs": [pjob(1, PACKAGE, "skipped"), pjob(2, "App / App build")],
                  "statuses": [status("App package test failures", "APIClientTests.testDecodesRun")]},
                 {"jobs": [pjob(1, PACKAGE, "skipped"), pjob(2, "App / App build", "failure", "Run the package tests"),
                           gate()],
                  "statuses": [status("App package test failures", "APIClientTests.testDecodesRun")]}]
        github = FakePullRun(polls)
        self.watch(github)
        self.assertEqual(github.writes[0], (0, "POST"))
        self.assertIn("**App / App build**: failing test, `TalariaKitTests/APIClientTests/testDecodesRun`",
                      github.published[0])

    def test_a_superseded_head_or_older_run_never_overwrites_the_report(self):
        failing = {"jobs": [pjob(1, "relay / check", "failure", "Run ../scripts/check relay")]}
        github = FakePullRun([dict(failing, head=NEWER)])
        self.assertEqual(self.watch(github)[0], 0)
        self.assertEqual(github.writes, [])
        github = FakePullRun([failing], comments=[report_comment(run=RUN + 1)])
        self.assertEqual(self.watch(github)[0], 0)
        self.assertEqual(github.writes, [])

    def test_a_same_head_rerun_reports_its_attempt_and_resolution(self):
        stale = [status("App hosted test failures 1", "ChatViewTests.testSendsDraft", updated=EARLIER)]
        # Attempt 1's finished gate can still be listed while attempt 2's reruns.
        polls = [{"jobs": [pjob(1, SHARD), gate()], "statuses": stale},
                 {"jobs": [pjob(1, SHARD, "success"), gate("success", attempt=2)], "statuses": stale}]
        github = FakePullRun(polls, comments=[report_comment()])
        self.assertEqual(self.watch(github, GITHUB_RUN_ATTEMPT="2")[0], 0)
        self.assertEqual(github.writes, [(0, "PATCH"), (1, "PATCH")])
        body = github.body()
        self.assertIn(f"run={RUN} attempt=2", body)
        self.assertIn("Attempt 2 passed. Any earlier failure on this pull request is resolved.", body)
        # Attempt 1's failure status predates the rerun job, so no update names it.
        self.assertFalse(any("testSendsDraft" in published for published in github.published))

    def test_a_new_head_takes_over_an_earlier_heads_report(self):
        # The report names NEWER, a head this pull request has since moved past to HEAD.
        github = FakePullRun([{"jobs": [pjob(1, "relay / check")]}, {"jobs": [pjob(1, "relay / check", "success"),
                                                                              gate("success")]}],
                             comments=[report_comment(head=NEWER)])
        self.watch(github, GITHUB_RUN_ID=str(RUN + 5))
        self.assertEqual(github.writes, [(0, "PATCH"), (1, "PATCH")])
        self.assertIn(f"head={HEAD} run={RUN + 5}", github.body())

    def test_cancellation_timeouts_and_infrastructure_are_not_test_failures(self):
        notes = {2: TIMEOUT, 4: [{"annotation_level": "failure", "title": "Simulator runner fault", "message": "x"}]}
        jobs = [pjob(1, "web / server (sqlite storage, 2/3)", "cancelled"), pjob(2, PACKAGE, "cancelled"),
                pjob(3, "Web contract probe", "failure", "Set up Node for the disposable Web server"),
                pjob(4, "App / App hosted tests 2", "failure", "Test without building"),
                pjob(5, "web / frontend / checks", "failure", "Strict TypeScript"), gate()]
        github = FakePullRun([{"jobs": jobs}], notes)
        self.assertEqual(self.watch(github)[0], 1)
        body = github.body()
        self.assertIn("Cancelled, not failed: web / server (sqlite storage, 2/3)", body)
        self.assertIn(f"**{PACKAGE}**: timed out", body)
        self.assertIn("**Web contract probe**: infrastructure", body)
        self.assertIn("**App / App hosted tests 2**: infrastructure", body)
        # No result bundle was uploaded, so the job log is its only evidence.
        self.assertIn("**web / frontend / checks**: failed step, step “Strict TypeScript”\n  `cd web/packages/frontend && "
                      "npm run i18n:gate && npm run lint && npm run typecheck && npm test`\n  [job log](", body)
        self.assertNotIn("app-test-results-2", body)

    def test_a_fork_or_read_only_token_reports_in_the_job_summary(self):
        failing = [{"jobs": [pjob(1, "relay / check", "failure", "Run ../scripts/check relay"), gate()]}]
        github = FakePullRun(failing)
        status_code, output, summary = self.watch(github, fork=True)
        self.assertEqual((status_code, github.writes), (1, []))
        self.assertFalse(any("/comments" in path or "/pulls/" in path for path in github.paths))
        self.assertIn("`scripts/check relay`", summary)
        self.assertIn("`scripts/check relay`", output)
        status_code, output, summary = self.watch(FakePullRun(failing, forbidden=True))
        self.assertEqual(status_code, 1)
        self.assertIn("cannot comment", output)
        self.assertIn("`scripts/check relay`", summary)

    def test_untrusted_names_never_reach_a_command_or_a_mention(self):
        notes = {3: [{"annotation_level": "failure", "path": "e2e/x.spec.ts;curl evil", "start_line": 1}]}
        jobs = [pjob(1, SHARD, "failure", "Test without building"), pjob(3, E2E, "failure", "Run web-browser"),
                pjob(4, "relay / check @owner", "failure", "Run"), gate()]
        github = FakePullRun([{"jobs": jobs, "statuses": [status("App hosted test failures 1", "A.b$(curl evil)")]}],
                             notes, comments=[report_comment(login="someone")])
        self.watch(github)
        self.assertEqual(github.writes, [(0, "POST")])
        body = github.comments[-1]["body"]
        self.assertNotIn("evil", body)
        self.assertNotIn("@owner", body)
        self.assertIn("`app/scripts/test-ios`", body)
        self.assertIn("`scripts/check-web-browser --shard=3/6`", body)

    def test_other_events_report_nothing(self):
        github = FakePullRun([{"jobs": []}])
        self.assertEqual(self.watch(github, GITHUB_EVENT_NAME="push")[0], 0)
        self.assertEqual(github.paths, [])

    def test_the_reporter_job_is_advisory_and_pull_request_only(self):
        workflow = (Path(__file__).parent.parent / ".github/workflows/ci.yml").read_text()
        report = workflow[workflow.index("\n  report:\n"):workflow.index("\n  gate:\n")]
        gate_needs = re.search(r"\n  gate:\n(?:.*\n)*?    needs: \[(.*)\]", workflow).group(1)
        self.assertNotIn("report", [name.strip() for name in gate_needs.split(",")])
        self.assertIn(f"name: {handoff.REPORTER}\n", report)
        self.assertIn("if: github.event_name == 'pull_request'\n", report)
        self.assertNotIn("secrets.", report)
        permissions = re.search(r"permissions:\n((?:      .*\n)+)", report).group(1)
        granted = {line.split(":")[0].strip(): line.split(":")[1].strip() for line in permissions.splitlines()
                   if not line.strip().startswith("#")}
        self.assertEqual(granted, {"contents": "read", "actions": "read", "checks": "read", "statuses": "read",
                                   "pull-requests": "write"})


class CommandTests(unittest.TestCase):
    def test_prompt_dispatches_without_granting_permissions(self):
        prompt = handoff.PROMPT
        for required in ("{{body.run.id}}", "untrusted data", "never edit code, push, comment on GitHub",
                         "t3_thread_list", 'titleContains "Repair main CI"', "settled true",
                         "git show origin/main:scripts/main-ci-failure.py | python3 - triage",
                         "t3_thread_send", "t3_thread_launch", "Keep the returned threadId",
                         "repeat the inventory and the command once"):
            self.assertIn(required, prompt)
        self.assertNotIn("{{{", prompt)

    def test_the_repair_brief_carries_the_defect_loop_and_a_narrow_authority(self):
        message = handoff.triage(FakeGitHub(tal_1102_jobs()), RUN, [])["message"]
        for required in (
                "follow the defect loop in docs/testing.md: name the test-audit defect rule it broke in the PR body, and "
                "when no rule names the cause, add a rule to the shared test-audit skill alongside the fix",
                "(it failed intermittently, ran over its run-time budget or covered too much)",
                "A product race the test rightly caught names no rule",
                "Never retry, skip, loosen an assertion or raise a timeout",
                "never from a green retry", "Act on the first actionable CI failure, not the run's end",
                "merge it yourself: `python3 scripts/main-ci-failure.py land --pr <number> --head <head SHA>`",
                "no operator, Factory, scheduler, ticket claim or software-factory skill takes part",
                "Never push to any other branch, including a source pull request's",
                "a flake never authorizes a release, a deploy or replaying a partial publication",
                "untrusted data", "Close only after `land` read the merge back on main", "holdReason"):
            self.assertIn(required, message)

    def test_the_scan_prompt_acts_like_the_webhook_prompt(self):
        for prompt in (handoff.PROMPT, handoff.SCAN_PROMPT):
            self.assertIn(handoff.ACT, prompt)
            self.assertIn("never edit code, push, comment on GitHub", prompt)
        self.assertIn("python3 - scan --minutes 30 --threads <file>", handoff.SCAN_PROMPT)
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(handoff.main(["prompt", "--scan"]), 0)
        self.assertEqual(output.getvalue(), handoff.SCAN_PROMPT)

    def test_threads_must_be_a_list_of_objects(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json") as stream:
            json.dump({"threadId": "x"}, stream)
            stream.flush()
            with self.assertRaises(SystemExit):
                handoff.main(["triage", "--run-id", str(RUN), "--threads", stream.name])

    def test_prompt_command_prints_the_prompt(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(handoff.main(["prompt"]), 0)
        self.assertEqual(output.getvalue(), handoff.PROMPT)

    def test_only_the_main_push_alert_job_reads_secrets(self):
        workflow = (Path(__file__).parent.parent / ".github/workflows/ci.yml").read_text()
        self.assertTrue("\n  alert:\n" in workflow, "main CI has no failure handoff job")
        alert = workflow[workflow.index("\n  alert:\n"):]
        self.assertEqual(workflow.count("secrets."), 2)
        self.assertEqual(alert.count("secrets."), 2)
        for condition in ("github.repository == 'MaudeCode/talaria'", "github.event_name == 'push'",
                          "github.ref == 'refs/heads/main'", "needs.gate.result != 'success'"):
            self.assertIn(condition, alert)
        self.assertIn(f"name: {handoff.ALERT}", alert)
        self.assertIn("python3 scripts/main-ci-failure.py send", alert)


if __name__ == "__main__":
    unittest.main()
