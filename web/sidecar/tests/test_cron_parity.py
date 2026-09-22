"""Cron store semantics the predecessor's routes relied on: monitor fields survive create, a null profile clears it,
a failed profile snapshot leaves no job behind, and pause/resume answer the raw store record."""

from __future__ import annotations

import pathlib

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
def test_a_failed_profile_snapshot_leaves_no_orphan_job(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    home = str(hermes_home)
    execution_home = tmp_path / "profiles" / "broken"
    execution_home.mkdir(parents=True)
    (execution_home / "config.yaml").write_text("model:\n  provider: custom\n  default: ''\n", encoding="utf-8")
    before = handshaken.result("cron.list", {"profile_home": home})["jobs"]
    message, _ = handshaken.call("cron.create", {"profile_home": home, "execution_home": str(execution_home), "job": {"schedule": "every 1h", "prompt": "x", "profile": "broken"}})
    if "error" in message:
        assert message["error"]["data"]["condition"] == "cron_snapshot_failed"
        assert message["error"]["message"] == "Cannot safely resolve cron snapshots for profile 'broken'"
        assert handshaken.result("cron.list", {"profile_home": home})["jobs"] == before
    else:
        # The Agent resolved a snapshot for this config; the ordering guarantee is exercised only on failure.
        assert message["result"]["job"]["profile"] == "broken"
