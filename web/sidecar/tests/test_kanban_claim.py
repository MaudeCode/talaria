"""Claim liveness on an Agent without ``kanban_db._claim_is_live`` (Agent 0.21.3), against stand-in Agent modules."""

from __future__ import annotations

import contextlib
import sqlite3
import sys
import types

import pytest

from talaria_sidecar.methods import kanban

RUNNING = {"status": "running", "claim_lock": "claim", "worker_pid": 4242, "worker_started_at": None}


class Row(dict):
    def keys(self):  # sqlite3.Row exposes its columns through keys()
        return list(super().keys())


@pytest.fixture
def older_agent(monkeypatch):
    """An Agent kanban module without ``_claim_is_live``, plus a dispatcher whose PID check the test controls."""
    package = types.ModuleType("hermes_cli")
    package.__path__ = []
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.kanban_db", types.ModuleType("hermes_cli.kanban_db"))
    dispatch = types.ModuleType("hermes_cli.kanban_db_dispatch")
    monkeypatch.setitem(sys.modules, "hermes_cli.kanban_db_dispatch", dispatch)
    return dispatch


def test_a_dead_worker_releases_its_claim(older_agent) -> None:
    checked = []
    older_agent._pid_alive = lambda pid: checked.append(pid) or False
    assert kanban._row_claim_live(Row(RUNNING)) is False
    assert checked == [4242]


def test_a_live_worker_keeps_its_claim(older_agent) -> None:
    older_agent._pid_alive = lambda pid: True
    assert kanban._row_claim_live(Row(RUNNING)) is True


def test_unknown_liveness_counts_as_live(older_agent) -> None:
    assert kanban._row_claim_live(Row(RUNNING)) is True  # no _pid_alive either

    def broken(pid):
        raise OSError("ps unavailable")

    older_agent._pid_alive = broken
    assert kanban._row_claim_live(Row(RUNNING)) is True


def test_an_unclaimed_or_idle_task_is_never_live(older_agent) -> None:
    older_agent._pid_alive = lambda pid: True
    assert kanban._row_claim_live(Row({**RUNNING, "claim_lock": None})) is False
    assert kanban._row_claim_live(Row({**RUNNING, "worker_pid": None})) is False
    assert kanban._row_claim_live(Row({**RUNNING, "status": "todo"})) is False


def _fence_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE tasks (id TEXT, status TEXT, claim_lock TEXT, worker_pid INTEGER, worker_started_at INTEGER)")
    conn.execute("INSERT INTO tasks VALUES ('t1', 'ready', NULL, NULL, NULL)")
    return conn


@pytest.mark.parametrize("outcome", ["refused", "raised"])
def test_a_failed_agent_write_releases_the_dispatcher_fence(older_agent, monkeypatch, outcome) -> None:
    conn = _fence_db()
    kb = sys.modules["hermes_cli.kanban_db"]
    kb.write_txn = lambda c: contextlib.nullcontext()
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
