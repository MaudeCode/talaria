"""TAL-535: a manual cron run whose child dies without a result fails promptly and frees its running guard."""

from __future__ import annotations

import contextlib
import os
import sys
import time
import types

from talaria_sidecar.methods import cron


def _die(job, execution_home, result_queue):
    os._exit(3)


class _Ctx:
    cancelled = False


def test_a_child_that_exits_without_a_result_fails_the_run_within_one_poll(monkeypatch, tmp_path) -> None:
    runs = []
    jobs = types.SimpleNamespace(
        use_cron_store=lambda home: contextlib.nullcontext(),
        save_job_output=lambda job_id, output: None,
        mark_job_run=lambda job_id, success, error, **kw: runs.append((job_id, success, error)),
    )
    monkeypatch.setattr(cron, "_jobs", lambda: jobs)
    monkeypatch.setattr(cron, "_child_main", _die)
    monkeypatch.setattr(cron, "_result_timeout", lambda job: 30.0)
    monkeypatch.setitem(sys.modules, "cron", types.ModuleType("cron"))
    monkeypatch.setitem(sys.modules, "cron.scheduler", types.ModuleType("cron.scheduler"))
    monkeypatch.setitem(cron._RUNNING, "job-1", time.time())

    started = time.monotonic()
    outcome = cron.run_tracked({"id": "job-1", "name": "Job"}, tmp_path, None, _Ctx())
    elapsed = time.monotonic() - started

    assert outcome["status"] == "failed"
    assert outcome["error"] == "cron run subprocess exited with code 3 without producing a result"
    assert runs == [("job-1", False, outcome["error"])]
    assert "job-1" not in cron._RUNNING
    assert elapsed < 10.0, f"took {elapsed:.1f}s; a dead child must not wait for the run deadline"
