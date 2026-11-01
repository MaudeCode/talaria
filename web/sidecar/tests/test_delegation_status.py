"""TAL-1579: a WebUI session's delegation summary separates running work from finished work still awaiting delivery."""

from __future__ import annotations

import json
import os
import pathlib
import sqlite3
import sys
import types
from contextlib import closing

import pytest

from talaria_sidecar.methods import process

LIVE = ("running", "stalling", "finalizing")
TERMINAL = ("completed", "error", "interrupted", "cancelled", "stalled", "unknown")


def _ledger(home: pathlib.Path, rows: list[tuple[str, str, str, str]]) -> pathlib.Path:
    """A disposable ledger with the Agent's columns: ``(delegation_id, origin_ui_session_id, state, delivery_state)``."""
    home.mkdir(parents=True, exist_ok=True)
    db = home / "state.db"
    with closing(sqlite3.connect(db)) as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS async_delegations (
            delegation_id TEXT PRIMARY KEY, origin_ui_session_id TEXT, state TEXT, dispatched_at REAL, completed_at REAL,
            updated_at REAL, task_json TEXT, result_json TEXT, event_json TEXT, delivery_state TEXT)""")
        conn.executemany(
            "INSERT OR REPLACE INTO async_delegations VALUES (?, ?, ?, 100, 200, 200, ?, ?, ?, ?)",
            [(did, sid, state, json.dumps({"goal": f"secret goal {did}"}), json.dumps({"status": "completed", "summary": f"secret result {did}"}),
              json.dumps({"type": "async_delegation", "delegation_id": did}), delivery) for did, sid, state, delivery in rows])
        conn.commit()
    return db


def _set_delivery(db: pathlib.Path, delegation_id: str, delivery: str) -> None:
    with closing(sqlite3.connect(db)) as conn:
        conn.execute("UPDATE async_delegations SET delivery_state = ? WHERE delegation_id = ?", (delivery, delegation_id))
        conn.commit()


@pytest.fixture(autouse=True)
def _no_agent_registries(monkeypatch):
    monkeypatch.setattr(process, "_live_delegations", lambda: {})
    monkeypatch.setattr(process, "_live_children", lambda: [])
    monkeypatch.setattr(process, "_owned_processes", lambda _: [])


def _live_registry(monkeypatch, answer):
    """The Agent's in-process registry probe, answering ``answer`` (or raising it)."""
    module = types.ModuleType("tools.async_delegation")

    def has_live_for_session(**kwargs):
        if isinstance(answer, BaseException):
            raise answer
        return answer(kwargs) if callable(answer) else answer

    module.has_live_for_session = has_live_for_session
    tools = sys.modules.get("tools") or types.ModuleType("tools")
    monkeypatch.setitem(sys.modules, "tools", tools)
    monkeypatch.setitem(sys.modules, "tools.async_delegation", module)
    monkeypatch.setattr(tools, "async_delegation", module, raising=False)


def test_pending_and_delivered_completions_differ_while_the_task_state_is_identical(tmp_path) -> None:
    db = _ledger(tmp_path, [("deleg_done", "web-a", "completed", "pending")])
    listed_pending = process.background_list(tmp_path, ["web-a"])
    pending = process.delegation_status(tmp_path, "web-a")
    _set_delivery(db, "deleg_done", "delivered")
    assert process.background_list(tmp_path, ["web-a"]) == listed_pending
    delivered = process.delegation_status(tmp_path, "web-a")
    assert pending["awaiting_delivery_count"] == 1
    assert delivered["awaiting_delivery_count"] == 0
    assert pending != delivered


@pytest.mark.parametrize("state", LIVE)
def test_every_live_state_counts_as_running_and_never_as_awaiting(tmp_path, state) -> None:
    _ledger(tmp_path, [("d", "web-a", state, "pending")])
    assert process.delegation_status(tmp_path, "web-a") | {"memory_live": None} == {"ledger": "available", "running_count": 1, "awaiting_delivery_count": 0, "memory_live": None}


@pytest.mark.parametrize("state", TERMINAL)
@pytest.mark.parametrize("delivery,awaiting", [("pending", 1), ("delivered", 0), ("dropped", 0)])
def test_every_terminal_state_awaits_delivery_only_while_pending(tmp_path, state, delivery, awaiting) -> None:
    _ledger(tmp_path, [("d", "web-a", state, delivery)])
    status = process.delegation_status(tmp_path, "web-a")
    assert (status["running_count"], status["awaiting_delivery_count"]) == (0, awaiting)


def test_counts_span_every_row_above_the_listed_row_cap(tmp_path) -> None:
    rows = [(f"run-{i}", "web-a", "running", "pending") for i in range(150)] + [(f"done-{i}", "web-a", "completed", "pending") for i in range(160)]
    _ledger(tmp_path, rows)
    assert len(process.background_list(tmp_path, ["web-a"])["delegations"]) == process._LEDGER_LIMIT
    status = process.delegation_status(tmp_path, "web-a")
    assert (status["running_count"], status["awaiting_delivery_count"]) == (150, 160)


