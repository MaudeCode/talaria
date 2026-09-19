"""HWEB-57: cron continuity, monitor, script, and reasoning-effort form fields.

The WebUI calls ``cron.jobs`` directly, so it has to perform the same interface
merge the agent's ``cronjob`` tool does: ``monitor`` is one string that the
store splits into ``monitor_script``/``monitor_url``, and ``continuity`` is
sugar for a ``context_from`` list containing ``"self"``. Neither is a key on the
stored job dict.
"""

from __future__ import annotations

import io
import json
import sys
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
NEW_FIELDS = ("script", "no_agent", "monitor", "continuity", "context_from", "reasoning_effort")


class _JSONHandler:
    def __init__(self):
        self.status = None
        self.response_headers = []
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.response_headers.append((key, value))

    def end_headers(self):
        pass


def _payload(handler):
    return json.loads(handler.wfile.getvalue().decode("utf-8"))


def _stub_cron_jobs(monkeypatch, calls, existing=None):
    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")

    def create_job(**kwargs):
        calls.append(("create", kwargs))
        return {"id": "job-1", **kwargs}

    def update_job(job_id, updates):
        calls.append(("update", job_id, updates))
        return {"id": job_id, **updates}

    cron_jobs.create_job = create_job
    cron_jobs.update_job = update_job
    cron_jobs.get_job = lambda job_id: dict(existing or {})
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)
    return cron_jobs


def _create(monkeypatch, body, existing=None):
    import api.routes as routes

    calls = []
    _stub_cron_jobs(monkeypatch, calls, existing)
    handler = _JSONHandler()
    routes._handle_cron_create(handler, body)
    assert handler.status == 200, _payload(handler)
    return next(kwargs for kind, kwargs in ((c[0], c[1]) for c in calls) if kind == "create")


def _update(monkeypatch, body, existing=None):
    import api.routes as routes

    calls = []
    _stub_cron_jobs(monkeypatch, calls, existing)
    handler = _JSONHandler()
    routes._handle_cron_update(handler, body)
    assert handler.status == 200, _payload(handler)
    return next(c[2] for c in calls if c[0] == "update")


BASE = {"prompt": "ping", "schedule": "every 1h"}


# --- create forwarding -------------------------------------------------------


def test_create_forwards_each_in_scope_key(monkeypatch):
    kwargs = _create(
        monkeypatch,
        {
            **BASE,
            "script": "collect.sh",
            "context_from": ["abc123"],
            "reasoning_effort": "high",
            "repeat": 3,
            "continuity": True,
        },
    )
    assert kwargs["script"] == "collect.sh"
    assert kwargs["reasoning_effort"] == "high"
    assert kwargs["repeat"] == 3
    # continuity folds "self" into the reference list rather than being stored.
    assert kwargs["context_from"] == ["abc123", "self"]
    assert "continuity" not in kwargs


def test_create_omits_absent_keys_so_agent_defaults_apply(monkeypatch):
    kwargs = _create(monkeypatch, dict(BASE))
    for key in (*NEW_FIELDS, "repeat", "monitor_script", "monitor_url"):
        assert key not in kwargs, key


def test_create_splits_monitor_url_and_script(monkeypatch):
    url = _create(monkeypatch, {**BASE, "monitor": "https://example.com/status"})
    assert url["monitor_url"] == "https://example.com/status"
    assert url["monitor_script"] == ""
    assert "monitor" not in url

    script = _create(monkeypatch, {**BASE, "monitor": "check-feed.sh"})
    assert script["monitor_script"] == "check-feed.sh"
    assert script["monitor_url"] == ""


def test_create_forwards_no_agent_with_script(monkeypatch):
    kwargs = _create(monkeypatch, {**BASE, "no_agent": True, "script": "watchdog.sh"})
    assert kwargs["no_agent"] is True
    assert kwargs["script"] == "watchdog.sh"


# --- clearing semantics ------------------------------------------------------


def test_update_clearing_semantics_survive_the_webui(monkeypatch):
    updates = _update(
        monkeypatch,
        {
            "job_id": "job-1",
            "monitor": "",
            "script": "",
            "context_from": [],
            "continuity": False,
        },
    )
    assert updates["monitor_script"] == ""
    assert updates["monitor_url"] == ""
    assert updates["script"] == ""
    assert updates["context_from"] == []
    assert "monitor" not in updates
    assert "continuity" not in updates


def test_continuity_only_update_keeps_other_chained_jobs(monkeypatch):
    updates = _update(
        monkeypatch,
        {"job_id": "job-1", "continuity": True},
        existing={"id": "job-1", "context_from": ["abc123"]},
    )
    assert updates["context_from"] == ["abc123", "self"]

    off = _update(
        monkeypatch,
        {"job_id": "job-1", "continuity": False},
        existing={"id": "job-1", "context_from": ["abc123", "self"]},
    )
    assert off["context_from"] == ["abc123"]


def test_update_never_forwards_bare_repeat_integer(monkeypatch):
    # The store keeps repeat as a {"times", "completed"} record once the job
    # exists; a bare integer would clobber the run counter.
    updates = _update(monkeypatch, {"job_id": "job-1", "repeat": 5})
    assert "repeat" not in updates


