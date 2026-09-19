"""Regression coverage for the Kanban consolidated-view toggle.

The Kanban board can be rendered as profile lanes or as one consolidated
status-column board. The browser control must persist that choice back to the
shared Kanban config so reloads and other browsers see the same mode.
"""

from pathlib import Path
import re
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]

def test_kanban_config_patch_persists_lane_by_profile_to_config_yaml(tmp_path, monkeypatch):
    import api.config as config
    import api.kanban_bridge as bridge

    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        "dashboard:\n"
        "  kanban:\n"
        "    lane_by_profile: true\n"
        "    render_markdown: true\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "_get_config_path", lambda: cfg_path)
    monkeypatch.setattr(
        bridge,
        "_config_payload",
        lambda: {
            "columns": [],
            "assignees": [],
            "default_tenant": "",
            "lane_by_profile": True,
            "include_archived_by_default": False,
            "render_markdown": True,
            "read_only": False,
        },
    )
    config.reload_config()

    payload = bridge._update_config_payload({"lane_by_profile": False})

    assert payload["lane_by_profile"] is False
    written = config._load_yaml_config_file(cfg_path)
    assert written["dashboard"]["kanban"]["lane_by_profile"] is False
    assert written["dashboard"]["kanban"]["render_markdown"] is True


def test_kanban_config_patch_rejects_non_boolean_lane_by_profile():
    import api.kanban_bridge as bridge

    with pytest.raises(ValueError, match="lane_by_profile must be boolean"):
        bridge._update_config_payload({"lane_by_profile": "false"})


def test_kanban_config_patch_validation_returns_clean_400(monkeypatch):
    import api.kanban_bridge as bridge

    captured = {}

    def fake_bad(handler, msg, status=400):
        captured["msg"] = msg
        captured["status"] = status
        return True

    monkeypatch.setattr(bridge, "bad", fake_bad)

    result = bridge.handle_kanban_patch(
        object(),
        SimpleNamespace(path="/api/kanban/config", query=""),
        {"lane_by_profile": "false"},
    )

    assert result is True
    assert captured == {
        "msg": "lane_by_profile must be boolean",
        "status": 400,
    }
