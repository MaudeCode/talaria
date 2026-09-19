"""Focused coverage for issue #3947, cross-profile cron visibility in Tasks."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import sys
import tempfile
import types
from pathlib import Path
from types import SimpleNamespace

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


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


def _payload(handler: _JSONHandler) -> dict:
    return json.loads(handler.wfile.getvalue().decode("utf-8"))


def _extract_function(src: str, name: str) -> str:
    marker = f"function {name}("
    start = src.find(marker)
    assert start >= 0, f"{name} not found in panels.js"
    open_brace = src.find("{", start)
    assert open_brace >= 0, f"{name} opening brace not found"
    depth = 0
    for idx in range(open_brace, len(src)):
        char = src[idx]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return src[start : idx + 1]
    raise AssertionError(f"{name} closing brace not found")


def _run_node(script: str) -> dict:
    if NODE is None:
        pytest.skip("node not on PATH")
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as handle:
        handle.write(script)
        path = Path(handle.name)
    try:
        result = subprocess.run(
            [NODE, str(path)],
            capture_output=True,
            text=True,
            timeout=20,
            cwd=str(REPO_ROOT),
        )
    finally:
        path.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(f"node failed: {result.stderr}\nscript:\n{script}")
    return json.loads(result.stdout)


def _install_cron_jobs(monkeypatch, jobs_by_home, current_home):
    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")

    def _list_jobs(include_disabled=True):
        return [dict(job) for job in jobs_by_home[current_home["value"]]]

    cron_jobs.list_jobs = _list_jobs
    cron_jobs.use_cron_store = _store_context(current_home)
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)


def _store_context(current_home):
    class _Store:
        def __init__(self, home):
            self.home = str(home)
            self.previous = None

        def __enter__(self):
            self.previous = current_home["value"]
            current_home["value"] = self.home
            return self

        def __exit__(self, exc_type, exc, tb):
            current_home["value"] = self.previous
            return False

    return _Store


def test_crons_route_hides_other_profiles_by_default_but_reports_count(monkeypatch):
    import api.profiles as profiles
    import api.routes as routes

    current_home = {"value": None}
    jobs_by_home = {
        "alpha-home": [{"id": "job-shared", "name": "Alpha", "profile": "worker"}],
        "default-home": [],
        "beta-home": [{"id": "job-shared", "name": "Beta", "profile": None}],
    }
    _install_cron_jobs(monkeypatch, jobs_by_home, current_home)

    monkeypatch.setattr(routes, "_get_active_profile_name", lambda: "alpha")
    monkeypatch.setattr(profiles, "list_profiles_api", lambda: [
        {"name": "alpha", "visible": True},
        {"name": "beta", "visible": True},
    ])
    monkeypatch.setattr(
        profiles,
        "get_hermes_home_for_profile",
        lambda name: Path({"alpha": "alpha-home", "beta": "beta-home", "default": "default-home"}[name]),
    )
    handler = _JSONHandler()
    assert routes.handle_get(handler, SimpleNamespace(path="/api/crons", query="")) is not False
    body = _payload(handler)

    assert handler.status == 200
    assert body["all_profiles"] is False
    assert body["active_profile"] == "alpha"
    assert body["other_profile_count"] == 1
    assert [job["name"] for job in body["jobs"]] == ["Alpha"]
    assert body["jobs"][0]["owner_profile"] == "alpha"
    assert body["jobs"][0]["read_only"] is False
    assert body["jobs"][0]["profile"] == "worker"

    handler = _JSONHandler()
    assert routes.handle_get(handler, SimpleNamespace(path="/api/crons", query="all_profiles=1")) is not False
    body = _payload(handler)

    assert handler.status == 200
    assert body["all_profiles"] is True
    assert body["other_profile_count"] == 0
    assert [job["owner_profile"] for job in body["jobs"]] == ["alpha", "beta"]
    assert body["jobs"][0]["read_only"] is False
    assert body["jobs"][1]["read_only"] is True
    assert body["jobs"][1]["profile"] is None


def test_crons_route_dedupes_root_aliases_by_resolved_home(monkeypatch):
    import api.profiles as profiles
    import api.routes as routes

    current_home = {"value": None}
    jobs_by_home = {
        "base-home": [{"id": "root-job", "name": "Root job", "profile": None}],
        "beta-home": [{"id": "beta-job", "name": "Beta job", "profile": "beta"}],
    }
    calls = {"base-home": 0, "beta-home": 0}

    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")

    def _list_jobs(include_disabled=True):
        calls[current_home["value"]] += 1
        return [dict(job) for job in jobs_by_home[current_home["value"]]]

    cron_jobs.list_jobs = _list_jobs
    cron_jobs.use_cron_store = _store_context(current_home)
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    monkeypatch.setattr(routes, "_get_active_profile_name", lambda: "rootalias")
    monkeypatch.setattr(profiles, "list_profiles_api", lambda: [
        {"name": "default", "visible": True},
        {"name": "beta", "visible": True},
    ])
    monkeypatch.setattr(
        profiles,
        "get_hermes_home_for_profile",
        lambda name: Path({
            "rootalias": "base-home",
            "default": "base-home",
            "beta": "beta-home",
        }[name]),
    )
    handler = _JSONHandler()
    assert routes.handle_get(handler, SimpleNamespace(path="/api/crons", query="all_profiles=1")) is not False
    body = _payload(handler)

    assert calls["base-home"] == 1, "root alias + default must not double-read the same home"
    assert calls["beta-home"] == 1
    assert [job["owner_profile"] for job in body["jobs"]] == ["rootalias", "beta"]


def test_crons_route_skips_hidden_default_profile_when_inactive(monkeypatch):
    import api.profiles as profiles
    import api.routes as routes

    current_home = {"value": None}
    jobs_by_home = {
        "alpha-home": [{"id": "alpha-job", "name": "Alpha", "profile": None}],
        "default-home": [{"id": "root-job", "name": "Root", "profile": None}],
    }
    _install_cron_jobs(monkeypatch, jobs_by_home, current_home)

    monkeypatch.setattr(routes, "_get_active_profile_name", lambda: "alpha")
    monkeypatch.setattr(profiles, "list_profiles_api", lambda: [
        {"name": "default", "visible": False},
        {"name": "alpha", "visible": True},
    ])
    monkeypatch.setattr(
        profiles,
        "get_hermes_home_for_profile",
        lambda name: Path({"alpha": "alpha-home", "default": "default-home"}[name]),
    )
    handler = _JSONHandler()
    assert routes.handle_get(handler, SimpleNamespace(path="/api/crons", query="all_profiles=1")) is not False
    body = _payload(handler)

    assert handler.status == 200
    assert body["all_profiles"] is True
    assert body["other_profile_count"] == 0
    assert [job["owner_profile"] for job in body["jobs"]] == ["alpha"]


def test_crons_route_ignores_all_profiles_toggle_in_isolated_mode(monkeypatch):
    import api.profiles as profiles
    import api.routes as routes

    current_home = {"value": None}
    jobs_by_home = {
        "alpha-home": [{"id": "alpha-job", "name": "Alpha", "profile": None}],
    }
    _install_cron_jobs(monkeypatch, jobs_by_home, current_home)
    lookups = []

    monkeypatch.setattr(routes, "_get_active_profile_name", lambda: "alpha")
    monkeypatch.setattr(routes, "_is_isolated_profile_mode", lambda: True)
    monkeypatch.setattr(profiles, "list_profiles_api", lambda: [{"name": "alpha", "visible": True}])
    monkeypatch.setattr(
        profiles,
        "get_hermes_home_for_profile",
        lambda name: lookups.append(name) or Path("alpha-home"),
    )
    handler = _JSONHandler()
    assert routes.handle_get(handler, SimpleNamespace(path="/api/crons", query="all_profiles=1")) is not False
    body = _payload(handler)

    assert handler.status == 200
    assert body["all_profiles"] is False
    assert body["other_profile_count"] == 0
    assert [job["owner_profile"] for job in body["jobs"]] == ["alpha"]
    assert lookups == ["alpha"]


def test_cron_jobs_cross_profile_skips_foreign_failures_but_reraises_active_failure(monkeypatch):
    import api.profiles as profiles
    import api.routes as routes

    current_home = {"value": None}
    jobs_by_home = {
        "alpha-home": [{"id": "alpha-job", "name": "Alpha", "profile": None}],
        "beta-home": [{"id": "beta-job", "name": "Beta", "profile": None}],
        "gamma-home": [{"id": "gamma-job", "name": "Gamma", "profile": None}],
    }
    failing_homes = {"beta-home"}

    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")

    def _list_jobs(include_disabled=True):
        home = current_home["value"]
        if home in failing_homes:
            raise RuntimeError(f"boom-{home}")
        return [dict(job) for job in jobs_by_home[home]]

    cron_jobs.list_jobs = _list_jobs
    cron_jobs.use_cron_store = _store_context(current_home)
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    monkeypatch.setattr(profiles, "list_profiles_api", lambda: [
        {"name": "alpha", "visible": True},
        {"name": "beta", "visible": True},
        {"name": "gamma", "visible": True},
    ])
    monkeypatch.setattr(
        profiles,
        "get_hermes_home_for_profile",
        lambda name: Path({
            "alpha": "alpha-home",
            "beta": "beta-home",
            "gamma": "gamma-home",
        }[name]),
    )
    active_jobs, other_jobs = routes._cron_jobs_cross_profile("alpha")

    assert [job["owner_profile"] for job in active_jobs] == ["alpha"]
    assert [job["owner_profile"] for job in other_jobs] == ["gamma"]
    assert active_jobs[0]["read_only"] is False
    assert other_jobs[0]["read_only"] is True

    failing_homes.clear()
    failing_homes.add("alpha-home")

    with pytest.raises(RuntimeError, match="boom-alpha-home"):
        routes._cron_jobs_cross_profile("alpha")
