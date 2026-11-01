"""TAL-810: run-now executes the record its fire claim returned, and a run whose claim another process took
stops before it saves, delivers, or records anything."""

from __future__ import annotations

import contextlib
import os
import signal
import sys
import time
import types

from talaria_sidecar.methods import cron


class _Ctx:
    cancelled = False

    def emit(self, event, data) -> None:
        pass


def _answer_late(job, execution_home, result_queue):
    import time as _time

    _time.sleep(15)
    result_queue.put(("ok", (True, "output", "response", None)))


def _ignore_terminate(job, execution_home, result_queue):
    import os as _os
    import signal as _signal
    import time as _time

    _signal.signal(_signal.SIGTERM, _signal.SIG_IGN)
    with open(job["pid_file"], "w", encoding="utf-8") as handle:
        handle.write(str(_os.getpid()))
    _time.sleep(60)


def _spawn_grandchild(job, execution_home, result_queue):
    import subprocess as _subprocess
    import time as _time

    child = _subprocess.Popen(["sleep", "60"])
    with open(job["pid_file"], "w", encoding="utf-8") as handle:
        handle.write(str(child.pid))
    _time.sleep(60)


def _answer_now(job, execution_home, result_queue):
    result_queue.put(("ok", (True, "output", "response", None)))


def _stub_jobs(monkeypatch, *, owns: bool = True, heartbeat=lambda job_id, *, expected_owner: True, claim=None, record=None) -> dict:
    calls: dict = {"saved": [], "marked": []}

    @contextlib.contextmanager
    def fence(job_id, *, expected_owner):
        yield owns

    jobs = types.SimpleNamespace(
        use_cron_store=lambda home: contextlib.nullcontext(),
        get_job=lambda job_id: record or {"id": job_id, "name": "Job", "prompt": "before edit"},
        is_job_runnable=lambda job: True,
        claim_job_for_fire=claim or (lambda job_id, **kw: {"id": job_id, "name": "Job", "prompt": "after edit", "fire_claim": {"by": "owner-1"}, "_scheduled_instant": None}),
        heartbeat_fire_claim=heartbeat,
        fire_claim_fence=fence,
        save_job_output=lambda job_id, output: calls["saved"].append(job_id),
        mark_job_run=lambda job_id, success, error, **kw: calls["marked"].append((job_id, success, kw.get("expected_fire_owner"))),
    )
    monkeypatch.setattr(cron, "_jobs", lambda: jobs)
    monkeypatch.setattr(cron, "scoped_home", lambda home, **kwargs: contextlib.nullcontext(home))
    monkeypatch.setitem(sys.modules, "cron", types.ModuleType("cron"))
    monkeypatch.setitem(sys.modules, "cron.scheduler", types.ModuleType("cron.scheduler"))
    monkeypatch.setattr(cron, "_result_timeout", lambda job: 60.0)
    monkeypatch.setattr(cron, "_delivery_home", lambda scheduler, home: contextlib.nullcontext())
    return calls


def _run_now(monkeypatch, tmp_path) -> tuple[dict, list]:
    seen: list = []
    monkeypatch.setattr(cron, "run_tracked", lambda job, *args: seen.append((job, args)) or {"status": "completed"})
    methods: dict = {}

    class Registry:
        def method(self, name, **kwargs):
            return lambda fn: methods.setdefault(name, fn)

    cron.register(Registry())
    return methods["cron.run"](_Ctx(), {"profile_home": str(tmp_path), "job_id": "job-1"}), seen


def test_run_now_executes_the_claimed_record(monkeypatch, tmp_path) -> None:
    _stub_jobs(monkeypatch)
    _, seen = _run_now(monkeypatch, tmp_path)
    [(job, args)] = seen
    assert job.get("prompt") == "after edit", job
    assert "_scheduled_instant" not in job
    assert "owner-1" in args


