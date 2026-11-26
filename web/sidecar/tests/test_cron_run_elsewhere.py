"""TAL-2735: a profile a plugin runs elsewhere (the Agent's host-only marker, 0.23.4+) is never run by Web's Run now.

An Agent without the marker module has no such policy and runs the task as before; each test takes its expectation from
the Agent it loaded."""

from __future__ import annotations

import json
import pathlib
import sqlite3
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, isolated_env, requires_agent

NATIVE_POLICY = AGENT_DIR is not None and (AGENT_DIR / "hermes_cli" / "profiles_run_elsewhere.py").is_file()


def _marked_profile(tmp_path: pathlib.Path) -> pathlib.Path:
    """A disposable root whose ``sandboxed`` profile a fixture plugin marks as run elsewhere."""
    root = tmp_path / "root"
    home = root / "profiles" / "sandboxed"
    (home / "scripts").mkdir(parents=True)
    (root / "profiles_run_elsewhere").mkdir()
    (root / "profiles_run_elsewhere" / "sandboxed.json").write_text(json.dumps({"plugin": "fixture-sandbox", "since": "2026-11-26T00:00:00Z"}))
    return home


def _ledger_rows(home: pathlib.Path, job_id: str) -> int:
    ledger = home / "cron" / "executions.db"
    if not ledger.is_file():
        return 0
    with sqlite3.connect(f"file:{ledger}?mode=ro", uri=True) as db:
        return db.execute("select count(*) from executions where job_id=?", (job_id,)).fetchone()[0]


@requires_agent
def test_run_now_refuses_a_profile_run_elsewhere_before_claiming_admitting_or_launching(handshaken: SidecarProcess, tmp_path: pathlib.Path) -> None:
    home = _marked_profile(tmp_path)
    launched = tmp_path / "launched"
    (home / "scripts" / "task.py").write_text(f"import pathlib\npathlib.Path({str(launched)!r}).touch()\n")
    params = {"profile_home": str(home), "execution_home": str(home)}
    job = handshaken.result("cron.create", {**params, "job": {"schedule": "every 1h", "script": "task.py", "no_agent": True}})["job"]
    before = handshaken.result("cron.get", {**params, "job_id": job["id"]})["job"]

    reply, _ = handshaken.call("cron.run", {**params, "job_id": job["id"]})

    stored = handshaken.result("cron.get", {**params, "job_id": job["id"]})["job"]
    if not NATIVE_POLICY:
        assert "error" not in reply and launched.exists(), reply
        return
    assert reply.get("error", {}).get("data", {}).get("condition") == "cron_not_runnable", reply
    assert "fixture-sandbox" in reply["error"]["message"], reply
    # Refused before the claim, the attempt row or the worker: nothing ran and the record is untouched.
    assert not launched.exists()
    assert _ledger_rows(home, job["id"]) == 0
    assert {key: stored.get(key) for key in ("state", "enabled", "fire_claim", "last_run_at", "last_status", "next_run_at")} == \
        {key: before.get(key) for key in ("state", "enabled", "fire_claim", "last_run_at", "last_status", "next_run_at")}
    assert handshaken.result("cron.status", {"job_id": job["id"]})["running"] is False


WORKER = """
import json, queue, sys
import cron.scheduler
from talaria_sidecar.methods import cron as web_cron, cron_execution
launched = []
cron.scheduler.run_job = lambda job, **kwargs: launched.append(job["id"]) or (True, "", "ran", None)
cron_execution.recover = lambda job, execution_id, cancel_event: launched.append(job["id"]) or (True, "", "ran", None)
results = queue.Queue()
web_cron._child_main({"id": "job-1"}, sys.argv[1], results, None, "execution-1", sys.argv[2] == "recovering")
print(json.dumps({"result": results.get_nowait()[:2], "launched": launched}))
"""


@requires_agent
def test_a_worker_for_a_profile_marked_after_admission_launches_nothing(tmp_path: pathlib.Path) -> None:
    home = _marked_profile(tmp_path)
    outcomes = {}
    for mode in ("fresh", "recovering"):
        run = subprocess.run([AGENT_PYTHON, "-c", WORKER, str(home), mode], cwd=AGENT_DIR, capture_output=True, text=True, timeout=60,
                             env=isolated_env(tmp_path / "host", PYTHONPATH=f"{SIDECAR_ROOT}:{AGENT_DIR}"))
        assert run.returncode == 0, run.stdout + run.stderr
        outcomes[mode] = json.loads(run.stdout.splitlines()[-1])
    if not NATIVE_POLICY:
        assert outcomes == {mode: {"result": ["ok", [True, "", "ran", None]], "launched": ["job-1"]} for mode in outcomes}, outcomes
        return
    fresh, recovering = outcomes["fresh"], outcomes["recovering"]
    # A fresh fire definitely did not run: it settles as a failed run carrying the Agent's refusal.
    assert fresh["launched"] == [] and fresh["result"][0] == "ok" and fresh["result"][1][0] is False, fresh
    assert "fixture-sandbox" in fresh["result"][1][3], fresh
    # Recovery cannot prove what the original admission did, so it stays unverified and keeps its retained record.
    assert recovering["launched"] == [] and recovering["result"][0] == "unverified", recovering
    assert "fixture-sandbox" in recovering["result"][1], recovering
