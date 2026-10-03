"""Cron store semantics the predecessor's routes relied on: monitor fields survive create, a null profile clears it,
a failed profile snapshot leaves no job behind, and pause/resume answer the raw store record."""

from __future__ import annotations

import pathlib

import pytest

from conftest import SidecarProcess, requires_agent


@requires_agent
def test_create_keeps_monitor_fields_and_update_clears_profile(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    home = str(hermes_home)
    created = handshaken.result("cron.create", {"profile_home": home, "job": {"schedule": "every 1h", "prompt": "say hi", "monitor_url": "https://example.com/status", "monitor_script": "", "profile": "research"}})
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
    stored = handshaken.result("cron.list", {"profile_home": str(hermes_home)})["jobs"]
    assert len(stored) == 1 and stored[0]["id"] == created["job"]["id"]
    assert stored[0]["provider"] == expected_provider
    assert stored[0]["model"] == expected_model
    assert stored[0]["profile"] == "research"
    assert not any(key.endswith("_snapshot") for key in stored[0])
    assert handshaken.result("cron.list", {"profile_home": str(execution_home)})["jobs"] == []


@requires_agent
def test_explicit_model_and_provider_skip_profile_resolution(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    created = handshaken.result("cron.create", {
        "profile_home": str(hermes_home), "execution_home": str(tmp_path / "missing-profile"),
        "job": {"schedule": "every 1h", "prompt": "say hi", "profile": "research", "model": "caller-model", "provider": "caller-provider"},
    })
    assert created["job"]["model"] == "caller-model"
    assert created["job"]["provider"] == "caller-provider"


@requires_agent
def test_a_failed_profile_snapshot_leaves_no_orphan_job(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    home = str(hermes_home)
    execution_home = tmp_path / "profiles" / "broken"
    execution_home.mkdir(parents=True)
    (execution_home / "config.yaml").write_text("model:\n  provider: custom\n  default: ''\n", encoding="utf-8")
    before = handshaken.result("cron.list", {"profile_home": home})["jobs"]
    message, _ = handshaken.call("cron.create", {"profile_home": home, "execution_home": str(execution_home), "job": {"schedule": "every 1h", "prompt": "x", "profile": "broken"}})
    assert "error" in message
    assert message["error"]["data"]["condition"] == "cron_snapshot_failed"
    assert handshaken.result("cron.list", {"profile_home": home})["jobs"] == before