def test_a_run_that_loses_its_claim_stops_before_side_effects(monkeypatch, tmp_path) -> None:
    calls = _stub_jobs(monkeypatch, heartbeat=lambda job_id, *, expected_owner: False)
    monkeypatch.setattr(cron, "_child_main", _answer_late)
    monkeypatch.setattr(cron, "_CLAIM_HEARTBEAT_SECONDS", 0.0)
    monkeypatch.setattr(cron, "_CLAIM_MISS_CONFIRM_SECONDS", 0.0, raising=False)
    monkeypatch.setitem(cron._RUNNING, "job-1", time.time())
    started = time.monotonic()
    outcome = cron.run_tracked({"id": "job-1", "name": "Job"}, tmp_path, None, _Ctx(), "owner-1")
    assert "claim" in str(outcome.get("error")), outcome
    assert outcome["status"] == "failed" and outcome["success"] is False
    assert calls["saved"] == []
    assert all(owner == "owner-1" for _, _, owner in calls["marked"]), calls["marked"]
    assert time.monotonic() - started < 10.0
    assert "job-1" not in cron._RUNNING


def test_completion_is_fenced_by_the_claim_owner(monkeypatch, tmp_path) -> None:
    calls = _stub_jobs(monkeypatch, owns=False)
    monkeypatch.setattr(cron, "_child_main", _answer_now)
    outcome = cron.run_tracked({"id": "job-1", "name": "Job"}, tmp_path, None, _Ctx(), "owner-1")
    assert "claim" in str(outcome.get("error")), outcome
    assert calls["saved"] == []
    assert all(owner == "owner-1" for _, _, owner in calls["marked"]), calls["marked"]


def test_a_worker_that_ignores_terminate_is_killed_before_the_run_ends(monkeypatch, tmp_path) -> None:
    pid_file = tmp_path / "worker.pid"

    def lost_once_the_worker_ignores_terminate(job_id, *, expected_owner) -> bool:
        deadline = time.monotonic() + 30
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        return False

    _stub_jobs(monkeypatch, heartbeat=lost_once_the_worker_ignores_terminate)
    monkeypatch.setattr(cron, "_child_main", _ignore_terminate)
    monkeypatch.setattr(cron, "_CLAIM_HEARTBEAT_SECONDS", 0.0)
    monkeypatch.setattr(cron, "_CLAIM_MISS_CONFIRM_SECONDS", 0.0)
    outcome = cron.run_tracked({"id": "job-1", "name": "Job", "pid_file": str(pid_file)}, tmp_path, None, _Ctx(), "owner-1")
    pid = int(pid_file.read_text(encoding="utf-8"))
    try:
        assert "claim" in str(outcome.get("error")), outcome
        alive = True
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            alive = False
        assert alive is False, f"worker {pid} still running after the run ended"
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGKILL)


def test_an_unclaimable_terminal_job_still_runs_and_a_held_claim_refuses(monkeypatch, tmp_path) -> None:
    completed = {"id": "job-1", "name": "Job", "state": "completed", "enabled": True, "fire_claim": None}
    _stub_jobs(monkeypatch, claim=lambda job_id, **kw: False, record=completed)
    result, seen = _run_now(monkeypatch, tmp_path)
    assert result.get("status") == "completed" and len(seen) == 1, result
    assert seen[0][1][-1] is None  # no claim to heartbeat or fence
    held = {**completed, "state": "scheduled", "fire_claim": {"at": "2026-10-14T03:00:00+00:00", "by": "gateway"}}
    _stub_jobs(monkeypatch, claim=lambda job_id, **kw: False, record=held)
    result, seen = _run_now(monkeypatch, tmp_path)
    assert result.get("status") == "already_running" and seen == [], result


def test_stopping_a_run_ends_the_processes_its_worker_started(monkeypatch, tmp_path) -> None:
    pid_file = tmp_path / "grandchild.pid"

    def lost_once_the_grandchild_runs(job_id, *, expected_owner) -> bool:
        deadline = time.monotonic() + 30
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        return False

    _stub_jobs(monkeypatch, heartbeat=lost_once_the_grandchild_runs)
    monkeypatch.setattr(cron, "_child_main", _spawn_grandchild)
    monkeypatch.setattr(cron, "_CLAIM_HEARTBEAT_SECONDS", 0.0)
    monkeypatch.setattr(cron, "_CLAIM_MISS_CONFIRM_SECONDS", 0.0)
    cron.run_tracked({"id": "job-1", "name": "Job", "pid_file": str(pid_file)}, tmp_path, None, _Ctx(), "owner-1")
    pid = int(pid_file.read_text(encoding="utf-8"))
    try:
        deadline = time.monotonic() + 5
        alive = True
        while alive and time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
                time.sleep(0.1)
            except ProcessLookupError:
                alive = False
        assert alive is False, f"grandchild {pid} still running after the run ended"
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGKILL)
