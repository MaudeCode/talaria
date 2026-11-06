"""TAL-810: ``cron.list`` reports an unwritable store and jobs another process is running, and ``cron.run``
refuses a job whose latest attempt still has a live owner."""

from __future__ import annotations

import pathlib
import subprocess
import time

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, ledger_row, requires_agent

# Agent 0.21.6 added the store probe and the live-owner ledger check; older Agents report neither.
HAS_STORE_PROBE = AGENT_DIR is not None and (AGENT_DIR / "cron" / "store_health.py").is_file()
HAS_LEDGER = AGENT_DIR is not None and (AGENT_DIR / "cron" / "executions.py").is_file() and "def live_inflight_execution" in (AGENT_DIR / "cron" / "executions.py").read_text()
requires_ledger = pytest.mark.skipif(not HAS_LEDGER, reason="the executions ledger's live-owner check requires Agent v0.21.6")
requires_cancel = pytest.mark.skipif(AGENT_DIR is None or not (AGENT_DIR / "cron" / "cancellation.py").is_file(), reason="on-demand run cancellation requires Agent v0.22.6")


def _create(sidecar: SidecarProcess, home: pathlib.Path) -> str:
    return sidecar.result("cron.create", {"profile_home": str(home), "job": {"schedule": "every 1h", "prompt": "say hi", "model": "m", "provider": "p"}})["job"]["id"]


