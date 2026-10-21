"""Disposable MCP child observes the launch secret through Talaria's actual save boundary."""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import commands, config
from tools import mcp_tool_discovery as discovery
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
from tools.mcp_tool_loop import _stop_mcp_loop
from tools.registry import registry

home = Path(os.environ["HERMES_HOME"]) / "profiles" / "save"
plugin = home / "plugins" / "envecho"
plugin.mkdir(parents=True)
(plugin / "server.py").write_text('''import os
from mcp.server.mcpserver import MCPServer
app = MCPServer("envecho")
@app.tool()
def key() -> str:
    return os.environ.get("DEMO_KEY", "") + ":" + os.environ.get("DEMO_LABEL", "")
app.run()
''')
(plugin / "run.sh").write_text(f'#!/bin/sh\nexec "{sys.executable}" "$(dirname "$0")/server.py"\n')
(plugin / "run.sh").chmod(0o755)
(plugin / "plugin.json").write_text(json.dumps({"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "envecho", "extensions": {"com.nousresearch.hermes": {"config_schema": {
    "api_key": {"type": "secret", "env": "DEMO_KEY"}, "label": {"type": "str"}}}}}))
(plugin / "mcp.json").write_text(json.dumps({"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "mcpServers": {"envecho": {
    "type": "stdio", "command": "./run.sh", "cwd": "${PLUGIN_ROOT}", "env": {"DEMO_KEY": "${DEMO_KEY}", "DEMO_LABEL": "${DEMO_LABEL}"}}}}))
(home / "config.yaml").write_text("plugins:\n  enabled: [envecho]\n")
(home / ".env").write_text("DEMO_KEY=first\nDEMO_LABEL=original\n")
other = home.parent / "borrower"
(other / "plugins").mkdir(parents=True)
(other / "plugins" / "envecho").symlink_to(plugin, target_is_directory=True)
# Portable packages inject PLUGIN_DATA into launch inputs; share that disposable directory to exercise borrowing.
(home / "plugin-data").mkdir(exist_ok=True)
(other / "plugin-data").symlink_to(home / "plugin-data", target_is_directory=True)
(other / "config.yaml").write_text("plugins:\n  enabled: [envecho]\n")
(other / ".env").write_text("DEMO_KEY=first\nDEMO_LABEL=original\n")

def read(profile=home):
    with scoped_home(profile):
        return str(registry.dispatch("mcp__envecho__key", {}))

def connection(profile=home):
    from tools.mcp_tool_common import _core
    with scoped_home(profile):
        key = discovery._resolve_server_key("envecho", _core._mcp_registry_scope(), current=False)
        return _core._servers[key].session

try:
    # Register the same rendered portable launch config through the native API to establish a real shared connection.
    from tools.mcp_tool_config import _interpolate_env_vars, _load_mcp_config
    for profile in (other, home):
        with scoped_home(profile):
            discovery.register_mcp_servers(_interpolate_env_vars(_load_mcp_config()))
    assert "first" in read(), "initial child did not receive the synthetic launch secret"
    if hasattr(discovery, "restart_mcp_servers_with_new_inputs"):
        assert connection() is connection(other), "fixture must exercise an actual borrowed connection"
    with scoped_home(home):
        config.env_write(home, {"DEMO_KEY": "second"})
    with scoped_home(home):
        saved = commands.save_plugin_settings("envecho", {}, {"api_key": "DEMO_KEY"} if hasattr(discovery, "restart_mcp_servers_with_new_inputs") else {})
    if hasattr(discovery, "restart_mcp_servers_with_new_inputs"):
        assert "second" in read(), "saved secret did not reach the live MCP child"
        assert saved["runtime_application"] == "applied", saved
        assert "first" in read(other), "saving a borrower killed or replaced the other profile's child"
        current = connection()
        with scoped_home(home):
            commands.save_plugin_settings("envecho", {"label": "non-launch setting"})
        assert connection() is current, "a non-launch setting replaced a healthy connection"
        # The native comparison covers non-secret launch inputs too; their storage remains Agent-owned.
        with scoped_home(home):
            config.env_write(home, {"DEMO_LABEL": "changed"})
        with scoped_home(home):
            commands.save_plugin_settings("envecho", {"label": "changed"})
        assert "second:changed" in read(), "changed non-secret launch input did not reach the child"
        assert connection() is not current
        for value in ("third", "latest"):
            with scoped_home(home):
                config.env_write(home, {"DEMO_KEY": value})
            with scoped_home(home):
                result = commands.save_plugin_settings("envecho", {}, {"api_key": "DEMO_KEY"})
            assert result["runtime_application"] == "applied", result
            assert value in read(), "repeated saves did not converge on the latest launch value"
            assert "first" in read(other), "a later save disturbed the other profile"
    else:
        assert saved["runtime_application"] == "restart_required", saved
    assert "second" not in json.dumps(saved), "secret leaked into ordinary save payload"
finally:
    shutdown_mcp_servers()
    _stop_mcp_loop()
