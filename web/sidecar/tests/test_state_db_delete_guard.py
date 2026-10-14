"""TAL-792: ``state_db.delete_cli_session`` refuses a session another Agent process is writing — a live turn lease or
compression lock on the session or a delegate child that would go with it — like the Agent's own user delete
(``delete_session(exclude_active_write_guards=True)``). Expired guards are reclaimed and the delete proceeds. Real
sidecar, pinned Agent."""

from __future__ import annotations

import sqlite3
import subprocess
import textwrap
from contextlib import closing

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, assert_matches, isolated_env, requires_agent

# An Agent without the guard (before v0.21.6) keeps the unguarded delete.
pytestmark = [requires_agent, pytest.mark.skipif(
    AGENT_DIR is None or "def _guarded_ids" not in (AGENT_DIR / "hermes_state_maintenance.py").read_text(), reason="Agent without the user-delete write guard")]

# An unstructured holder is never probed as a pid, so it stays live until its TTL (another process's turn).
OTHER_PROCESS = "other-terminal-turn"


def _agent(home, body: str) -> None:
    script = "from pathlib import Path\nfrom hermes_state import SessionDB\n" + f"db = SessionDB(db_path=Path({str(home / 'state.db')!r}))\n" + textwrap.dedent(body) + "\ndb.close()\n"
    subprocess.run([AGENT_PYTHON, "-c", script], env=isolated_env(home, PYTHONPATH=str(AGENT_DIR)), check=True, timeout=60)


def _seed(home, session_id: str, *, delegate: str | None = None) -> None:
    _agent(home, f"""
        db.create_session(session_id={session_id!r}, source="cli")
        db.append_message({session_id!r}, "user", "hi")
        if {delegate!r}:
            db.create_session(session_id={delegate!r}, source="subagent", parent_session_id={session_id!r}, model_config={{"_delegate_from": {session_id!r}}})
    """)


def _rows(home, sql: str) -> list:
    with closing(sqlite3.connect(home / "state.db")) as db:
        return [row[0] for row in db.execute(sql).fetchall()]


def _delete(proc: SidecarProcess, home, session_id: str, *, lineage: bool = False) -> dict:
    params = {"profile_home": str(home), "session_id": session_id, **({"include_compression_lineage": True} if lineage else {})}
    result = proc.result("state_db.delete_cli_session", params)
    assert_matches("state_db.delete_cli_session", result)
    return result


def test_a_live_turn_lease_or_compression_lock_refuses_the_delete(hermes_home) -> None:
    _seed(hermes_home, "cli-a")
    _seed(hermes_home, "cli-b")
    _seed(hermes_home, "cli-c", delegate="cli-c-child")
    _agent(hermes_home, f"""
        assert db.try_acquire_session_turn_lease("cli-a", {OTHER_PROCESS!r})
        assert db.try_acquire_compression_lock("cli-b", {OTHER_PROCESS!r})
        assert db.try_acquire_session_turn_lease("cli-c-child", {OTHER_PROCESS!r})
    """)
    proc = SidecarProcess(hermes_home)
    try:
        for sid in ("cli-a", "cli-b", "cli-c"):
            assert _delete(proc, hermes_home, sid) == {"ok": False, "refused": "active_turn"}, sid
    finally:
        proc.close()
    # Nothing was removed: the rows, their transcripts, and the guards the live writer holds all remain.
    assert sorted(_rows(hermes_home, "SELECT id FROM sessions")) == ["cli-a", "cli-b", "cli-c", "cli-c-child"]
    assert sorted(_rows(hermes_home, "SELECT DISTINCT session_id FROM messages")) == ["cli-a", "cli-b", "cli-c"]
    assert sorted(_rows(hermes_home, "SELECT conversation_id FROM session_turn_leases")) == ["cli-a", "cli-c-child"]
    assert _rows(hermes_home, "SELECT session_id FROM compression_locks") == ["cli-b"]


def test_an_expired_guard_is_reclaimed_and_the_delete_proceeds(hermes_home) -> None:
    _seed(hermes_home, "cli-a", delegate="cli-a-child")
    _seed(hermes_home, "cli-b")
    _agent(hermes_home, f"""
        assert db.try_acquire_session_turn_lease("cli-a", {OTHER_PROCESS!r})
        assert db.try_acquire_compression_lock("cli-b", {OTHER_PROCESS!r})
    """)
    with closing(sqlite3.connect(hermes_home / "state.db")) as db, db:
        db.execute("UPDATE session_turn_leases SET expires_at = 1")
        db.execute("UPDATE compression_locks SET expires_at = 1")
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-a") == {"ok": True}
        assert _delete(proc, hermes_home, "cli-b") == {"ok": True}
    finally:
        proc.close()
    # An unguarded delete keeps its lineage cleanup: the delegate child goes with its parent.
    assert _rows(hermes_home, "SELECT id FROM sessions") == []
    assert _rows(hermes_home, "SELECT conversation_id FROM session_turn_leases") == []
    assert _rows(hermes_home, "SELECT session_id FROM compression_locks") == []


def test_the_lineage_is_resolved_and_guarded_inside_the_delete_transaction(hermes_home) -> None:
    """The sidecar finds the compression continuations itself, in the delete transaction: a tip the caller never
    named (a compression that finished after the caller looked) is guarded and deleted with its root."""
    _seed(hermes_home, "cli-root")
    _agent(hermes_home, f"""
        db.end_session("cli-root", "compression")
        db.create_session(session_id="cli-tip", source="cli", parent_session_id="cli-root")
        db.append_message("cli-tip", "user", "continued")
        assert db.try_acquire_compression_lock("cli-tip", {OTHER_PROCESS!r})
    """)
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-root", lineage=True) == {"ok": False, "refused": "active_turn"}
        assert sorted(_rows(hermes_home, "SELECT id FROM sessions")) == ["cli-root", "cli-tip"]
        with closing(sqlite3.connect(hermes_home / "state.db")) as db, db:
            db.execute("UPDATE compression_locks SET expires_at = 1")
        assert _delete(proc, hermes_home, "cli-root", lineage=True) == {"ok": True}
    finally:
        proc.close()
    assert _rows(hermes_home, "SELECT id FROM sessions") == []
