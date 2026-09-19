"""HWEB-41 — the gateway watcher's 5s tick must be O(1) and must not hide failures.

The previous change check (#3506) hashed every sidebar-visible ``sessions`` row
and then ran a ``COUNT``/``MAX(timestamp)`` join across the whole ``messages``
table, every five seconds, per profile, on an otherwise idle server. A separate
parity pass forced the expensive projection once a minute regardless of whether
anything had changed. The poll loop also swallowed every exception at debug
level, so a schema or permission failure stopped the sidebar updating with
nothing above debug in the log.

These tests pin the three acceptance criteria:

  1. per-tick query count and cost do not grow with session or message count
  2. a raising poll body logs at warning level and the loop keeps running
  3. a newly appearing agent session is still observed on the next tick
"""
from __future__ import annotations

import importlib
import logging
import sqlite3
import threading
import time
from pathlib import Path


def _make_db(tmp_path: Path, *, sessions: int, messages_per_session: int) -> tuple[Path, sqlite3.Connection]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    db = tmp_path / "state.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            session_source TEXT,
            model TEXT,
            started_at REAL NOT NULL,
            ended_at REAL,
            end_reason TEXT,
            parent_session_id TEXT,
            message_count INTEGER DEFAULT 0,
            title TEXT,
            archived INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            timestamp REAL NOT NULL
        );
        CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
        -- Both indexes the projection self-heals on first run, so the projection
        -- does not itself write to (and thus re-fingerprint) the test DB.
        CREATE INDEX idx_messages_session_user ON messages(session_id) WHERE role = 'user';
        """
    )
    started = time.time()
    for s in range(sessions):
        _add_session(conn, f"tg{s}", mc=messages_per_session, started=started + s, commit=False)
    conn.commit()
    return db, conn


def _add_session(conn, sid, *, source="telegram", mc=2, started=None, title="Chat", commit=True):
    started = started if started is not None else time.time()
    conn.execute(
        "INSERT OR REPLACE INTO sessions (id, source, model, started_at, message_count, title) "
        "VALUES (?, ?, 'm', ?, ?, ?)",
        (sid, source, started, mc, title),
    )
    conn.executemany(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', 'x', ?)",
        [(sid, started + i) for i in range(mc)],
    )
    if commit:
        conn.commit()


def _measure_tick(gw, db, monkeypatch) -> tuple[list[str], int]:
    """Return (statements executed, SQLite VM steps) for one fingerprint call."""
    statements: list[str] = []
    steps = 0
    real_open = gw.open_state_db_readonly

    def counting_open(path, *args, **kwargs):
        nonlocal steps

        conn = real_open(path, *args, **kwargs)
        conn.set_trace_callback(statements.append)

        def bump():
            nonlocal steps
            steps += 1
            return 0

        conn.set_progress_handler(bump, 1)
        return conn

    monkeypatch.setattr(gw, "open_state_db_readonly", counting_open)
    try:
        assert gw._cheap_change_fingerprint(db) is not None
    finally:
        monkeypatch.setattr(gw, "open_state_db_readonly", real_open)
    return statements, steps


# ── AC 1: constant per-tick cost ────────────────────────────────────────────

def test_tick_cost_does_not_grow_with_session_or_message_count(tmp_path, monkeypatch):
    gw = importlib.import_module("api.gateway_watcher")

    small_db, small_conn = _make_db(tmp_path / "small", sessions=2, messages_per_session=3)
    big_db, big_conn = _make_db(tmp_path / "big", sessions=400, messages_per_session=25)
    try:
        assert big_conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 10_000
        small_statements, small_steps = _measure_tick(gw, small_db, monkeypatch)
        big_statements, big_steps = _measure_tick(gw, big_db, monkeypatch)
    finally:
        small_conn.close()
        big_conn.close()

    # Same statements, and only the two O(1) rowid lookups — no scan, no join.
    assert small_statements == big_statements
    assert len(big_statements) == 2, big_statements
    for statement in big_statements:
        assert "MAX(rowid)" in statement
        assert "JOIN" not in statement.upper()
        assert "COUNT(" not in statement.upper()

    # A 5000x larger store must not cost measurably more VM steps.
    assert big_steps <= small_steps + 25, (small_steps, big_steps)


def test_rowid_lookups_do_not_scan_the_tables(tmp_path):
    """``MAX(rowid)`` must resolve as a bounded index lookup, not a table scan."""
    db, conn = _make_db(tmp_path, sessions=3, messages_per_session=4)
    try:
        for table in ("sessions", "messages"):
            plan = conn.execute(f"EXPLAIN QUERY PLAN SELECT MAX(rowid) FROM {table}").fetchall()
            detail = " ".join(str(row[3]) for row in plan)
            assert "SCAN" not in detail.upper(), (table, detail)
    finally:
        conn.close()


# ── AC 2: a failing poll is visible and the loop survives ───────────────────

def test_failing_poll_logs_a_rate_limited_warning_and_keeps_running(tmp_path, caplog):
    gw = importlib.import_module("api.gateway_watcher")
    watcher = gw.GatewayWatcher(state_db_path=tmp_path / "state.db")
    watcher.POLL_INTERVAL = 0  # no inter-tick sleep; the loop is stopped explicitly

    calls = threading.Semaphore(0)
    attempts = 0

    def always_fails(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        calls.release()
        raise sqlite3.OperationalError("no such column: source")

    watcher._poll_once = always_fails

    with caplog.at_level(logging.DEBUG, logger=gw.logger.name):
        thread = threading.Thread(target=watcher._poll_loop, daemon=True)
        thread.start()
        try:
            for _ in range(3):
                assert calls.acquire(timeout=5), "poll loop stopped after a failure"
        finally:
            watcher._stop_event.set()
            thread.join(timeout=5)
        assert not thread.is_alive()

    assert attempts >= 3, "the loop must keep polling after an exception"
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1, [r.getMessage() for r in warnings]
    assert warnings[0].exc_info, "the warning must carry the traceback"
    assert "no such column" in caplog.text
    # Everything after the first is rate limited down to debug, not dropped.
    assert sum(r.levelno == logging.DEBUG for r in caplog.records) >= attempts - 1


def test_swallowed_projection_failure_is_surfaced_at_warning(tmp_path, caplog, monkeypatch):
    """The silent-death mode the ticket names: ``_get_agent_sessions_from_db``
    catches every projection exception and returns None, so nothing propagates
    out of ``_poll_once``. That failure must still reach the log at warning,
    with its traceback, and the watcher must keep its last good snapshot."""
    gw = importlib.import_module("api.gateway_watcher")
    db, conn = _make_db(tmp_path, sessions=1, messages_per_session=2)
    try:
        watcher = gw.GatewayWatcher(state_db_path=db)
        subscriber = watcher.subscribe()
        assert watcher._poll_once(now=1.0) is True
        good = subscriber.get_nowait()["sessions"]

        monkeypatch.setattr(
            gw,
            "read_importable_agent_session_rows",
            lambda *a, **kw: (_ for _ in ()).throw(
                sqlite3.OperationalError("no such column: source")
            ),
        )
        _add_session(conn, "tg-new", mc=1)

        with caplog.at_level(logging.DEBUG, logger=gw.logger.name):
            assert watcher._poll_once(now=2.0) is False

        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1, [r.getMessage() for r in warnings]
        assert "session projection failed" in warnings[0].getMessage()
        assert warnings[0].exc_info, "the warning must carry the traceback"
        assert "no such column" in caplog.text
        assert watcher._last_sessions == good, "last good snapshot must survive"
        assert subscriber.empty()
    finally:
        conn.close()


def test_warning_repeats_once_the_rate_limit_window_elapses(tmp_path, monkeypatch):
    gw = importlib.import_module("api.gateway_watcher")
    watcher = gw.GatewayWatcher(state_db_path=tmp_path / "state.db")
    watcher.POLL_INTERVAL = 0

    clock = [0.0]
    monkeypatch.setattr(gw.time, "monotonic", lambda: clock[0])
    warned: list[str] = []
    monkeypatch.setattr(
        gw.logger, "warning", lambda msg, *a, **kw: warned.append(msg)
    )

    ticks = 0

    def fail_then_stop(*args, **kwargs):
        nonlocal ticks
        ticks += 1
        # Stop first, so a missing ERROR_LOG_INTERVAL fails the test instead of
        # spinning the loop forever.
        if ticks >= 5:
            watcher._stop_event.set()
        clock[0] += watcher.ERROR_LOG_INTERVAL / 2.0
        raise RuntimeError("boom")

    watcher._poll_once = fail_then_stop
    watcher._poll_loop()

    # Five failures spanning 2.5 windows: warn at 0, then once per elapsed window.
    assert len(warned) == 3, warned


def test_parity_projection_backstops_a_fingerprint_that_cannot_move(tmp_path, monkeypatch):
    """A commit the file stamps cannot see (WAL restart at an unchanged size on a
    coarse-mtime filesystem) must still surface, bounded by the parity interval
    rather than waiting for an unrelated write."""
    gw = importlib.import_module("api.gateway_watcher")
    db, conn = _make_db(tmp_path, sessions=1, messages_per_session=2)
    try:
        watcher = gw.GatewayWatcher(state_db_path=db)
        subscriber = watcher.subscribe()
        assert watcher._poll_once(now=1.0) is True
        assert [s["session_id"] for s in subscriber.get_nowait()["sessions"]] == ["tg0"]

        # Freeze the fingerprint: the change is real but completely invisible to it.
        monkeypatch.setattr(gw, "_cheap_change_fingerprint", lambda *a, **kw: "frozen")
        assert watcher._poll_once(now=2.0) is True  # first tick stores "frozen"
        # A visibility mutation: retagging the source drops the row from the
        # sidebar projection, which is a change subscribers actually observe
        # (``_snapshot_hash`` tracks membership/updated_at/message_count).
        conn.execute("UPDATE sessions SET source = 'cron' WHERE id = 'tg0'")
        conn.commit()

        before = 2.0 + watcher.PROJECTION_PARITY_INTERVAL - 1.0
        assert watcher._poll_once(now=before) is False, "the hot path must stay off"

        at_deadline = 2.0 + watcher.PROJECTION_PARITY_INTERVAL
        assert watcher._poll_once(now=at_deadline) is True
        assert subscriber.get_nowait()["sessions"] == []
    finally:
        conn.close()


# ── AC 3: a new session is still seen on the next tick ──────────────────────

def test_new_agent_session_is_observed_on_the_next_tick(tmp_path):
    gw = importlib.import_module("api.gateway_watcher")
    db, conn = _make_db(tmp_path, sessions=1, messages_per_session=2)
    try:
        watcher = gw.GatewayWatcher(state_db_path=db)
        assert watcher.POLL_INTERVAL <= 5, "latency budget is one 5s tick"
        subscriber = watcher.subscribe()

        assert watcher._poll_once(now=1.0) is True
        assert [s["session_id"] for s in subscriber.get_nowait()["sessions"]] == ["tg0"]

        # Idle ticks stay silent and never force the projection.
        assert watcher._poll_once(now=1.0 + watcher.POLL_INTERVAL) is False
        assert subscriber.empty()

        _add_session(conn, "tg-new", source="telegram", mc=1)

        # One tick later — no 60s parity wait — the new session is published.
        assert watcher._poll_once(now=1.0 + 2 * watcher.POLL_INTERVAL) is True
        published = {s["session_id"] for s in subscriber.get_nowait()["sessions"]}
        assert published == {"tg0", "tg-new"}
    finally:
        conn.close()
