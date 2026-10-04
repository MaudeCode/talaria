"""MCP servers are per profile: a fresh sidecar's first turn connects the turn profile's servers before the Agent
snapshots its tools, and ``/reload-mcp`` in one profile tears down and rediscovers only that profile's connections.
Both run the pinned Agent's real MCP client against a stub stdio server."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, requires_agent

STUB_SERVER = """
import sys
from mcp.server.mcpserver import MCPServer

server = MCPServer(sys.argv[1])


@server.tool()
def ping() -> str:
    return "pong"


server.run()
"""

# Runs on the Agent interpreter: a fresh process (a restarted sidecar) whose stand-in AIAgent records the tool schemas
# the real ``model_tools`` resolver would hand it for the turn's toolsets (uncollapsed, as the Agent's tool search reads it).
FIRST_TURN_PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

seen = []

class FakeAgent:
    def __init__(self, **kwargs):
        from model_tools import get_tool_definitions

        tools = get_tool_definitions(enabled_toolsets=kwargs.get("enabled_toolsets"), quiet_mode=True, skip_tool_search_assembly=True)
        seen.append(sorted(tool["function"]["name"] for tool in tools))

    def run_conversation(self, **kwargs):
        return {"final_response": "ok", "messages": []}

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._agent_class = lambda: FakeAgent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
home = Path(os.environ["HERMES_HOME"])
params = {"profile_home": str(home), "session_id": "s", "stream_id": "st", "user_message": "hi", "model": "m", "model_provider": "p"}
with scoped_home(home):
    result = chat.start(Ctx(), params)
assert result["status"] == "completed", result
print(json.dumps(seen))
"""


def _configure_stub(home: pathlib.Path, name: str, script: pathlib.Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(f"mcp_servers:\n  {name}:\n    command: {json.dumps(AGENT_PYTHON)}\n    args: [{json.dumps(str(script))}, {name}]\n")


def _stub_script(tmp_path: pathlib.Path) -> pathlib.Path:
    script = tmp_path / "stub_mcp_server.py"
    script.write_text(STUB_SERVER)
    return script


@requires_agent
def test_first_turn_after_a_restart_exposes_the_profiles_mcp_tools(tmp_path) -> None:
    root = tmp_path / ".hermes"
    _configure_stub(root, "stub_a", _stub_script(tmp_path))
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "HERMES_HOME": str(root), "PYTHONPATH": str(SIDECAR_ROOT), "HERMES_STATE_DB_GUARD_BYPASS": "1"}
    if os.environ.get("LD_LIBRARY_PATH"):  # relocated actions/setup-python interpreter
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    run = subprocess.run([AGENT_PYTHON, "-c", FIRST_TURN_PROBE, str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=180)
    assert run.returncode == 0, run.stderr[-4000:]
    (tools,) = json.loads(run.stdout.strip().splitlines()[-1])
    assert "mcp__stub_a__ping" in tools, tools


def _status(sidecar: SidecarProcess, home: pathlib.Path) -> dict:
    return {entry["name"]: entry["status"] for entry in sidecar.result("mcp.status", {"profile_home": str(home)})["servers"]}


@requires_agent
def test_reload_mcp_in_one_profile_leaves_another_profiles_servers_connected(tmp_path) -> None:
    script = _stub_script(tmp_path)
    launch = tmp_path / "home" / ".hermes"
    named = launch / "profiles" / "b"
    _configure_stub(launch, "stub_a", script)
    _configure_stub(named, "stub_b", script)
    sidecar = SidecarProcess(launch)
    try:
        def reload(home: pathlib.Path) -> dict:
            reply, _ = sidecar.call("commands.exec", {"command": "/reload-mcp", "profile_home": str(home)}, timeout=120)
            return reply

        b_reply = reload(named)
        assert _status(sidecar, named) == {"stub_b": "connected"}
        a_reply = reload(launch)
        assert _status(sidecar, launch) == {"stub_a": "connected"}
        # Profile A's reload must not have torn down profile B's connection.
        assert _status(sidecar, named) == {"stub_b": "connected"}
        # Each reload reports only its own profile's servers.
        assert "Added: stub_b" in b_reply["result"]["output"], b_reply
        assert "Added: stub_a" in a_reply["result"]["output"] and "stub_b" not in a_reply["result"]["output"], a_reply
    finally:
        sidecar.close()
