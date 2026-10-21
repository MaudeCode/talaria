"""Persistence and runtime application are separate outcomes at the shared save boundary."""
import sys
from types import SimpleNamespace as NS

import pytest

from talaria_sidecar.methods import commands


@pytest.fixture
def settings_runtime(monkeypatch, tmp_path):
    saved = {}
    calls = []
    fields = lambda *args: [{"key": "endpoint", "type": "string", "value": saved.get("endpoint")},
                            {"key": "api_key", "type": "secret", "env": "DEMO_KEY", "has_value": True}]
    def write(key, path, values):
        saved.update(values)
        return list(values)
    pc = NS(_find_plugin_entry=lambda key: (None, None, None, None, tmp_path, "demo"),
            _is_portable_plugin_dir=lambda path: True)
    monkeypatch.setattr(commands, "_plugin_settings_modules", lambda: (pc, NS(plugin_settings_fields=fields, save_plugin_settings=write)))
    monkeypatch.setitem(sys.modules, "hermes_cli.agent_plugins", NS(load_agent_plugin=lambda *args: NS(mcp_servers={"echo": {}}, diagnostics=[])))
    monkeypatch.setitem(sys.modules, "hermes_cli.plugins_manifest", NS(portable_mcp_server_name=lambda key, server: server))
    manager = NS(discover_and_load=lambda **kwargs: None, _portable_mcp_server_plugins={"echo": "demo"})
    monkeypatch.setitem(sys.modules, "hermes_cli.plugins", NS(get_plugin_manager=lambda: manager))
    native = {}
    monkeypatch.setitem(sys.modules, "hermes_cli.config", NS(load_config_readonly=lambda: {"mcp_servers": native}))
    def reconnect(names):
        calls.append((names, dict(saved)))
        return ["echo"]
    discovery = NS(restart_mcp_servers_with_new_inputs=reconnect, get_mcp_status=lambda: [{"name": "echo", "status": "connected"}])
    monkeypatch.setitem(sys.modules, "tools.mcp_tool_discovery", discovery)
    monkeypatch.setitem(sys.modules, "tools", NS(mcp_tool_discovery=discovery))
    monkeypatch.setitem(sys.modules, "hermes_constants", NS(get_hermes_home=lambda: tmp_path))
    refreshed = []
    from talaria_sidecar.methods import chat
    monkeypatch.setattr(chat, "refresh_profile_agents_mcp_tools", lambda home: refreshed.append(home))
    return saved, calls, discovery, manager, native, refreshed


def test_nonsecret_inputs_reconcile_after_persistence_and_refresh_only_changed_connections(settings_runtime):
    saved, calls, discovery, _, _, refreshed = settings_runtime
    for value in ("one", "two"):
        result = commands.save_plugin_settings("demo", {"endpoint": value})
        assert result["runtime_application"] == "applied"
        assert calls[-1] == ({"echo"}, {"endpoint": value})
    assert len(refreshed) == 2
    discovery.restart_mcp_servers_with_new_inputs = lambda names: []
    commands.save_plugin_settings("demo", {"endpoint": "two"})
    assert len(refreshed) == 2


@pytest.mark.parametrize("outcome", ["unavailable", "failed", "connecting", "lost_ack", "missing_status"])
def test_runtime_failure_retains_saved_state_without_exposing_exception(settings_runtime, outcome):
    saved, calls, discovery, _, _, _ = settings_runtime
    if outcome == "unavailable":
        del discovery.restart_mcp_servers_with_new_inputs
    elif outcome == "lost_ack":
        def uncertain(names):
            calls.append(names)
            raise RuntimeError("synthetic-secret-must-not-leak")
        discovery.restart_mcp_servers_with_new_inputs = uncertain
    else:
        discovery.get_mcp_status = lambda: [] if outcome == "missing_status" else [{"name": "echo", "status": outcome}]
    result = commands.save_plugin_settings("demo", {"endpoint": "saved"}, {"api_key": "DEMO_KEY"})
    assert saved == {"endpoint": "saved"}
    assert result["runtime_application"] == ("restart_required" if outcome in {"unavailable", "failed"} else "unknown")
    assert "synthetic-secret-must-not-leak" not in str(result)
    assert len(calls) <= 1, "uncertain reconnect must not be retried"


@pytest.mark.parametrize("collision", ["native", "other_plugin"])
def test_colliding_server_names_never_restart_unrelated_servers(settings_runtime, collision):
    _, calls, _, manager, native, refreshed = settings_runtime
    if collision == "native":
        native["echo"] = {"command": "unrelated"}
    else:
        manager._portable_mcp_server_plugins["echo"] = "another-plugin"
    assert commands.save_plugin_settings("demo", {})["runtime_application"] == "applied"
    assert calls == refreshed == []


def test_unreadable_mcp_declaration_does_not_claim_runtime_application(settings_runtime, monkeypatch):
    saved, calls, _, _, _, _ = settings_runtime
    monkeypatch.setattr(sys.modules["hermes_cli.agent_plugins"], "load_agent_plugin",
                        lambda *args: NS(mcp_servers={}, diagnostics=[NS(scope="mcp")]))
    assert commands.save_plugin_settings("demo", {"endpoint": "saved"})["runtime_application"] == "unknown"
    assert saved == {"endpoint": "saved"} and not calls
