"""Regression coverage for issue #1700 parallel profile switching.

A WebUI profile switch uses cookie/thread-local profile state, so it should be
allowed while another session is streaming. Only process-wide profile switches
must remain blocked because they mutate global Hermes runtime state.
"""
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.resolve()
def _prepare_profile_tree(tmp_path, monkeypatch):
    import api.profiles as profiles

    default_home = tmp_path / ".hermes"
    target_home = default_home / "profiles" / "writer"
    target_workspace = tmp_path / "writer-workspace"
    target_workspace.mkdir(parents=True)
    target_home.mkdir(parents=True)
    (target_home / "config.yaml").write_text(
        f"model:\n  provider: openai-codex\n  default: gpt-5.5\n"
        f"terminal:\n  cwd: {target_workspace}\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", default_home)
    monkeypatch.setattr(profiles, "_active_profile", "default")
    monkeypatch.setattr(profiles, "list_profiles_api", lambda: [{"name": "default"}, {"name": "writer"}])
    profiles._tls.profile = None
    return profiles


def test_process_wide_switch_still_blocks_when_stream_is_active(tmp_path, monkeypatch):
    profiles = _prepare_profile_tree(tmp_path, monkeypatch)
    from api.config import STREAMS

    STREAMS.clear()
    STREAMS["stream-default"] = object()
    try:
        with pytest.raises(RuntimeError, match="Cannot switch profiles while an agent is running"):
            profiles.switch_profile("writer", process_wide=True)
    finally:
        STREAMS.clear()
        profiles._tls.profile = None


def test_per_client_switch_allowed_when_stream_is_active(tmp_path, monkeypatch):
    profiles = _prepare_profile_tree(tmp_path, monkeypatch)
    from api.config import STREAMS

    STREAMS.clear()
    STREAMS["stream-default"] = object()
    try:
        result = profiles.switch_profile("writer", process_wide=False)
    finally:
        STREAMS.clear()
        profiles._tls.profile = None

    assert result["active"] == "writer"
    assert result["default_model"] == "gpt-5.5"