@requires_agent
def test_list_reports_an_unwritable_store_only_when_probed(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    _create(handshaken, hermes_home)
    cron_dir = hermes_home / "cron"
    assert handshaken.result("cron.list", {"profile_home": str(hermes_home), "probe_store": True}).get("store_health", "missing") is None
    # The Agent re-secures (chmods) a store directory its owner can write on every load, so the fixture makes the
    # scheduler's tick lock read-only instead: the probe reports it as EACCES exactly like an unwritable directory.
    (cron_dir / ".tick.lock").touch(mode=0o444)
    degraded = handshaken.result("cron.list", {"profile_home": str(hermes_home), "probe_store": True})
    unprobed = handshaken.result("cron.list", {"profile_home": str(hermes_home)})
    assert "store_health" not in unprobed
    if not HAS_STORE_PROBE:
        assert degraded.get("store_health", "missing") is None, degraded
        return
    health = degraded.get("store_health") or {}
    assert "EACCES" in str(health.get("error")), degraded
    assert str(cron_dir.resolve()) in str(health.get("fix")), health


_OWNER = """
import sys
sys.path.insert(0, sys.argv[1])
from cron.executions import create_execution
create_execution(sys.argv[2], source="scheduler")
print("claimed", flush=True)
sys.stdin.read()
"""


@requires_agent
@requires_ledger
def test_a_live_owner_reads_running_and_refuses_run_now(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    job_id = _create(handshaken, hermes_home)
    params = {"profile_home": str(hermes_home)}
    owner = subprocess.Popen([AGENT_PYTHON, "-c", _OWNER, str(AGENT_DIR), job_id], env=isolated_env(hermes_home, home=tmp_path), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert owner.stdout is not None and owner.stdout.readline().strip() == "claimed"
        [job] = handshaken.result("cron.list", params)["jobs"]
        assert job.get("running_elsewhere") is True, job
        refused = handshaken.result("cron.run", {**params, "job_id": job_id})
        assert refused.get("status") == "already_running", refused
    finally:
        owner.communicate(timeout=30)
    [job] = handshaken.result("cron.list", params)["jobs"]
    assert job.get("running_elsewhere") is False, job


def _script_job(sidecar: SidecarProcess, home: pathlib.Path, source: str) -> str:
    (home / "scripts").mkdir(exist_ok=True)
    (home / "scripts" / "task.py").write_text(source, encoding="utf-8")
    return sidecar.result("cron.create", {"profile_home": str(home), "job": {"schedule": "every 1h", "script": "task.py", "no_agent": True}})["job"]["id"]


def _held_script(ready: pathlib.Path) -> str:
    return f"import pathlib, time\npathlib.Path({str(ready)!r}).touch()\ntime.sleep(120)\n"


def _wait_for_file(path: pathlib.Path) -> None:
    deadline = time.monotonic() + 60
    while not path.exists():
        assert time.monotonic() < deadline, f"{path} never appeared"
        time.sleep(.05)


def _assert_booked_cancelled(sidecar: SidecarProcess, home: pathlib.Path, job_id: str, reason: str) -> None:
    params = {"profile_home": str(home), "job_id": job_id}
    stored = sidecar.result("cron.get", params)["job"]
    assert stored["last_status"] == "cancelled" and not stored.get("last_error"), stored
    assert not stored.get("last_failure") and not stored.get("failure_streak") and not stored.get("fire_claim"), stored
    assert sidecar.result("cron.output", params)["outputs"] == [], "a stopped run saves and delivers no failure notice"
    row = ledger_row(home, job_id)
    assert (row["status"], row["error"]) == ("cancelled", reason), row
    [listed] = sidecar.result("cron.list", {"profile_home": str(home)})["jobs"]
    assert listed["live_execution"] is None and listed["running_elsewhere"] is False, listed


_GATEWAY_FIRE = """
import sys
from cron import jobs, scheduler
claimed = jobs.claim_job_for_fire(sys.argv[1], return_job=True)
assert isinstance(claimed, dict), claimed
scheduler.run_one_job(claimed)
"""


@requires_agent
@requires_cancel
def test_stopping_a_gateway_claimed_run_ends_it_and_books_cancelled(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    ready = tmp_path / "script-started"
    job_id = _script_job(handshaken, hermes_home, _held_script(ready))
    params = {"profile_home": str(hermes_home), "job_id": job_id}
    owner = subprocess.Popen([AGENT_PYTHON, "-c", _GATEWAY_FIRE, job_id], cwd=AGENT_DIR, env=isolated_env(hermes_home, home=tmp_path), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        _wait_for_file(ready)
        [listed] = handshaken.result("cron.list", {"profile_home": str(hermes_home)})["jobs"]
        assert listed["live_execution"]["stopping"] is False and listed["running_elsewhere"] is True, listed
        assert handshaken.result("cron.cancel", {**params, "reason": "first reason"})["status"] == "stopping"
        assert handshaken.result("cron.cancel", {**params, "reason": "second reason"})["status"] == "stopping"
        [listed] = handshaken.result("cron.list", {"profile_home": str(hermes_home)})["jobs"]
        assert listed["live_execution"]["stopping"] is True, listed
        assert owner.wait(timeout=60) == 0, owner.stderr.read()
    finally:
        owner.kill()
        owner.communicate(timeout=30)
    _assert_booked_cancelled(handshaken, hermes_home, job_id, "first reason")
    assert handshaken.result("cron.cancel", params)["status"] == "not_running", "nothing is left to stop"


@requires_agent
@requires_cancel
def test_stopping_a_manual_script_run_ends_it_and_books_cancelled(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    ready = tmp_path / "script-started"
    job_id = _script_job(handshaken, hermes_home, _held_script(ready))
    params = {"profile_home": str(hermes_home), "job_id": job_id}
    request = handshaken.request("cron.run", params)
    _wait_for_file(ready)
    [listed] = handshaken.result("cron.list", {"profile_home": str(hermes_home)})["jobs"]
    assert listed["live_execution"]["stopping"] is False, listed
    assert handshaken.result("cron.cancel", {**params, "reason": "first reason"})["status"] == "stopping"
    while (message := handshaken.next_message(timeout=60)).get("id") != request:
        pass
    assert message.get("result", {}).get("status") == "cancelled", message
    assert message["result"]["error"] == "first reason"
    _assert_booked_cancelled(handshaken, hermes_home, job_id, "first reason")


@requires_agent
@requires_ledger
def test_run_now_refuses_when_the_ledger_is_unreadable(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    job_id = _script_job(handshaken, hermes_home, "print('ran')\n")
    (hermes_home / "cron" / "executions.db").write_text("not a database", encoding="utf-8")
    params = {"profile_home": str(hermes_home)}
    # Listing tolerates the unreadable ledger; admission cannot prove the job idle, so it refuses.
    [job] = handshaken.result("cron.list", params)["jobs"]
    assert job.get("running_elsewhere") is False, job
    message, _ = handshaken.call("cron.run", {**params, "job_id": job_id})
    assert message.get("error", {}).get("data", {}).get("condition") == "cron_ledger_unreadable", message


_CLAIM = """
import sys
sys.path.insert(0, sys.argv[1])
from cron.jobs import claim_job_for_fire
assert claim_job_for_fire(sys.argv[2]) is True
print("claimed", flush=True)
sys.stdin.read()
"""

_SEE_CLAIM = """import json, os
store = json.load(open(os.path.join(os.environ["HERMES_HOME"], "cron", "jobs.json"), encoding="utf-8"))
jobs = store["jobs"] if isinstance(store, dict) else store
print("CLAIMED", all(job.get("fire_claim") for job in jobs))
"""


@requires_agent
def test_run_now_holds_the_agent_fire_claim(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    params = {"profile_home": str(hermes_home)}
    job_id = _script_job(handshaken, hermes_home, _SEE_CLAIM)
    # The run holds the same durable claim the gateway tick must win, and releases it when done.
    assert handshaken.result("cron.run", {**params, "job_id": job_id}, timeout=120).get("success") is True
    [output] = handshaken.result("cron.output", {**params, "job_id": job_id})["outputs"]
    assert "CLAIMED True" in output["content"], output["content"]
    assert not handshaken.result("cron.get", {**params, "job_id": job_id})["job"].get("fire_claim")
    # A claim a live gateway process holds wins: run-now does not start a second run.
    claimer = subprocess.Popen([AGENT_PYTHON, "-c", _CLAIM, str(AGENT_DIR), job_id], env=isolated_env(hermes_home, home=tmp_path), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert claimer.stdout is not None and claimer.stdout.readline().strip() == "claimed"
        refused = handshaken.result("cron.run", {**params, "job_id": job_id})
        assert refused.get("status") == "already_running", refused
    finally:
        claimer.communicate(timeout=30)
    assert len(handshaken.result("cron.output", {**params, "job_id": job_id, "limit": 10})["outputs"]) == 1
