"""Claim liveness and the dispatcher fence around Agent writes, against stand-in Agent modules."""

from __future__ import annotations

import contextlib
import sqlite3
import sys
import types

import pytest

from talaria_sidecar.methods import kanban

RUNNING = {"status": "running", "claim_lock": "here:4242", "worker_pid": 4242, "worker_started_at": None}


class Row(dict):
    def keys(self):  # sqlite3.Row exposes its columns through keys()
        return list(super().keys())


@pytest.fixture
def agent_kanban(monkeypatch):
    """A stand-in for the Agent's ``hermes_cli.kanban_db``."""
    package = types.ModuleType("hermes_cli")
    package.__path__ = []
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    kb = types.ModuleType("hermes_cli.kanban_db")
    monkeypatch.setitem(sys.modules, "hermes_cli.kanban_db", kb)
    return kb


def _fence_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE tasks (id TEXT, status TEXT, claim_lock TEXT, worker_pid INTEGER, worker_started_at INTEGER)")
    conn.execute("INSERT INTO tasks VALUES ('t1', 'ready', NULL, NULL, NULL)")
    return conn


@pytest.mark.parametrize("outcome", ["refused", "raised"])
def test_a_failed_agent_write_releases_the_dispatcher_fence(agent_kanban, outcome) -> None:
    conn = _fence_db()
    agent_kanban.write_txn = lambda c: contextlib.nullcontext()
    held = []

    def write():
        held.append(conn.execute("SELECT claim_lock FROM tasks").fetchone()[0])
        if outcome == "raised":
            raise ValueError("the Agent refused the write")
        return False

    if outcome == "raised":
        with pytest.raises(ValueError):
            kanban._fenced(conn, "t1", write, confirm_running_exit=False)
    else:
        assert kanban._fenced(conn, "t1", write, confirm_running_exit=False) is False
    assert held[0].startswith(kanban.FENCE_PREFIX)  # the dispatcher was fenced out during the write
    assert conn.execute("SELECT claim_lock FROM tasks").fetchone()[0] is None


def test_a_failing_agent_liveness_helper_keeps_the_claim(agent_kanban) -> None:
    """An error from the Agent's own helper is unknown liveness: a claimed running task stays live."""

    def undecided(claim):
        raise RuntimeError("liveness unknown")

    agent_kanban._claim_is_live = undecided
    assert kanban._row_claim_live(Row(RUNNING)) is True
    assert kanban._row_claim_live(Row({**RUNNING, "claim_lock": None})) is False
    assert kanban._row_claim_live(Row({**RUNNING, "status": "todo"})) is False
