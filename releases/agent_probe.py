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
import sqlite3

try:
    # Agents since v0.21.6 resolve their identity from the install stamp, else the checkout's release tag;
    # their ``__version__`` reads only the stamp, which a source checkout does not have.
    from hermes_cli.version_info import get_version_info
    __version__ = get_version_info().base_version
except ModuleNotFoundError as error:
    if error.name != "hermes_cli.version_info":
        raise
    from hermes_cli import __version__
from hermes_state import SessionDB
from talaria_sidecar.methods import state_db as sidecar_state_db

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
print(f"PASS Agent {__version__}: imports, real SessionDB, and the sidecar write path")
