"""``aux.tasks`` (TAL-800): the profile's auxiliary slots as the pinned Agent lists them.

The plugins are synthetic and live in disposable homes: the root home has an inheriting task and a plain one, a named
profile has neither. Nothing touches ``~/.hermes`` or a real account.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from conftest import AGENT_DIR, SidecarProcess, load_schema, requires_agent, validate

SIDE = "register_auxiliary_task('side_task', display_name='Side model', description='side summaries', inherit_from='compression')"
ALPHA = "register_auxiliary_task('alpha_task', display_name='Alpha model', description='alpha scoring', defaults={'timeout': 7})"


def _plugin(home: pathlib.Path, name: str, call: str) -> None:
    path = home / "plugins" / name
    path.mkdir(parents=True)
    # JSON is valid YAML.
    (path / "plugin.yaml").write_text(json.dumps({"name": name, "version": "0.1.0", "description": f"{name} probe"}))
    (path / "__init__.py").write_text(f"def register(ctx):\n    ctx.{call}\n")


def _rows(sidecar: SidecarProcess, home: pathlib.Path) -> dict[str, dict]:
    result = sidecar.result("aux.tasks", {"profile_home": str(home)})
    assert validate(result, load_schema("aux.tasks")) == []
    rows = {row["key"]: row for row in result["tasks"]}
    # The Agent's other auxiliary keys (settings and unlisted routes) are reported, and never overlap a slot.
    assert {"goal_judge", "free_only"} <= set(result["reserved"]) and not set(result["reserved"]) & set(rows)
    return rows


@requires_agent
@pytest.mark.skipif(AGENT_DIR is None or "inherit_from" not in (AGENT_DIR / "hermes_cli/plugins.py").read_text(), reason="voice_chat and inheriting plugin tasks require Agent v0.21.6")
def test_slots_follow_the_agent_with_plugin_tasks_per_profile(tmp_path: pathlib.Path) -> None:
    home = tmp_path / "home" / ".hermes"
    _plugin(home, "side", SIDE)
    _plugin(home, "alpha_plugin", ALPHA)
    config = {"plugins": {"enabled": ["side", "alpha_plugin"]}, "auxiliary": {"compression": {"provider": "openrouter", "model": "vendor/model-a"}}}
    (home / "config.yaml").write_text(json.dumps(config))
    other = home / "profiles" / "b"
    other.mkdir(parents=True)
    (other / "config.yaml").write_text(json.dumps({"plugins": {"enabled": ["side", "alpha_plugin"]}}))
    sidecar = SidecarProcess(home)
    try:
        rows = _rows(sidecar, home)
        keys = list(rows)
        # The Agent's built-ins in its order, then this profile's plugin tasks.
        assert keys[:4] == ["vision", "compression", "approval", "mcp"] and keys[-2:] == ["alpha_task", "side_task"], keys
        assert rows["voice_chat"] == {"key": "voice_chat", "label": "Voice chat", "description": "spoken voice-mode replies", "inherit_from": None, "reasoning_effort": "none", "effective": None}
        assert rows["compression"]["reasoning_effort"] == ""
        assert rows["alpha_task"] == {"key": "alpha_task", "label": "Alpha model", "description": "alpha scoring", "inherit_from": None, "reasoning_effort": "", "effective": None}
        # An unpinned inheriting task runs on its base slot's route.
        assert rows["side_task"]["inherit_from"] == "compression"
        assert rows["side_task"]["effective"] == {"provider": "openrouter", "model": "vendor/model-a", "base_url": ""}

        # Another profile lists only its own plugins (none installed there).
        assert not {"alpha_task", "side_task"} & set(_rows(sidecar, other))

        # Pinning the task replaces the inherited route; returning it to Auto follows the base again.
        config["auxiliary"]["side_task"] = {"provider": "anthropic", "model": "claude-x"}
        sidecar.result("config.set", {"profile_home": str(home), "config": config})
        assert _rows(sidecar, home)["side_task"]["effective"] == {"provider": "anthropic", "model": "claude-x", "base_url": ""}
        config["auxiliary"]["side_task"] = {"provider": "auto", "model": ""}
        config["auxiliary"]["voice_chat"] = {"reasoning_effort": "high"}
        sidecar.result("config.set", {"profile_home": str(home), "config": config})
        rows = _rows(sidecar, home)
        assert rows["side_task"]["effective"] == {"provider": "openrouter", "model": "vendor/model-a", "base_url": ""}
        assert rows["voice_chat"]["reasoning_effort"] == "high"
    finally:
        sidecar.close()
