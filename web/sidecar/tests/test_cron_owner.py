"""Manual cron cancellation against an actual disposable canonical gateway and loopback model."""

from __future__ import annotations

import contextlib
import json
import os
import queue
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, OneToolCallModel, SidecarProcess, isolated_env, requires_agent

canonical_agent = pytest.mark.skipif(
    AGENT_DIR is None or not (AGENT_DIR / "cron/scheduler_authority.py").exists(),
    reason="Agent predates canonical cron ownership",
)


def wait_for(read, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if value := read():
            return value
        time.sleep(.05)
    raise AssertionError("fixture did not reach its barrier")


class HeldModel(OneToolCallModel):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(body)
        self.server.started.set()
        self.server.release.wait(90)
        message = {"role": "assistant", "content": "COMPLETED_AFTER_WEB_CANCEL"}
        choice = {"index": 0, "message": message, "finish_reason": "stop"}
        response = {"id": "fixture", "model": body.get("model"), "choices": [choice],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
        kind = "application/json"
        if body.get("stream"):
            choice["delta"] = choice.pop("message")
            data = ("data: " + json.dumps(response) + "\n\ndata: [DONE]\n\n").encode()
            kind = "text/event-stream"
        else:
            data = json.dumps(response).encode()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)


def control(home, verb, params=None):
    pointer = home / "gateway.sock.path"
    target = pointer.read_text().strip() if pointer.exists() else str(home / "gateway.sock")
    with socket.socket(socket.AF_UNIX) as peer:
        peer.settimeout(2)
        peer.connect(target)
        peer.sendall(json.dumps({"protocol": 1, "id": 1, "verb": verb, "params": params or {}}).encode() + b"\n")
        answer = json.loads(peer.makefile("rb").readline())
    assert answer["ok"], answer
    return answer["result"]


@pytest.fixture
def owner(tmp_path):
    home = tmp_path / "hermes"
    home.mkdir(mode=0o700)
    model = ThreadingHTTPServer(("127.0.0.1", 0), HeldModel)
    model.daemon_threads = True
    model.started, model.release, model.requests = threading.Event(), threading.Event(), []
    model.cancel_received = tmp_path / "owner-cancellation.json"
    def wait_cancelled(admission):
        wait_for(model.cancel_received.exists)
        assert json.loads(model.cancel_received.read_text()) == {
            "session_id": admission["target_session_id"], "admission_id": admission["admission_id"],
        }
    model.wait_cancelled = wait_cancelled
    threading.Thread(target=model.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{model.server_port}/v1"
    (home / "config.yaml").write_text(json.dumps({
        "gateway": {"multiplex_profiles": False},
        "model": {"provider": "custom", "default": "cron-loopback-model", "base_url": origin, "context_length": 128000},
        "auxiliary": {"title_generation": {"enabled": False}}, "platform_toolsets": {"cli": [], "cron": []},
        "memory": {"memory_enabled": False, "user_profile_enabled": False}, "agent": {"max_turns": 2},
    }))
    (home / ".env").write_text("OPENAI_API_KEY=loopback-only\n")
    env = isolated_env(home, home=tmp_path, OPENAI_API_KEY="loopback-only", OPENAI_BASE_URL=origin,
                       TALARIA_SIDECAR_AGENT_DIR=str(AGENT_DIR), PYTHONUNBUFFERED="1",
                       TALARIA_TEST_CANCEL_MARKER=str(model.cancel_received))
    gateway_code = """
import json, os
from pathlib import Path
from gateway import session_cron
from gateway.run import main

real_operation = session_cron.operation
marker = Path(os.environ['TALARIA_TEST_CANCEL_MARKER'])

async def observe_cancel(authority, name, params, actor=None):
    result = await real_operation(authority, name, params, actor)
    if name == 'cancel':
        event = getattr(authority, '_cron_cancellations', {}).get(params['admission_id'])
        if event is not None and event.is_set():
            pending = marker.with_suffix('.tmp')
            pending.write_text(json.dumps(params))
            pending.replace(marker)
    return result

session_cron.operation = observe_cancel
main()
"""
    log_path = tmp_path / "gateway.log"
    with log_path.open("w") as log:
        gateway = None
        def start_gateway():
            nonlocal gateway
            gateway = subprocess.Popen([AGENT_PYTHON, "-c", gateway_code], cwd=AGENT_DIR, env=env,
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
            model.gateway = gateway
        start_gateway()
        model.restart_gateway = start_gateway
        sidecar = None
        try:
            def ready():
                assert gateway.poll() is None, log_path.read_text()[-4000:]
                try:
                    return control(home, "identify").get("state") == "ready"
                except (OSError, ValueError):
                    return False
            wait_for(ready, 120)
            model.wait_ready = lambda: wait_for(ready, 120)
            sidecar = SidecarProcess(home, env={"OPENAI_API_KEY": "loopback-only", "OPENAI_BASE_URL": origin})
            job = sidecar.result("cron.create", {"profile_home": str(home), "job": {
                "schedule": "0 0 1 1 *", "prompt": "CRON_CANCEL_SENTINEL", "model": "cron-loopback-model",
                "provider": "custom", "base_url": origin, "enabled_toolsets": [], "deliver": "local",
            }})["job"]
            yield home, model, sidecar, job
        finally:
            model.release.set()
            if sidecar:
                sidecar.close()
            if gateway.poll() is None:
                gateway.terminate()
                try:
                    gateway.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    gateway.kill()
                    gateway.wait(timeout=10)
            model.shutdown()
            model.server_close()


def admissions(home):
    with sqlite3.connect(f"file:{home / 'state.db'}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute("select admission_id,target_session_id,request_id,status,outcome from session_admissions")]


@requires_agent
@canonical_agent
def test_started_cancel_waits_for_exact_owner_terminal_before_releasing_run(owner):
    home, model, sidecar, job = owner
    request = sidecar.request("cron.run", {"profile_home": str(home), "job_id": job["id"]})
    assert model.started.wait(60), sidecar.stderr_lines[-20:]
    [before] = admissions(home)
    assert before["status"] == "started"
    cancel = sidecar.request("rpc.cancel", {"id": request})
    messages = []
    wait_for(lambda: (messages.append(sidecar.next_message()) or messages[-1].get("id") == cancel))
    assert messages[-1]["result"]["cancelled"] is True
    # RPC acknowledgement precedes delivery to the gateway's cancellation latch.
    model.wait_cancelled(before)
    # With the inference barrier held, cancellation is only acknowledged. The run must retain ownership.
    try:
        while True:
            messages.append(sidecar.next_message(timeout=2.5))
            assert messages[-1].get("id") != request, "cron.run reported stopped while its gateway admission was still started"
    except queue.Empty:
        pass
    stored = json.loads((home / "cron/jobs.json").read_text())["jobs"][0]
    assert stored.get("fire_claim"), stored
    model.release.set()
    reply = wait_for(lambda: (message if message.get("id") == request else None) if (message := sidecar.next_message(timeout=60)) else None)
    assert reply.get("error", {}).get("data", {}).get("condition") == "cancelled", reply
    [after] = admissions(home)
    assert after["admission_id"] == before["admission_id"]
    assert after["status"] == "terminal" and after["outcome"] != "completed", after
    assert len(model.requests) == 1
    def transcript():
        with sqlite3.connect(f"file:{home / 'state.db'}?mode=ro", uri=True) as db:
            return db.execute("select role,content from messages").fetchall()
    settled = transcript()
    time.sleep(.25)
    assert transcript() == settled, "task work persisted after the cancelled reply"
    assert not sidecar.result("cron.get", {"profile_home": str(home), "job_id": job["id"]})["job"].get("fire_claim")


def workers(sidecar):
    # Long CI interpreter paths must not hide spawn_main at the terminal's column limit.
    rows = subprocess.run(["ps", "-axwwo", "pid=,ppid=,command="], capture_output=True, text=True, check=True).stdout.splitlines()
    return [int(pid) for line in rows if len(parts := line.split(None, 2)) == 3
            for pid, parent, command in [parts] if int(parent) == sidecar.proc.pid and "spawn_main" in command]


@pytest.mark.skipif(os.name != "posix", reason="worker lookup uses POSIX process tables")
def test_workers_finds_long_interpreter_commands_at_narrow_terminal_width(tmp_path, monkeypatch):
    monkeypatch.setenv("COLUMNS", "80")
    executable = tmp_path / ("runtime-" + "x" * 100) / "python"
    executable.parent.mkdir()
    executable.symlink_to(sys.executable)
    ready = tmp_path / "ready"
    script = tmp_path / "worker.py"
    script.write_text("""
import multiprocessing, os, pathlib, sys

def work(ready, stop):
    pathlib.Path(ready).write_text(str(os.getpid()))
    stop.wait(15)

if __name__ == '__main__':
    ctx = multiprocessing.get_context('spawn')
    stop = ctx.Event()
    child = ctx.Process(target=work, args=(sys.argv[1], stop))
    child.start()
    sys.stdin.read()
    stop.set()
    child.join(5)
""")
    parent = subprocess.Popen([str(executable), str(script), str(ready)], stdin=subprocess.PIPE,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=isolated_env(tmp_path))
    try:
        child = wait_for(lambda: int(ready.read_text() or "0") if ready.exists() else None, 10)
        assert workers(SimpleNamespace(proc=parent)) == [child]
    finally:
        parent.communicate(timeout=10)


@requires_agent
@canonical_agent
@pytest.mark.parametrize("restart_sidecar,remove_job", [(False, False), (True, False), (True, True)])
def test_lost_submitter_recovers_same_admission_without_another_run(owner, restart_sidecar, remove_job):
    home, model, sidecar, job = owner
    params = {"profile_home": str(home), "job_id": job["id"]}
    request = sidecar.request("cron.run", params)
    assert model.started.wait(60), sidecar.stderr_lines[-20:]
    [before] = admissions(home)
    record_path = home / "cron/manual_runs" / (job["id"] + ".json")
    record = json.loads(record_path.read_text())
    [child] = workers(sidecar)
    replacement = None
    try:
        if restart_sidecar:
            sidecar.proc.kill()
            sidecar.proc.wait(timeout=10)
        os.kill(child, signal.SIGKILL)
        if remove_job:
            subprocess.run([AGENT_PYTHON, "-c", "import sys; from cron.jobs import remove_job; assert remove_job(sys.argv[1])", job["id"]],
                           cwd=AGENT_DIR, env=isolated_env(home), check=True, capture_output=True, text=True, timeout=30)
        if restart_sidecar:
            replacement = SidecarProcess(home, env={"OPENAI_API_KEY": "loopback-only", "OPENAI_BASE_URL": f"http://127.0.0.1:{model.server_port}/v1"})
            listed = replacement.result("cron.list", {"profile_home": str(home)})["jobs"]
            assert len(listed) == 1 and listed[0]["id"] == job["id"], "Web store resolution must still find a retained deleted job"
            assert listed[0]["running_elsewhere"] is False
            assert "unverified" in listed[0]["last_error"]
            assert replacement.result("cron.get", params)["job"]["id"] == job["id"], "Web preflight must receive the retained job snapshot"
            request = replacement.request("cron.run", params)
        wait_for(lambda: json.loads(record_path.read_text()).get("cancel_reason"))
        # The local intent precedes worker startup; wait for the real owner to latch cancellation.
        model.wait_cancelled(before)
        model.release.set()
        active = replacement or sidecar
        reply = wait_for(lambda: (message if message.get("id") == request else None) if (message := active.next_message(timeout=60)) else None)
        assert reply.get("result", {}).get("status") == "failed", (reply, active.stderr_lines[-20:])
        [after] = admissions(home)
        assert after["admission_id"] == before["admission_id"] and after["status"] == "terminal", after
        assert len(model.requests) == 1
        stored = active.result("cron.get", params)["job"]
        assert not record_path.exists()
        if remove_job:
            assert stored is None
            assert active.result("cron.output", params)["outputs"] == []
        else:
            assert stored["canonical_completions"] == [record["execution_id"]]
            assert stored["repeat"]["completed"] == 1
            assert stored["state"] == "scheduled"
            assert len(active.result("cron.output", params)["outputs"]) == 1
    finally:
        if replacement:
            replacement.close()


@requires_agent
@canonical_agent
def test_owner_disconnect_and_restart_leave_unknown_guarded_without_resubmission(owner):
    home, model, sidecar, job = owner
    params = {"profile_home": str(home), "job_id": job["id"]}
    request = sidecar.request("cron.run", params)
    assert model.started.wait(60), sidecar.stderr_lines[-20:]
    [original] = admissions(home)
    record_path = home / "cron/manual_runs" / (job["id"] + ".json")
    identity = json.loads(record_path.read_text())["execution_id"]
    model.gateway.kill()
    model.gateway.wait(timeout=10)
    reply = wait_for(lambda: (message if message.get("id") == request else None) if (message := sidecar.next_message(timeout=60)) else None)
    assert reply.get("error", {}).get("data", {}).get("condition") == "cron_execution_unverified", reply
    assert sidecar.result("cron.status", {"job_id": job["id"]})["running"] is False, "the Web preflight must allow an explicit recovery retry"
    retained = sidecar.result("cron.list", {"profile_home": str(home)})["jobs"][0]
    assert retained["running_elsewhere"] is False and "unverified" in retained["last_error"]
    stored = sidecar.result("cron.get", params)["job"]
    assert stored["state"] == "paused" and stored.get("fire_claim") and not stored.get("last_run_at"), stored
    subprocess.run([AGENT_PYTHON, "-c", "import sys; from cron.jobs import update_job; assert update_job(sys.argv[1], {'profile':'edited-profile'})", job["id"]],
                   cwd=AGENT_DIR, env=isolated_env(home), check=True, capture_output=True, text=True, timeout=30)
    assert sidecar.result("cron.list", {"profile_home": str(home)})["jobs"][0]["profile"] == job["profile"]
    assert sidecar.result("cron.get", params)["job"]["profile"] == job["profile"], "Web recovery preflight must use the frozen execution profile"
    for method, extra in (("cron.resume", {}), ("cron.delete", {}), ("cron.update", {"updates": {"enabled": True}})):
        blocked, _ = sidecar.call(method, {**params, **extra})
        assert blocked.get("error", {}).get("data", {}).get("condition") == "cron_execution_unverified", blocked
    model.restart_gateway()
    model.wait_ready()
    retry, frames = sidecar.call("cron.run", params)
    assert [frame["event"] for frame in frames] == ["started"], "Web must acknowledge accepted recovery before its terminal outcome"
    assert retry.get("error", {}).get("data", {}).get("condition") == "cron_execution_unverified", retry
    assert json.loads(record_path.read_text())["execution_id"] == identity
    [after] = admissions(home)
    assert after["admission_id"] == original["admission_id"] and after["status"] == "unknown", after
    assert len(model.requests) == 1
    assert sidecar.result("cron.output", params)["outputs"] == []


@requires_agent
@canonical_agent
@pytest.mark.parametrize("state", ["scheduled", "paused", "disabled"])
def test_successful_manual_run_books_once_and_preserves_operator_schedule_state(owner, state):
    home, model, sidecar, job = owner
    params = {"profile_home": str(home), "job_id": job["id"]}
    if state == "paused":
        sidecar.result("cron.pause", {**params, "reason": "operator pause"})
    elif state == "disabled":
        sidecar.result("cron.update", {**params, "updates": {"enabled": False}})
    before = sidecar.result("cron.get", params)["job"]
    model.release.set()
    result = sidecar.result("cron.run", params)
    assert result["success"] is True, result
    stored = sidecar.result("cron.get", params)["job"]
    assert (stored["state"], stored["enabled"], stored.get("paused_reason")) == (before["state"], before["enabled"], before.get("paused_reason"))
    assert stored["repeat"]["completed"] == 1
    assert len(sidecar.result("cron.output", params)["outputs"]) == 1
    assert len(model.requests) == 1
    assert len(admissions(home)) == 1
    assert not (home / "cron/manual_runs" / (job["id"] + ".json")).exists()


@requires_agent
@canonical_agent
@pytest.mark.parametrize("method,extra", [
    ("cron.resume", {}),
    ("cron.update", {"updates": {"state": "scheduled", "enabled": True}}),
    ("cron.delete", {}),
])
def test_schedule_mutations_cannot_remove_a_manual_execution_recovery_barrier(owner, method, extra):
    home, model, sidecar, job = owner
    params = {"profile_home": str(home), "job_id": job["id"]}
    sidecar.request("cron.run", params)
    assert model.started.wait(60), sidecar.stderr_lines[-20:]
    answer, _ = sidecar.call(method, {**params, **extra})
    assert answer.get("error", {}).get("data", {}).get("condition") == "cron_execution_unverified", answer
    stored = sidecar.result("cron.get", params)["job"]
    assert stored["state"] == "paused" and stored.get("fire_claim")
    assert (home / "cron/manual_runs" / (job["id"] + ".json")).exists()
