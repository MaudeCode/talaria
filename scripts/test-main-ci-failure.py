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
import subprocess
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


def job(identifier, name, conclusion="success", status="completed"):
    return {"id": identifier, "name": name, "status": status, "conclusion": conclusion,
            "html_url": f"https://github.com/{REPO}/actions/runs/{RUN}/job/{identifier}"}


def tal_1102_jobs():
    """The TAL-1102 incident: three failed sidecar jobs, skipped suites and the failed gate."""
    return [job(1, "Detect changed paths"), job(2, "tooling / Repository Tooling"), job(3, "web / server"),
            job(4, "relay", "skipped"), job(5, "App / App build", "skipped"),
            *(job(10 + index, name, "failure") for index, name in enumerate(SIDECAR)),
            job(20, "CI Gate", "failure"), job(21, handoff.ALERT, None, "in_progress")]


class FakeGitHub:
    def __init__(self, jobs, annotations=None, run=None, runs=(), pulls=(), position="identical"):
        self.jobs, self.annotations, self.paths = jobs, annotations or {}, []
        self.run = {"id": RUN, "run_attempt": 1, "run_number": 1975, "head_sha": HEAD, "head_branch": "main",
                    "event": "push", "path": ".github/workflows/ci.yml", "conclusion": "failure",
                    "html_url": f"https://github.com/{REPO}/actions/runs/{RUN}",
                    "repository": {"full_name": REPO}, "head_repository": {"full_name": REPO}, **(run or {})}
        self.runs, self.pulls, self.position = list(runs), list(pulls), position

    def get(self, path):
        self.paths.append(path)
        if "/jobs?" in path:
            assert "filter=latest" in path, path
            page = int(re.search(r"page=(\d+)$", path).group(1))
            return {"total_count": len(self.jobs), "jobs": self.jobs[(page - 1) * 100:page * 100]}
        if "/annotations" in path:
            return self.annotations.get(int(path.split("/")[-2]), [])
        if path.endswith(f"/actions/runs/{RUN}"):
            return self.run
        if "/compare/" in path:
            return {"status": self.position}
        if "/workflows/ci.yml/runs" in path:
            return {"workflow_runs": self.runs}
        if "/pulls?" in path:
            return self.pulls
        raise AssertionError(path)


def env(**overrides):
    return {"GITHUB_REPOSITORY": REPO, "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/main",
            "GITHUB_WORKFLOW_REF": f"{REPO}/.github/workflows/ci.yml@refs/heads/main", "GITHUB_WORKFLOW": "CI",
            "GITHUB_RUN_ID": str(RUN), "GITHUB_RUN_ATTEMPT": "1", "GITHUB_SHA": HEAD,
            "GITHUB_SERVER_URL": "https://github.com", "GATE_RESULT": "failure",
            "WEBHOOK_URL": "http://127.0.0.1:9/synthetic-token", "WEBHOOK_SECRET": SECRET, **overrides}


class Receiver:
    """A local stand-in for T3's native webhook receiver: records requests and answers a scripted status list."""

    def __init__(self, statuses):
        self.statuses, self.requests = list(statuses), []
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["content-length"]))
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

    def test_each_component_failure_alerts_and_routes(self):
        for name, component in (("App / App build", "app"), ("App tooling", "app"), ("web / frontend / checks", "web"),
                                ("web-docker", "docker"), ("relay", "relay"), ("Web contract probe", "contracts"),
                                ("tooling / Repository Tooling", "tooling"), ("Detect changed paths", "tooling")):
            failures = handoff.failed_jobs(FakeGitHub([job(1, name, "failure"), job(2, "CI Gate", "failure")]), RUN)
            self.assertEqual([item["name"] for item in failures], [name, "CI Gate"])
            self.assertEqual(handoff.components(failures), [component], name)

    def test_gate_failure_alone_alerts(self):
        failures = handoff.failed_jobs(FakeGitHub([job(1, "Detect changed paths"), job(2, "CI Gate", "failure")]), RUN)
        self.assertEqual([item["name"] for item in failures], ["CI Gate"])
        self.assertEqual(handoff.components(failures), ["tooling"])

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


