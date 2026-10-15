#!/usr/bin/env python3
"""Exercise actual Agent imports and its SQLite contract without any provider."""

import atexit
import importlib
import json
import os
import socket
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch


def deny_network(*args, **kwargs):
    raise AssertionError("Agent compatibility probe must not use the network")


socket.socket.connect = deny_network
socket.create_connection = deny_network
socket.getaddrinfo = deny_network

# Own HOME as well as Agent state, even when someone invokes the probe directly.
state = tempfile.TemporaryDirectory(prefix="talaria-agent-probe-home-")
atexit.register(state.cleanup)
os.environ["HOME"] = state.name
os.environ["HERMES_HOME"] = str(Path(state.name) / "hermes")
home = Path(os.environ["HERMES_HOME"])
home.mkdir(parents=True, exist_ok=True)
for name in ("run_agent", "hermes_cli.runtime_provider", "agent.auxiliary_client", "agent.model_metadata",
             "tools.file_tools", "tools.approval", "tools.terminal_tool"):
    module = importlib.import_module(name)
    if agent := os.environ.get("HERMES_WEBUI_AGENT_DIR"):
        assert Path(module.__file__).resolve().is_relative_to(Path(agent).resolve()), (name, module.__file__)
import sqlite3

from hermes_state import SessionDB
from talaria_sidecar.methods import state_db as sidecar_state_db
from talaria_sidecar.runtime import installed_agent_version

__version__ = installed_agent_version()

# A release check names its exact package version; an Agent main canary has none to require.
assert sys.argv[1:] in ([], [__version__]), (__version__, sys.argv[1:])
database = home / "state.db"  # the canonical Agent database the sidecar writes through
db = SessionDB(database)
try:
    db.create_session("talaria-synthetic-session", source="cli")
    db.append_message("talaria-synthetic-session", role="user", content="Synthetic compatibility message")
    db.append_message("talaria-synthetic-session", role="assistant", content="Synthetic response")
finally:
    db.close()
# The sidecar writes through the same SessionDB (state_db.* methods); the TypeScript
# server projects the resulting rows read-only. Verify the write side and the row
# shape that projection depends on.
with sqlite3.connect(database) as connection:
    rows = connection.execute("SELECT id, (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id) FROM sessions ORDER BY id").fetchall()
assert rows == [("talaria-synthetic-session", 2)], rows
assert sidecar_state_db.sync_session_start(home, "talaria-sidecar-session", model="synthetic") is True
with sqlite3.connect(database) as connection:
    sidecar_rows = connection.execute("SELECT id FROM sessions WHERE id = ?", ("talaria-sidecar-session",)).fetchall()
assert sidecar_rows == [("talaria-sidecar-session",)], sidecar_rows


def ssh_config_approval():
    """Observe real file tools; replace only the human approval response, never path policy."""
    from tools import approval, file_tools, terminal_tool

    target = Path(os.environ["HOME"]) / ".ssh/config"
    target.parent.mkdir(parents=True, exist_ok=True)
    original = "Host synthetic\n  HostName before.invalid\n"
    updated = "Host synthetic\n  ProxyCommand echo synthetic\n"
    observations = {}
    previous_cwd = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="process-", dir=home) as process:
        try:
            os.chdir(process)
            for tool in ("write", "edit"):
                for spelling in ("absolute", "relative"):
                    for decision in ("deny", "allow"):
                        task = f"talaria-ssh-{tool}-{spelling}-{decision}"
                        terminal_tool.register_task_env_overrides(task, {"env_type": "local", "cwd": str(target.parent.parent)})
                        # Writes cover creation; edits cover preserving an existing file on denial.
                        target.unlink(missing_ok=True)
                        if tool == "edit":
                            target.write_text(original)
                        before = target.read_bytes() if target.exists() else None
                        path = str(target) if spelling == "absolute" else ".ssh/config"
                        with patch.object(approval, "_run_approval_gate", return_value={
                            "approved": decision == "allow", "message": "Synthetic approval denied",
                        }) as gate:
                            if tool == "write":
                                file_tools.write_file_tool(path=path, content=updated, task_id=task)
                            else:
                                file_tools.patch_tool(path=path, old_string=original, new_string=updated, task_id=task)
                        after = target.read_bytes() if target.exists() else None
                        observations[f"{tool}/{spelling}/{decision}"] = {
                            "gateCalls": gate.call_count, "mutated": after != before,
                            "expectedContent": after == updated.encode(),
                        }
        finally:
            os.chdir(previous_cwd)
            target.unlink(missing_ok=True)
    return observations


observations = ssh_config_approval()
if report := os.environ.get("TALARIA_AGENT_PROBE_REPORT"):
    Path(report).write_text(json.dumps(observations))
print("SSH_CONFIG_APPROVAL " + json.dumps(observations, sort_keys=True))
if expected := os.environ.get("TALARIA_AGENT_SSH_EXPECTED"):
    assert observations == json.loads(expected), "task-relative SSH configuration approval differs in release image"
print(f"PASS Agent {__version__}: imports, real SessionDB, and the sidecar write path")