def test_profiles_and_sessions_stay_isolated_and_carry_counts_only(tmp_path) -> None:
    work, other = tmp_path / "work", tmp_path / "other"
    _ledger(work, [("a1", "web-a", "running", "pending"), ("a2", "web-a", "error", "pending"), ("b1", "web-b", "completed", "pending")])
    _ledger(other, [("x1", "web-a", "running", "pending"), ("x2", "web-a", "completed", "pending"), ("x3", "web-a", "stalled", "pending")])
    work_a = process.delegation_status(work, "web-a")
    assert (work_a["running_count"], work_a["awaiting_delivery_count"]) == (1, 1)
    assert (process.delegation_status(work, "web-b")["awaiting_delivery_count"], process.delegation_status(work, "web-c")["running_count"]) == (1, 0)
    other_a = process.delegation_status(other, "web-a")
    assert (other_a["running_count"], other_a["awaiting_delivery_count"]) == (1, 2)
    assert set(work_a) == {"ledger", "running_count", "awaiting_delivery_count", "memory_live"}
    assert "secret" not in json.dumps(work_a)


# Each decoy is the file an unencoded ``file:`` URI of the profile path would open instead.
@pytest.mark.parametrize("name,decoy", [("100%25 done", "100% done"), ("a#b", "a"), ("plain?mode=rw", "plain")])
def test_the_exact_profile_db_is_read_even_with_uri_characters_in_its_path(tmp_path, name, decoy) -> None:
    home = tmp_path / name
    _ledger(home, [("d", "web-a", "completed", "pending")])
    _ledger(tmp_path / decoy, [("decoy", "web-a", "running", "pending")])
    status = process.delegation_status(home, "web-a")
    assert (status["ledger"], status["running_count"], status["awaiting_delivery_count"]) == ("available", 0, 1)


def test_a_missing_db_is_a_truthful_zero_and_is_never_created(tmp_path) -> None:
    status = process.delegation_status(tmp_path, "web-a")
    assert (status["ledger"], status["running_count"], status["awaiting_delivery_count"]) == ("available", 0, 0)
    assert not (tmp_path / "state.db").exists()


def test_unreadable_ledgers_are_unknown_never_zero(tmp_path) -> None:
    corrupt = tmp_path / "corrupt"
    corrupt.mkdir()
    (corrupt / "state.db").write_bytes(b"not a sqlite database" * 64)
    no_table = tmp_path / "no-table"
    no_table.mkdir()
    with closing(sqlite3.connect(no_table / "state.db")) as conn:
        conn.execute("CREATE TABLE sessions (id TEXT)")
    old_columns = tmp_path / "old"
    old_columns.mkdir()
    with closing(sqlite3.connect(old_columns / "state.db")) as conn:
        conn.execute("CREATE TABLE async_delegations (delegation_id TEXT, origin_ui_session_id TEXT, state TEXT)")
    for home in (corrupt, no_table, old_columns):
        assert process.delegation_status(home, "web-a") | {"memory_live": None} == {"ledger": "unknown", "running_count": None, "awaiting_delivery_count": None, "memory_live": None}


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads unreadable files")
def test_a_permission_denied_ledger_or_profile_is_unknown(tmp_path) -> None:
    home = tmp_path / "profile"
    _ledger(home, [("d", "web-a", "running", "pending")])
    for path in (home / "state.db", home):
        path.chmod(0)
        try:
            assert process.delegation_status(home, "web-a")["ledger"] == "unknown", path
        finally:
            path.chmod(0o700)


def test_the_live_registry_is_probed_independently_of_the_ledger(tmp_path, monkeypatch) -> None:
    asked = []
    _live_registry(monkeypatch, lambda kwargs: asked.append(kwargs) or True)
    status = process.delegation_status(tmp_path, "web-a")
    assert status == {"ledger": "available", "running_count": 0, "awaiting_delivery_count": 0, "memory_live": True}
    assert asked == [{"origin_ui_session_id": "web-a"}]
    _live_registry(monkeypatch, RuntimeError("registry unavailable"))
    assert process.delegation_status(tmp_path, "web-a")["memory_live"] is None
    _live_registry(monkeypatch, False)
    assert process.delegation_status(tmp_path, "web-a")["memory_live"] is False


def test_reading_the_summary_changes_no_ledger_row_or_environment(tmp_path) -> None:
    db = _ledger(tmp_path, [("d1", "web-a", "completed", "pending"), ("d2", "web-a", "running", "pending")])
    with closing(sqlite3.connect(db)) as conn:
        before = conn.execute("SELECT * FROM async_delegations ORDER BY delegation_id").fetchall()
    env = dict(os.environ)
    files = sorted(p.name for p in tmp_path.iterdir())
    process.delegation_status(tmp_path, "web-a")
    with closing(sqlite3.connect(db)) as conn:
        assert conn.execute("SELECT * FROM async_delegations ORDER BY delegation_id").fetchall() == before
    assert dict(os.environ) == env
    assert sorted(p.name for p in tmp_path.iterdir()) == files
