"""TAL-1820: an Agent older than v0.22.6, whose ``create_job`` has no schedule policy, is told nothing about it."""

from __future__ import annotations

import contextlib
import types

from talaria_sidecar.methods import cron

POLICY = {"timezone": "America/New_York", "catch_up": False, "grace_minutes": 30}


def test_an_agent_without_the_fields_is_reported_unavailable_and_sent_nothing(monkeypatch, tmp_path) -> None:
    sent: dict = {}

    # v0.22.5's fields: a stray keyword raises, as it does on the real function.
    def old_create_job(prompt, schedule, name=None, deliver=None, skills=None, model=None, provider=None):
        sent["create"] = {"prompt": prompt}
        return {"id": "job-1"}

    def update_job(job_id, updates):
        sent["update"] = updates
        return {"id": job_id, **updates}

    jobs = types.SimpleNamespace(
        use_cron_store=lambda home: contextlib.nullcontext(), _jobs_lock=contextlib.nullcontext, create_job=old_create_job, update_job=update_job,
        get_job=lambda job_id: {"id": job_id}, list_jobs=lambda include_disabled: [], get_cron_output_dir=lambda: tmp_path / "cron" / "output",
    )
    monkeypatch.setattr(cron, "_jobs", lambda: jobs)
    monkeypatch.setattr(cron, "scoped_home", lambda home, **kwargs: contextlib.nullcontext(home))
    methods: dict = {}

    class Registry:
        def method(self, name, **kwargs):
            return lambda fn: methods.setdefault(name, fn)

    cron.register(Registry())
    home = {"profile_home": str(tmp_path)}
    assert methods["cron.list"](None, {**home, "probe_store": True})["schedule_policy"] is False
    methods["cron.create"](None, {**home, "job": {"schedule": "0 9 * * *", "prompt": "hi", **POLICY}})
    assert sent["create"] == {"prompt": "hi"}
    methods["cron.update"](None, {**home, "job_id": "job-1", "updates": {"name": "Digest", **POLICY}})
    assert sent["update"] == {"name": "Digest"}
