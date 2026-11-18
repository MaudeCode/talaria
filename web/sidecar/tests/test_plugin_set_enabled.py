"""TAL-2133: ``plugins.set_enabled`` turns a plugin on and off through the Agent's own writer, and ``plugins.list`` offers the switch."""

from __future__ import annotations

import pathlib
import sys
from types import ModuleType

import pytest

from conftest import SidecarProcess, load_schema, requires_agent, validate
from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import commands


@pytest.fixture
def agent(monkeypatch):
    """The Agent modules ``set_plugin_enabled`` reaches, recording every writer and rediscovery call."""
    state = {"managed": False, "refusal": None, "calls": []}

    class PluginOperationError(Exception):
        pass

    def set_enabled(key, *, enabled):
        state["calls"].append(("set", key, enabled))
        if state["refusal"]:
            raise PluginOperationError(state["refusal"])
        return {"ok": True, "name": key}

    modules = {
        "hermes_cli": {},
        "hermes_cli.plugins_cmd": {"dashboard_set_agent_plugin_enabled": set_enabled, "PluginOperationError": PluginOperationError},
        "hermes_cli.plugins_admission": {},
        "hermes_cli.config": {"is_managed": lambda: state["managed"], "format_managed_message": lambda action: f"Managed install: cannot {action}."},
        "hermes_cli.plugins": {"discover_plugins": lambda force: state["calls"].append(("discover", force))},
    }
    for name, values in modules.items():
        module = ModuleType(name)
        module.__dict__.update(values)
        monkeypatch.setitem(sys.modules, name, module)
    return state


def test_a_managed_install_refuses_the_switch_before_the_agent_writes(agent):
    agent["managed"] = True
    with pytest.raises(RpcError) as refused:
        commands.set_plugin_enabled("team-notes", True)
    assert refused.value.data == {"condition": "plugin_enable_managed"}
    assert str(refused.value) == "Managed install: cannot change plugins."
    assert agent["calls"] == []


def test_a_recalled_plugin_the_agent_refuses_is_a_failed_switch_not_an_error(agent):
    agent["refusal"] = "Plugin 'team-notes' was recalled by the catalog"
    assert commands.set_plugin_enabled("team-notes", True) == {"supported": True, "ok": False, "error": "Plugin 'team-notes' was recalled by the catalog"}
    assert agent["calls"] == [("set", "team-notes", True)]


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
