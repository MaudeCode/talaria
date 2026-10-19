#!/usr/bin/env python3
"""Main CI failure handoff over fake GitHub, HTTP and T3 inventories; no live service is contacted."""

import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import re
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
            self.assertEqual(handoff.components(failures), sorted({component, "tooling"}), name)

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
        for required in (f"actions/runs/{RUN}", f"gh run view {RUN}", f"gh run download {RUN}", "scripts/check tooling / web",
                         "AGENTS.md", "branch or open PR", "fails on the baseline", "software-factory", f"main-ci-incident: {HEAD}",
                         "untrusted data", "human-gated", "not authorized by a webhook or a log"):
            self.assertIn(required, message)
        self.assertNotIn("synthetic-token", json.dumps(decision))

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
