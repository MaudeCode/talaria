"""TAL-2133: ``plugins.set_enabled`` turns a plugin on and off through the Agent's own writer, and ``plugins.list`` offers the switch."""

from __future__ import annotations

import pathlib

from conftest import SidecarProcess, load_schema, requires_agent, validate


@requires_agent
def test_the_agent_turns_a_synthetic_plugin_on_and_off(tmp_path: pathlib.Path) -> None:
    home = tmp_path / "home" / ".hermes"
    for name, kind in (("team-notes", "standalone"), ("solo-backend", "exclusive")):
        path = home / "plugins" / name
        path.mkdir(parents=True)
        (path / "plugin.yaml").write_text(f"name: {name}\nversion: 0.0.1\ndescription: Synthetic probe\nkind: {kind}\n")
        (path / "__init__.py").write_text("def register(ctx):\n    pass\n")
    sidecar = SidecarProcess(home)

    def listed() -> dict:
        rows = sidecar.result("plugins.list", {"profile_home": str(home), "selected_providers": {}})
        assert validate(rows, load_schema("plugins.list")) == []
        return {row["key"]: row for row in rows["plugins"]}

    def set_enabled(key: str, enabled: bool) -> dict:
        result = sidecar.result("plugins.set_enabled", {"profile_home": str(home), "key": key, "enabled": enabled})
        assert validate(result, load_schema("plugins.set_enabled")) == []
        return result

    try:
        rows = listed()
        assert rows["team-notes"]["enabled"] is False
        assert rows["team-notes"]["can_toggle"] is True
        assert (rows["solo-backend"]["kind"], rows["solo-backend"]["can_toggle"]) == ("exclusive", False)

        on = set_enabled("team-notes", True)
        assert on["supported"] is True and on["ok"] is True and on["name"] == "team-notes" and on["unchanged"] is False
        assert listed()["team-notes"]["enabled"] is True
        assert set_enabled("team-notes", True)["unchanged"] is True

        off = set_enabled("team-notes", False)
        assert off == {"supported": True, "ok": True, "name": "team-notes", "unchanged": False, "restart_required": True}
        assert listed()["team-notes"]["enabled"] is False

        unknown = set_enabled("no-such-plugin", True)
        assert unknown["supported"] is True and unknown["ok"] is False and "no-such-plugin" in unknown["error"]
        message, _ = sidecar.call("plugins.set_enabled", {"profile_home": str(home), "key": "team-notes", "enabled": "yes"})
        assert message["error"]["code"] == -32602
    finally:
        sidecar.close()
