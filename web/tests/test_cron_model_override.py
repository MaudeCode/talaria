"""Tests for cron model override features."""

from __future__ import annotations

import io
import json
import sys
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
class _JSONHandler:
    def __init__(self):
        self.status = None
        self.headers = {}
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


def test_cron_create_forwards_model_and_provider(monkeypatch):
    import api.routes as routes

    created = {"id": "job-model-override", "prompt": "override test", "schedule": "every 1h"}
    calls = []
    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")
    cron_jobs.create_job = lambda **kwargs: calls.append(("create", kwargs)) or {**created, **kwargs}
    cron_jobs.update_job = lambda job_id, updates: calls.append(("update", job_id, updates)) or {**created, **updates}
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    handler = _JSONHandler()
    routes._handle_cron_create(
        handler,
        {
            "prompt": "override test",
            "schedule": "every 1h",
            "model": "my-custom-model",
            "provider": "my-provider",
        },
    )

    assert handler.status == 200
    assert calls[0][0] == "create"
    assert calls[0][1]["model"] == "my-custom-model"
    assert calls[0][1]["provider"] == "my-provider"


def test_cron_update_allows_overwriting_and_clearing_model_provider(monkeypatch):
    import api.routes as routes

    calls = []
    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")
    cron_jobs.update_job = lambda job_id, updates: calls.append(("update", job_id, updates)) or {"id": job_id, **updates}
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    # 1. Update model & provider
    handler = _JSONHandler()
    routes._handle_cron_update(
        handler,
        {
            "job_id": "test-job",
            "model": "new-model",
            "provider": "new-provider",
        },
    )
    assert handler.status == 200
    assert calls[0] == ("update", "test-job", {"model": "new-model", "provider": "new-provider"})

    # 2. Clear model & provider overrides to default
    handler = _JSONHandler()
    routes._handle_cron_update(
        handler,
        {
            "job_id": "test-job",
            "model": None,
            "provider": None,
        },
    )
    assert handler.status == 200
    assert calls[1] == ("update", "test-job", {"model": None, "provider": None})