# --- script-only creates (Codex P1) ------------------------------------------


def test_script_only_create_is_not_rejected_for_an_empty_prompt(monkeypatch):
    # The script-only form omits the prompt textarea entirely, so it posts
    # prompt: ''. A blanket require(prompt) would 400 every script-only create
    # before no_agent ever reached create_job.
    kwargs = _create(
        monkeypatch,
        {"prompt": "", "schedule": "every 1h", "no_agent": True, "script": "watchdog.sh"},
    )
    assert kwargs["prompt"] == ""
    assert kwargs["no_agent"] is True
    assert kwargs["script"] == "watchdog.sh"


def test_skills_only_create_is_not_rejected_for_an_empty_prompt(monkeypatch):
    kwargs = _create(monkeypatch, {"prompt": "", "schedule": "every 1h", "skills": ["triage"]})
    assert kwargs["skills"] == ["triage"]


def test_create_still_rejects_a_payload_with_no_prompt_script_or_skills(monkeypatch):
    import api.routes as routes

    _stub_cron_jobs(monkeypatch, [])
    handler = _JSONHandler()
    routes._handle_cron_create(handler, {"prompt": "", "schedule": "every 1h"})
    assert handler.status == 400
    assert "prompt" in _payload(handler)["error"]


def test_create_still_requires_a_schedule(monkeypatch):
    import api.routes as routes

    _stub_cron_jobs(monkeypatch, [])
    handler = _JSONHandler()
    routes._handle_cron_create(handler, {"prompt": "ping"})
    assert handler.status == 400
    assert "schedule" in _payload(handler)["error"]


# --- script-only profile snapshots (Codex round 2) ----------------------------


def test_script_only_create_skips_profile_model_snapshot_resolution(monkeypatch):
    # A script-only job never calls a model, so an unresolvable profile LLM
    # config must not 400 an otherwise valid create.
    import api.routes as routes

    def _explode(*a, **kw):
        raise AssertionError("no_agent create must not resolve model snapshots")

    monkeypatch.setattr(routes, "_normalize_cron_profile_value", lambda v: v or None)
    assert (
        routes._selected_profile_snapshot_updates(
            "work", provider=None, model=None, no_agent=True
        )
        == {}
    )
    # ... and the create path passes the request's no_agent through to it.
    seen = {}
    monkeypatch.setattr(
        routes,
        "_selected_profile_snapshot_updates",
        lambda profile, **kw: seen.update(kw) or {},
    )
    _create(
        monkeypatch,
        {
            "prompt": "",
            "schedule": "every 1h",
            "profile": "work",
            "no_agent": True,
            "script": "watchdog.sh",
        },
    )
    assert seen["no_agent"] is True


# --- hostile input (Codex round 9) --------------------------------------------


def test_malformed_context_from_is_a_400_not_a_500(monkeypatch):
    # Iterating a non-sequence raised TypeError, which escaped
    # _handle_cron_update's ValueError handler as an unhandled 500.
    import api.routes as routes

    for bad_value in (1, {"a": 1}, True):
        _stub_cron_jobs(monkeypatch, [])
        handler = _JSONHandler()
        routes._handle_cron_update(
            handler,
            {"job_id": "job-1", "context_from": bad_value, "continuity": True},
        )
        assert handler.status == 400, bad_value
        assert "context_from" in _payload(handler)["error"]


def test_valid_context_from_shapes_still_accepted(monkeypatch):
    assert routes_refs("abc") == ["abc"]
    assert routes_refs(["abc", "def"]) == ["abc", "def"]
    assert routes_refs(("abc",)) == ["abc"]
    assert routes_refs(None) == []


def routes_refs(value):
    import api.routes as routes

    return routes._cron_continuity_refs(value, False)


# --- read-back ---------------------------------------------------------------


def test_cron_job_for_api_round_trips_each_key():
    import api.routes as routes

    payload = routes._cron_job_for_api(
        {
            "id": "job-1",
            "script": "collect.sh",
            "no_agent": False,
            "monitor_url": "https://example.com/status",
            "monitor_script": None,
            "context_from": ["abc123", "self"],
            "reasoning_effort": "high",
            "repeat": {"times": 3, "completed": 1},
        }
    )
    assert payload["script"] == "collect.sh"
    assert payload["no_agent"] is False
    assert payload["reasoning_effort"] == "high"
    assert payload["repeat"] == {"times": 3, "completed": 1}
    assert payload["context_from"] == ["abc123", "self"]
    assert payload["monitor"] == "https://example.com/status"
    assert payload["continuity"] is True


def test_cron_job_for_api_projects_script_monitor_and_absent_continuity():
    import api.routes as routes

    payload = routes._cron_job_for_api(
        {"id": "job-2", "monitor_script": "check-feed.sh", "context_from": ["abc123"]}
    )
    assert payload["monitor"] == "check-feed.sh"
    assert payload["continuity"] is False


# --- form contract -----------------------------------------------------------
