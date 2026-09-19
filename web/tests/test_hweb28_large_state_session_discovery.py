"""Regression coverage for bounded session discovery on a large state.db."""

import sqlite3
import time

from api import agent_sessions


def _large_state_db(path, *, history_rows=25_000):
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            session_source TEXT,
            title TEXT,
            model TEXT,
            started_at REAL NOT NULL,
            message_count INTEGER DEFAULT 0,
            parent_session_id TEXT,
            ended_at REAL,
            end_reason TEXT
        );
        CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT,
            role TEXT,
            content TEXT,
            timestamp REAL
        );
        CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
        """
    )
    rows = []
    for index in range(320):
        sid = f"session-{index:04d}"
        count = history_rows if index == 319 else 2
        source = ("cli", "cron", "webhook", "kanban")[index % 4]
        rows.append((sid, source, source, sid, "model", float(index), count, None, None, None))
    conn.executemany(
        "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    conn.executemany(
        "INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, '', ?)",
        (("session-0319", "user" if index % 2 == 0 else "assistant", 319.0 + index / history_rows)
         for index in range(history_rows)),
    )
    conn.executemany(
        "INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, 'user', '', ?)",
        ((f"session-{index:04d}", float(index)) for index in range(319)),
    )
    conn.executemany(
        "INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, 'assistant', '', ?)",
        ((f"session-{index:04d}", float(index) + 0.5) for index in range(319)),
    )
    conn.commit()
    conn.close()


def _count_sqlite_steps(monkeypatch):
    real_connect = sqlite3.connect
    steps = {"count": 0}

    def connect(*args, **kwargs):
        conn = real_connect(*args, **kwargs)

        def progress():
            steps["count"] += 1
            return 0

        conn.set_progress_handler(progress, 100)
        return conn

    monkeypatch.setattr(agent_sessions.sqlite3, "connect", connect)
    return steps


def test_large_history_listing_and_lineage_use_bounded_message_work(tmp_path, monkeypatch):
    db = tmp_path / "state.db"
    _large_state_db(db)
    steps = _count_sqlite_steps(monkeypatch)

    writer = sqlite3.connect(db)
    writer.execute("BEGIN IMMEDIATE")
    writer.execute(
        "INSERT INTO messages(session_id, role, content, timestamp) VALUES ('session-0318', 'assistant', '', 400)"
    )
    try:
        started = time.perf_counter()
        listed = agent_sessions.read_importable_agent_session_rows(
            db,
            limit=20,
            exclude_sources=None,
            include_sources=("kanban",),
        )
        listing_seconds = time.perf_counter() - started
        listing_steps = steps["count"]
        started = time.perf_counter()
        lineage = agent_sessions.read_session_lineage_metadata(db, {"session-0319"})
        lineage_seconds = time.perf_counter() - started
        lineage_steps = steps["count"] - listing_steps
    finally:
        writer.rollback()
        writer.close()

    assert listed[0]["id"] == "session-0319"
    assert len(listed) == 20
    assert {row["source"] for row in listed} == {"kanban"}
    assert listed[0]["actual_message_count"] == 25_000
    assert lineage["session-0319"]["_state_db_source"] == "kanban"
    assert listing_steps < 2_500
    assert lineage_steps < 1_000
    assert listing_seconds < 1.0
    assert lineage_seconds < 1.0
