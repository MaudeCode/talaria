"""TAL-810: ``cron.list`` reports an unwritable store and jobs another process is running, and ``cron.run``
refuses a job whose latest attempt still has a live owner."""

from __future__ import annotations

import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent


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
    health = degraded.get("store_health") or {}
    assert "EACCES" in str(health.get("error")), degraded
    assert str(cron_dir.resolve()) in str(health.get("fix")), health
    assert "store_health" not in unprobed


_OWNER = """
import sys
sys.path.insert(0, sys.argv[1])
from cron.executions import create_execution
create_execution(sys.argv[2], source="scheduler")
print("claimed", flush=True)
sys.stdin.read()
"""


@requires_agent
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


@requires_agent
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