class TriageTests(unittest.TestCase):
    def triage(self, threads=(), run_id=RUN, **github):
        return handoff.triage(FakeGitHub(github.pop("jobs", tal_1102_jobs()), **github), run_id, list(threads))

    def test_tal_1102_incident_launches_one_repair_with_all_sidecar_jobs(self):
        decision = self.triage()
        self.assertEqual(decision["action"], "launch")
        self.assertEqual(decision["title"], f"Repair main CI {HEAD[:12]}")
        self.assertEqual(decision["workspaceStrategy"], {"type": "worktree", "baseRef": "main", "startFromOrigin": True})
        message = decision["message"]
        for name in SIDECAR:
            self.assertIn(name, message)
        for required in (f"actions/runs/{RUN}", f"gh run view {RUN}", f"gh run download {RUN}", "`scripts/check web`.",
                         "AGENTS.md", "branch or open PR", "fails on the baseline", "software-factory", f"main-ci-incident: {HEAD}",
                         "untrusted data", "human-gated", "not authorized by a webhook or a log", "docs/testing.md"):
            self.assertIn(required, message)
        self.assertNotIn("synthetic-token", json.dumps(decision))
        self.assertNotIn("scripts/check tooling", message)

    def test_malformed_and_untrusted_runs_are_rejected(self):
        for run_id in ("", "0", "12; rm -rf /", "1" * 21, "../runs/1"):
            self.assertEqual(self.triage(run_id=run_id)["action"], "reject", run_id)
        for run in ({"event": "pull_request"}, {"head_branch": "feature"}, {"path": ".github/workflows/x.yml"},
                    {"head_repository": {"full_name": "someone/talaria"}}, {"repository": {"full_name": "a/b"}},
                    {"head_sha": "not-a-sha"}):
            self.assertEqual(self.triage(run=run)["action"], "reject", run)
        self.assertEqual(self.triage(position="diverged")["action"], "reject")

    def test_green_rerun_or_later_green_main_suppresses_the_repair(self):
        self.assertEqual(self.triage(jobs=[job(1, "relay"), job(2, "CI Gate")])["action"], "noop")
        later = [{"id": 2, "run_number": 1980, "head_sha": NEWER, "conclusion": "success"}]
        decision = self.triage(runs=later)
        self.assertEqual(decision["action"], "noop")
        self.assertIn("superseded", decision["reason"])
        older = [{"id": 3, "run_number": 1970, "head_sha": NEWER, "conclusion": "success"},
                 {"id": 4, "run_number": 1981, "head_sha": NEWER, "conclusion": "failure"}]
        self.assertEqual(self.triage(runs=older)["action"], "launch")

    def test_duplicate_delivery_lost_ack_and_restart_reuse_the_incident_thread(self):
        title = f"Repair main CI {HEAD[:12]}"
        for status in ("preparing", "starting", "running", "waiting", "idle", "interrupted", "completed"):
            decision = self.triage([{"threadId": "thread-1", "title": title, "status": status}])
            self.assertEqual((decision["action"], decision["threadId"]), ("reuse", "thread-1"), status)
            self.assertIn(SIDECAR[0], decision["message"])

    def test_failed_launch_is_retried_within_a_bound(self):
        title = f"Repair main CI {HEAD[:12]}"
        self.assertEqual(self.triage([{"threadId": "t1", "title": title, "status": "failed"}])["action"], "launch")
        ended = [{"threadId": "t1", "title": title, "status": "failed"},
                 {"threadId": "t2", "title": title, "status": "cancelled"}]
        decision = self.triage(ended)
        self.assertEqual(decision["action"], "noop")
        self.assertIn("operator", decision["reason"])

    def test_active_repair_of_an_older_head_absorbs_a_newer_red_run(self):
        threads = [{"threadId": "older", "title": "Repair main CI cccccccccccc", "status": "running"},
                   {"threadId": "done", "title": "Repair main CI dddddddddddd", "status": "completed"},
                   {"threadId": "dispatcher", "title": "Main CI repair dispatcher", "status": "running"}]
        decision = self.triage(threads)
        self.assertEqual((decision["action"], decision["threadId"]), ("reuse", "older"))
        self.assertIn("red again", decision["message"])

    def test_open_repair_pr_owns_the_failure(self):
        pulls = [{"number": 7, "body": "Unrelated"}, {"number": 9, "body": f"Fix\n\nmain-ci-incident: {NEWER}"}]
        decision = self.triage(pulls=pulls)
        self.assertEqual(decision["action"], "noop")
        self.assertIn("#9", decision["reason"])
        self.assertEqual(self.triage(pulls=pulls[:1])["action"], "launch")
        threads = [{"threadId": "owner", "title": f"Repair main CI {NEWER[:12]}", "status": "completed"}]
        decision = self.triage(threads, pulls=pulls)
        self.assertEqual((decision["action"], decision["threadId"]), ("reuse", "owner"))
        self.assertIn("PR #9", decision["message"])


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
                         "repeat steps 3 and 4 once"):
            self.assertIn(required, prompt)
        self.assertNotIn("{{{", prompt)

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
