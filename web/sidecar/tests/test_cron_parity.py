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
    assert not any(key.endswith("_snapshot") for key in stored[0])
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
from cron.scheduler_tick import tick
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
