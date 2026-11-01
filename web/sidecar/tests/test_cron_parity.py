"""Cron store semantics the predecessor's routes relied on: monitor fields survive create, a null profile clears it,
a failed profile snapshot leaves no job behind, and pause/resume answer the raw store record."""

from __future__ import annotations

import pathlib
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent


@requires_agent
def test_create_keeps_monitor_fields_and_update_clears_profile(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    home = str(hermes_home)
    created = handshaken.result("cron.create", {"profile_home": home, "execution_home": home, "job": {"schedule": "every 1h", "prompt": "say hi", "model": "test-model", "provider": "test-provider", "monitor_url": "https://example.com/status", "monitor_script": "", "profile": "research"}})
    job = created["job"]
    assert job["monitor_url"] == "https://example.com/status" and job["monitor"] == "https://example.com/status"
    assert job["profile"] == "research"
    updated = handshaken.result("cron.update", {"profile_home": home, "job_id": job["id"], "updates": {"profile": None}})
    assert updated["job"]["profile"] is None
    paused = handshaken.result("cron.pause", {"profile_home": home, "job_id": job["id"], "reason": "hold"})
    assert paused["job"]["id"] == job["id"] and "monitor" not in paused["job"]  # raw store record, no API decoration
    resumed = handshaken.result("cron.resume", {"profile_home": home, "job_id": job["id"]})
    assert resumed["job"]["id"] == job["id"]
    # The store also resolves a job by name, as the predecessor passed ids verbatim.
    handshaken.result("cron.update", {"profile_home": home, "job_id": job["id"], "updates": {"name": "nightly report"}})
    assert handshaken.result("cron.pause", {"profile_home": home, "job_id": "nightly report"})["job"]["id"] == job["id"]


@requires_agent
@pytest.mark.parametrize("overrides, expected_provider, expected_model", [
    ({}, "openrouter", "profile-model"),
    ({"model": "caller-model"}, "openrouter", "caller-model"),
    ({"provider": "caller-provider"}, "caller-provider", "profile-model"),
    ({"model": "", "provider": ""}, "openrouter", "profile-model"),
    ({"model": " ", "provider": "\t"}, "openrouter", "profile-model"),
])
def test_create_pins_execution_profile_model(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path, overrides: dict, expected_provider: str, expected_model: str) -> None:
    (hermes_home / "config.yaml").write_text("model:\n  provider: openrouter\n  default: store-model\n", encoding="utf-8")
    execution_home = tmp_path / "profiles" / "research"
    execution_home.mkdir(parents=True)
    (execution_home / "config.yaml").write_text("model:\n  provider: openrouter\n  default: profile-model\n", encoding="utf-8")
    (execution_home / ".env").write_text("OPENROUTER_API_KEY=synthetic-test-key\n", encoding="utf-8")
    created = handshaken.result("cron.create", {
        "profile_home": str(hermes_home), "execution_home": str(execution_home),
        "job": {"schedule": "every 1h", "prompt": "say hi", "profile": "research", **overrides},
    })
    stored = handshaken.result("cron.list", {"profile_home": str(execution_home)})["jobs"]
    assert len(stored) == 1 and stored[0]["id"] == created["job"]["id"]
    assert stored[0]["provider"] == expected_provider
    assert stored[0]["model"] == expected_model
    assert stored[0]["profile"] == "research"
    # The pin replaces any model snapshot; Agent 0.21.3 still stores its snapshot keys, empty for a pinned job.
    assert not any(value for key, value in stored[0].items() if key.endswith("_snapshot")), stored[0]
    assert handshaken.result("cron.list", {"profile_home": str(hermes_home)})["jobs"] == []


@requires_agent
def test_explicit_model_and_provider_skip_profile_resolution(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    execution_home = tmp_path / "profiles" / "unconfigured"
    execution_home.mkdir(parents=True)
    created = handshaken.result("cron.create", {
        "profile_home": str(hermes_home), "execution_home": str(execution_home),
        "job": {"schedule": "every 1h", "prompt": "say hi", "profile": "research", "model": "caller-model", "provider": "caller-provider"},
    })
    assert created["job"]["model"] == "caller-model"
    assert created["job"]["provider"] == "caller-provider"


@requires_agent
def test_scheduled_script_uses_execution_profile_scope(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    execution_home = tmp_path / "profiles" / "research"
    execution_home.mkdir(parents=True)
    for home, marker in ((hermes_home, "owner"), (execution_home, "execution")):
        (home / ".env").write_text(f"OPENROUTER_API_KEY=synthetic-{marker}-key\n", encoding="utf-8")
        (home / "scripts").mkdir()
        (home / "scripts" / "scope.py").write_text(
            "import json, os\nprint(json.dumps({'home': os.environ.get('HERMES_HOME'), 'key': os.environ.get('OPENROUTER_API_KEY')}))\n",
            encoding="utf-8",
        )
    created = handshaken.result("cron.create", {
        "profile_home": str(hermes_home), "execution_home": str(execution_home),
        "job": {"schedule": "every 1h", "script": "scope.py", "no_agent": True, "profile": "research", "owner_profile": "default"},
    })["job"]
    # Fire through the Agent's real scheduled tick in each store. No manual-run execution_home override.
    code = """
import json, sys
sys.path.insert(0, sys.argv[1])
from cron.jobs import get_job, update_job
from cron import scheduler
try:
    from cron.scheduler_tick import tick
except ImportError:  # Agent 0.21.3 keeps its scheduled tick in cron.scheduler
    from cron.scheduler import tick
from agent.secret_scope import get_secret
original_run = scheduler.run_job
def observe_scope(job, **kwargs):
    scoped_key = get_secret('OPENROUTER_API_KEY')
    success, output, response, error = original_run(job, **kwargs)
    return success, output + '\\n' + json.dumps({'scoped_key': scoped_key}), response, error
scheduler.run_job = observe_scope
job = get_job(sys.argv[2])
if job:
    update_job(job['id'], {'next_run_at': '2000-01-01T00:00:00+00:00'})
tick(verbose=False)
"""
    for home in (hermes_home, execution_home):
        subprocess.run([AGENT_PYTHON, "-c", code, str(AGENT_DIR), created["id"]], env=isolated_env(home, home=tmp_path), check=True, capture_output=True, text=True, timeout=60)
    outputs = handshaken.result("cron.output", {"profile_home": str(execution_home), "job_id": created["id"]})
    assert outputs["outputs"], outputs
    assert "synthetic-execution-key" in outputs["outputs"][0]["content"]
    assert str(execution_home) in outputs["outputs"][0]["content"]
    assert created["owner_profile"] == "default"
    assert not (hermes_home / "cron" / "output" / created["id"]).exists()


@requires_agent
def test_a_failed_profile_snapshot_leaves_no_orphan_job(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    home = str(hermes_home)
    execution_home = tmp_path / "profiles" / "broken"
    execution_home.mkdir(parents=True)
    (execution_home / "config.yaml").write_text("model:\n  provider: custom\n  default: ''\n", encoding="utf-8")
    before = handshaken.result("cron.list", {"profile_home": home})["jobs"]
    before_execution = handshaken.result("cron.list", {"profile_home": str(execution_home)})["jobs"]
    message, _ = handshaken.call("cron.create", {"profile_home": home, "execution_home": str(execution_home), "job": {"schedule": "every 1h", "prompt": "x", "profile": "broken"}})
    assert "error" in message
    assert message["error"]["data"]["condition"] == "cron_snapshot_failed"
    assert handshaken.result("cron.list", {"profile_home": home})["jobs"] == before
    assert handshaken.result("cron.list", {"profile_home": str(execution_home)})["jobs"] == before_execution


@requires_agent
def test_delivery_options_list_messaging_platforms(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    # Agent 0.22.3 moved messaging platforms out of _KNOWN_DELIVERY_PLATFORMS into plugin registry entries.
    platforms = [p["value"] for p in handshaken.result("cron.delivery_options", {"profile_home": str(hermes_home)})["platforms"]]
    assert platforms[:2] == ["local", "origin"] and platforms[2:] == sorted(platforms[2:])
    assert {"telegram", "discord", "slack", "matrix"} <= set(platforms), platforms


def _pin_profile(home: pathlib.Path, name: str, *, timezone: str = "UTC", expand: bool = True) -> None:
    """A synthetic profile with its own main model; ``expand`` reads model and provider from its ``.env`` via ``${VAR}``."""
    home.mkdir(parents=True, exist_ok=True)
    model, provider = ("${PIN_MODEL}", "${PIN_PROVIDER}") if expand else (f"{name}-fixture-model", "openrouter")
    (home / "config.yaml").write_text(
        f"timezone: {timezone}\nmodel:\n  provider: {provider}\n  default: {model}\n", encoding="utf-8")
    (home / ".env").write_text(
        f"PIN_MODEL={name}-fixture-model\nPIN_PROVIDER=openrouter\nOPENROUTER_API_KEY=synthetic-{name}-key\n", encoding="utf-8")


def _unpinned_job(sidecar: SidecarProcess, home: pathlib.Path, profile: str) -> str:
    """A job in ``home``'s own store that follows the main model (no pin), created without resolving any profile."""
    job = sidecar.result("cron.create", {"profile_home": str(home), "execution_home": str(home), "job": {
        "schedule": "every 1h", "prompt": "say hi", "profile": profile, "model": "seed-model", "provider": "seed-provider"}})["job"]
    released = sidecar.result("cron.update", {"profile_home": str(home), "job_id": job["id"], "updates": {"pinned": False}})["job"]
    assert (released["provider"], released["model"]) == (None, None), released
    return job["id"]


@requires_agent
@pytest.mark.parametrize("store", ["root", "beta"])
def test_update_pins_the_store_profiles_own_main_model(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path, store: str) -> None:
    _pin_profile(hermes_home, "root", expand=False)
    beta = tmp_path / "profiles" / "beta"
    _pin_profile(beta, "beta", expand=False)
    home = hermes_home if store == "root" else beta
    job_id = _unpinned_job(handshaken, home, store)
    pinned = handshaken.result("cron.update", {"profile_home": str(home), "job_id": job_id, "updates": {"pinned": True}})["job"]
    assert (pinned["provider"], pinned["model"]) == ("openrouter", f"{store}-fixture-model"), pinned
    # A fresh read from the store, not the update's echo.
    stored = handshaken.result("cron.get", {"profile_home": str(home), "job_id": job_id})["job"]
    assert (stored["provider"], stored["model"]) == ("openrouter", f"{store}-fixture-model"), stored
    # Unpinning releases both; an explicit model in the same update wins over the profile's main model.
    released = handshaken.result("cron.update", {"profile_home": str(home), "job_id": job_id, "updates": {"pinned": False}})["job"]
    assert (released["provider"], released["model"]) == (None, None), released
    explicit =handshaken.result("cron.update", {"profile_home": str(home), "job_id": job_id, "updates": {
        "pinned": True, "model": "caller-model", "provider": "caller-provider"}})["job"]
    assert (explicit["provider"], explicit["model"]) == ("caller-provider", "caller-model"), explicit


@requires_agent
def test_concurrent_pins_never_read_another_profiles_runtime(hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    # The launch environment carries the same names a profile's config expands; a named profile must never see them.
    sidecar = SidecarProcess(hermes_home, env={"PIN_MODEL": "launch-env-model", "PIN_PROVIDER": "launch-env-provider"})
    try:
        from talaria_sidecar import SIDECAR_RPC_VERSION

        assert sidecar.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
        _pin_profile(hermes_home, "root")
        homes = {name: tmp_path / "profiles" / name for name in ("alpha", "beta")}
        for name, home in homes.items():
            _pin_profile(home, name)
        # Gamma names a variable only alpha's .env defines: a miss must stay a miss, never alpha's value.
        gamma = homes["gamma"] = tmp_path / "profiles" / "gamma"
        gamma.mkdir(parents=True)
        (gamma / "config.yaml").write_text("model:\n  provider: openrouter\n  default: ${ALPHA_ONLY}\n", encoding="utf-8")
        (homes["alpha"] / ".env").write_text((homes["alpha"] / ".env").read_text() + "ALPHA_ONLY=alpha-secret-model\n", encoding="utf-8")
        jobs = {name: _unpinned_job(sidecar, home, name) for name, home in homes.items()}
        for _ in range(3):
            pending = {}
            for name, home in homes.items():
                pending[sidecar.request("cron.update", {"profile_home": str(home), "job_id": jobs[name], "updates": {"pinned": True}})] = name
            while pending:
                message = sidecar.next_message(timeout=60)
                assert message is not None, sidecar.stderr_lines[-20:]
                if message.get("id") in pending:
                    assert "error" not in message, message
                    pending.pop(message["id"])
            for name, home in homes.items():
                stored = sidecar.result("cron.get", {"profile_home": str(home), "job_id": jobs[name]})["job"]
                if name == "gamma":
                    assert stored["model"] not in ("alpha-secret-model", "root-fixture-model", "launch-env-model"), stored
                else:
                    assert (stored["provider"], stored["model"]) == ("openrouter", f"{name}-fixture-model"), stored
                sidecar.result("cron.update", {"profile_home": str(home), "job_id": jobs[name], "updates": {"pinned": False}})
    finally:
        sidecar.close()


@requires_agent
def test_profile_scope_is_restored_after_a_refused_update(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    _pin_profile(hermes_home, "root")
    beta = tmp_path / "profiles" / "beta"
    _pin_profile(beta, "beta")
    root_job, beta_job = _unpinned_job(handshaken, hermes_home, "root"), _unpinned_job(handshaken, beta, "beta")
    # The Agent refuses an invalid schedule after the pin is resolved inside the beta scope.
    refused, _ = handshaken.call("cron.update", {"profile_home": str(beta), "job_id": beta_job, "updates": {"pinned": True, "schedule": "not a schedule"}})
    assert "error" in refused, refused
    assert handshaken.result("cron.get", {"profile_home": str(beta), "job_id": beta_job})["job"]["model"] is None
    missing, _ = handshaken.call("cron.update", {"profile_home": str(beta), "job_id": "missing-job", "updates": {"pinned": True}})
    assert missing["error"]["data"]["condition"] == "not_found", missing
    root = handshaken.result("cron.update", {"profile_home": str(hermes_home), "job_id": root_job, "updates": {"pinned": True}})["job"]
    assert root["model"] == "root-fixture-model", root
    assert handshaken.result("cron.update", {"profile_home": str(beta), "job_id": beta_job, "updates": {"pinned": True}})["job"]["model"] == "beta-fixture-model"


@requires_agent
@pytest.mark.parametrize("method", ["cron.update", "cron.resume"])
def test_schedule_times_follow_the_store_profiles_timezone(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path, method: str) -> None:
    _pin_profile(hermes_home, "root", timezone="UTC")
    beta = tmp_path / "profiles" / "beta"
    _pin_profile(beta, "beta", timezone="Asia/Tokyo")
    job_id = _unpinned_job(handshaken, beta, "beta")
    if method == "cron.update":
        job = handshaken.result("cron.update", {"profile_home": str(beta), "job_id": job_id, "updates": {"schedule": "0 9 * * *"}})["job"]
    else:
        handshaken.result("cron.update", {"profile_home": str(beta), "job_id": job_id, "updates": {"schedule": "0 9 * * *"}})
        assert handshaken.result("cron.pause", {"profile_home": str(beta), "job_id": job_id})["job"]["paused_at"].endswith("+09:00")
        job = handshaken.result("cron.resume", {"profile_home": str(beta), "job_id": job_id})["job"]
    assert job["next_run_at"].endswith("T09:00:00+09:00"), job
