"""TAL-810: run-now executes the record its fire claim returned, and a run whose claim another process took
stops before it saves, delivers, or records anything."""

from __future__ import annotations

import contextlib
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


def _answer_now(job, execution_home, result_queue):
    result_queue.put(("ok", (True, "output", "response", None)))


def _stub_jobs(monkeypatch, *, owns: bool = True, heartbeat=lambda job_id, *, expected_owner: True) -> dict:
    calls: dict = {"saved": [], "marked": []}

    @contextlib.contextmanager
    def fence(job_id, *, expected_owner):
        yield owns

    jobs = types.SimpleNamespace(
        use_cron_store=lambda home: contextlib.nullcontext(),
        get_job=lambda job_id: {"id": job_id, "name": "Job", "prompt": "before edit"},
        is_job_runnable=lambda job: True,
        claim_job_for_fire=lambda job_id, **kw: {"id": job_id, "name": "Job", "prompt": "after edit", "fire_claim": {"by": "owner-1"}, "_scheduled_instant": None},
        heartbeat_fire_claim=heartbeat,
        fire_claim_fence=fence,
        save_job_output=lambda job_id, output: calls["saved"].append(job_id),
        mark_job_run=lambda job_id, success, error, **kw: calls["marked"].append((job_id, success, kw.get("expected_fire_owner"))),
    )
    monkeypatch.setattr(cron, "_jobs", lambda: jobs)
    monkeypatch.setitem(sys.modules, "cron", types.ModuleType("cron"))
    monkeypatch.setitem(sys.modules, "cron.scheduler", types.ModuleType("cron.scheduler"))
    monkeypatch.setattr(cron, "_result_timeout", lambda job: 60.0)
    monkeypatch.setattr(cron, "_delivery_home", lambda scheduler, home: contextlib.nullcontext())
    return calls


def test_run_now_executes_the_claimed_record(monkeypatch, tmp_path) -> None:
    _stub_jobs(monkeypatch)
    seen: list = []
    monkeypatch.setattr(cron, "run_tracked", lambda job, *args: seen.append((job, args)) or {"status": "completed"})
    methods: dict = {}

    class Registry:
        def method(self, name, **kwargs):
            return lambda fn: methods.setdefault(name, fn)

    cron.register(Registry())
    methods["cron.run"](_Ctx(), {"profile_home": str(tmp_path), "job_id": "job-1"})
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
