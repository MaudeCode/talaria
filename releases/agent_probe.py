#!/usr/bin/env python3
"""Exercise actual Agent imports and its SQLite contract without any provider."""

import importlib
import os
import socket
import sys
from pathlib import Path


def deny_network(*args, **kwargs):
    raise AssertionError("Agent compatibility probe must not use the network")


socket.socket.connect = deny_network
socket.create_connection = deny_network
socket.getaddrinfo = deny_network

# The harness supplies a disposable home, never an operator's Agent directory.
home = Path(os.environ["HERMES_HOME"])
home.mkdir(parents=True, exist_ok=True)
for module in ("run_agent", "hermes_cli.runtime_provider", "agent.auxiliary_client", "agent.model_metadata"):
    importlib.import_module(module)
from api.agent_sessions import read_importable_agent_session_rows
from hermes_cli import __version__
from hermes_state import SessionDB

assert __version__ == sys.argv[1], (__version__, sys.argv[1])
database = home / "compatibility.db"
db = SessionDB(database)
try:
    db.create_session("talaria-synthetic-session", source="cli")
    db.append_message("talaria-synthetic-session", role="user", content="Synthetic compatibility message")
    db.append_message("talaria-synthetic-session", role="assistant", content="Synthetic response")
finally:
    db.close()
rows = read_importable_agent_session_rows(database)
assert len(rows) == 1 and rows[0]["id"] == "talaria-synthetic-session", rows
assert rows[0]["message_count"] == 2, rows
print(f"PASS Agent {__version__}: imports and real SessionDB -> Web projection")
