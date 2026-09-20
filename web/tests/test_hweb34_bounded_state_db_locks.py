"""Regression tests for HWEB-34 — bound state.db lock waits on request threads.

``open_state_db_readonly`` used sqlite's default 5-second busy timeout, so any
request touching the agent-owned ``state.db`` could park a worker for seconds
while the agent CLI held a lock. Three ``api/routes.py`` read handlers also
opened plain write-capable connections on that multi-GB WAL database.

These pin both halves: every WebUI open of the agent DB is bounded and degrades
instead of blocking, and the read handlers hold no write-capable handle. The one
genuine writer (``_persist_handoff_summary_to_state_db``, which INSERTs a tool
message) keeps its writable connection but gets the same bound.
"""
import inspect
import sqlite3
import time
from contextlib import closing, contextmanager

import pytest

import api.agent_sessions as agent_sessions
import api.models as models
import api.routes as routes
from api.agent_sessions import (
    STATE_DB_CONNECT_TIMEOUT_S,
    STATE_DB_RECOVERY_BUSY_TIMEOUT_MS,
    open_state_db_readonly,
    read_importable_agent_session_rows,
    resolve_live_compression_tip,
)

# The bound is 50 ms; the pre-fix default was 5 s. Anything under a second
# proves the wait is bounded without making the test flaky on a loaded machine.
LOCK_BUDGET_S = 1.0


def _make_state_db(path):
    conn = sqlite3.connect(str(path))
    conn.execute(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, parent_session_id TEXT, end_reason TEXT,
            source TEXT, session_source TEXT, title TEXT, model TEXT,
            message_count INTEGER, started_at REAL, ended_at REAL,
            archived INTEGER
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
            timestamp REAL, tool_calls TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO sessions (id, source, session_source, title, model, "
        "message_count, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?)",
        ("sess-1", "cli", "cli", "Root", "sonnet", 2, 1000.0, 1100.0),
    )
    conn.executemany(
        "INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls) "
        "VALUES (?,?,?,?,?,?)",
        [
            (1, "sess-1", "user", "hi", 1000.0, None),
            (2, "sess-1", "assistant", "hello", 1001.0, None),
        ],
    )
    conn.commit()
    conn.close()


@contextmanager
def _write_locked(db):
    """Hold the same exclusive write lock the agent CLI takes while streaming."""
    holder = sqlite3.connect(str(db), timeout=0)
    holder.execute("BEGIN EXCLUSIVE")
    try:
        yield
    finally:
        holder.rollback()
        holder.close()


@contextmanager
def _write_locked_briefly(db, hold_s=0.75):
    """Hold the lock longer than the request budget but well under the recovery
    one. Only a caller that waits out contention sees the real rows."""
    import threading

    released = threading.Event()
    ready = threading.Event()

    def hold():
        conn = sqlite3.connect(str(db), timeout=0)
        conn.execute("BEGIN EXCLUSIVE")
        ready.set()
        released.wait(hold_s)
        conn.rollback()
        conn.close()

    t = threading.Thread(target=hold, daemon=True)
    t.start()
    ready.wait(5)
    try:
        yield
    finally:
        released.set()
        t.join(timeout=10)


def _elapsed(fn):
    t0 = time.monotonic()
    try:
        fn()
    except sqlite3.OperationalError:
        pass  # bounded failure is the intended degradation
    return time.monotonic() - t0


# ── the wait is bounded ──────────────────────────────────────────────────────

def test_opener_bounds_the_lock_wait(tmp_path):
    db = tmp_path / "state.db"
    _make_state_db(db)

    with _write_locked(db):
        def read():
            with closing(open_state_db_readonly(db)) as conn:
                conn.execute("SELECT 1 FROM sessions").fetchone()

        elapsed = _elapsed(read)

    assert elapsed < LOCK_BUDGET_S, (
        f"locked state.db read took {elapsed:.2f}s; the busy timeout is unbounded"
    )


def test_session_listing_read_is_bounded(tmp_path):
    """The /api/sessions listing projection is the hot path the bound protects."""
    db = tmp_path / "state.db"
    _make_state_db(db)

    with _write_locked(db):
        elapsed = _elapsed(lambda: read_importable_agent_session_rows(db))

    assert elapsed < LOCK_BUDGET_S, (
        f"/api/sessions listing read took {elapsed:.2f}s on a locked state.db"
    )


def test_sidebar_enrichment_degrades_instead_of_blocking(tmp_path):
    """A caller that depended on a successful read still returns its empty
    value — quickly — when the bounded opener gives up."""
    db = tmp_path / "state.db"
    _make_state_db(db)

    # Sanity: it really does read this DB when nothing holds a lock.
    assert models._read_state_db_sidebar_overrides(db, {"sess-1"})

    with _write_locked(db):
        t0 = time.monotonic()
        overrides = models._read_state_db_sidebar_overrides(db, {"sess-1"})
        elapsed = time.monotonic() - t0

    assert overrides == {}
    assert elapsed < LOCK_BUDGET_S


def test_bounded_read_still_returns_correct_data_unlocked(tmp_path):
    """The bound must not change the result of an uncontended read."""
    db = tmp_path / "state.db"
    _make_state_db(db)

    with closing(open_state_db_readonly(db)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == (
            agent_sessions.STATE_DB_BUSY_TIMEOUT_MS
        )

    rows = read_importable_agent_session_rows(db)
    assert [row["id"] for row in rows] == ["sess-1"]


def test_opener_does_not_leak_a_handle_when_the_bound_cannot_be_applied(tmp_path):
    """If the busy_timeout pragma fails, the connection is closed, not leaked."""
    db = tmp_path / "state.db"
    _make_state_db(db)
    closed = []

    class PragmaHostileConnection(sqlite3.Connection):
        def execute(self, *args, **kwargs):
            raise sqlite3.OperationalError("synthetic pragma failure")

        def close(self):
            closed.append(True)
            super().close()

    real_connect = sqlite3.connect
    monkeypatch_target = agent_sessions.sqlite3

    def spy(*args, **kwargs):
        return real_connect(*args, factory=PragmaHostileConnection, **kwargs)

    orig = monkeypatch_target.connect
    monkeypatch_target.connect = spy
    try:
        with pytest.raises(sqlite3.OperationalError):
            open_state_db_readonly(db)
    finally:
        monkeypatch_target.connect = orig

    assert closed, "opener leaked the connection when the pragma failed"


# ── no request read handler holds a write-capable handle ─────────────────────

READ_HANDLERS = (
    routes._latest_cron_session_info_for_jobs,  # cron chip enrichment
    routes._handle_insights,                    # analytics rollup
    routes._deep_health_checks,                 # /api/health?deep=1 probe
)


@pytest.mark.parametrize("handler", READ_HANDLERS, ids=lambda f: f.__name__)
def test_read_handler_opens_state_db_read_only(handler):
    src = inspect.getsource(handler)
    assert "open_state_db_readonly" in src, (
        f"{handler.__name__} must read state.db through the read-only opener"
    )
    assert "sqlite3.connect(str(db_path))" not in src, (
        f"{handler.__name__} must not open a write-capable handle on state.db"
    )


def test_handoff_marker_writer_keeps_a_bounded_writable_connection():
    """The lone request-thread writer really does INSERT, so it must stay
    writable — but it must not park the worker on a locked DB either."""
    src = inspect.getsource(routes._persist_handoff_summary_to_state_db)
    assert "INSERT INTO messages" in src
    assert "open_state_db_readonly" not in src, (
        "a read-only downgrade would make the handoff marker silently no-op"
    )
    assert "STATE_DB_CONNECT_TIMEOUT_S" in src, (
        "the writer must bound its lock wait like every other request-thread open"
    )


def test_handoff_marker_write_is_bounded(tmp_path, monkeypatch):
    db = tmp_path / "state.db"
    _make_state_db(db)
    import api.profiles as profiles

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: str(tmp_path))
    monkeypatch.setattr(
        routes, "_extract_handoff_summary_payload", lambda _m: None, raising=False
    )

    def persist():
        return routes._persist_handoff_summary_to_state_db(
            "sess-1", {"content": "summary", "timestamp": 1200.0}
        )

    assert persist() is True
    with closing(sqlite3.connect(str(db))) as check:  # wrote to the tmp DB, not a real one
        assert check.execute(
            "SELECT COUNT(*) FROM messages WHERE role = 'tool'"
        ).fetchone()[0] == 1

    with _write_locked(db):
        t0 = time.monotonic()
        assert persist() is False  # degrades; the caller falls back to local persistence
        elapsed = time.monotonic() - t0

    assert elapsed < LOCK_BUDGET_S


def test_connect_timeout_matches_the_declared_bound():
    assert STATE_DB_CONNECT_TIMEOUT_S == pytest.approx(
        agent_sessions.STATE_DB_BUSY_TIMEOUT_MS / 1000.0
    )


# ── the bound must NOT reach off-request reads that would fail closed wrong ──

def test_compression_tip_recovery_keeps_the_generous_wait(tmp_path):
    """A locked DB must not make the streaming worker resolve a compressed
    session to its CLOSED ancestor — a cold agent built on that id has every
    durable append rejected. This read waits instead of taking the budget."""
    db = tmp_path / "state.db"
    _make_state_db(db)
    with closing(sqlite3.connect(str(db))) as conn:
        conn.execute(
            "INSERT INTO sessions (id, parent_session_id, source, session_source, "
            "title, model, message_count, started_at, ended_at, end_reason) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("live-tip", "sess-1", "cli", "cli", "Cont", "sonnet", 1, 1200.0, None, None),
        )
        conn.execute(
            "UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?",
            (1100.0, "compression", "sess-1"),
        )
        conn.commit()

    assert resolve_live_compression_tip(db, "sess-1") == "live-tip"

    seen = {}
    real_open = agent_sessions.open_state_db_readonly

    def spy(path, log=None, **kwargs):
        seen.update(kwargs)
        return real_open(path, log, **kwargs)

    orig = agent_sessions.open_state_db_readonly
    agent_sessions.open_state_db_readonly = spy
    try:
        assert resolve_live_compression_tip(db, "sess-1") == "live-tip"
    finally:
        agent_sessions.open_state_db_readonly = orig

    assert seen.get("busy_timeout_ms") == STATE_DB_RECOVERY_BUSY_TIMEOUT_MS
    assert STATE_DB_RECOVERY_BUSY_TIMEOUT_MS > agent_sessions.STATE_DB_BUSY_TIMEOUT_MS


def test_opener_honors_an_explicit_busy_timeout(tmp_path):
    db = tmp_path / "state.db"
    _make_state_db(db)
    with closing(open_state_db_readonly(db, busy_timeout_ms=1234)) as conn:
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 1234


def test_session_delete_cleanup_manifest_read_is_bounded(tmp_path):
    """The DELETE /api/session path first runs a fail-closed liveness read;
    it must not add a second multi-second park on a locked DB."""
    db = tmp_path / "state.db"
    _make_state_db(db)
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    manifest = sessions_dir / ".cleanup_manifest_deadbeef.json"
    manifest.write_text('["sess-1"]', encoding="utf-8")

    # Unlocked, the liveness query proves sess-1 is still alive, so the stale
    # manifest is consumed — proof the test reaches the read, not an early return.
    assert models._process_stale_cleanup_manifests(tmp_path) is True
    assert not manifest.exists()

    manifest.write_text('["sess-1"]', encoding="utf-8")
    with _write_locked(db):
        t0 = time.monotonic()
        complete = models._process_stale_cleanup_manifests(tmp_path)
        elapsed = time.monotonic() - t0

    assert complete is False, "a locked DB must fail closed, not claim success"
    assert manifest.exists(), "fail-closed must preserve the manifest for a retry"
    assert elapsed < LOCK_BUDGET_S, (
        f"stale-cleanup liveness read took {elapsed:.2f}s on a locked state.db"
    )


def test_recovery_audit_does_not_report_clean_on_a_locked_db(tmp_path):
    """`[]` from the sidecar scan means "nothing missing", and the audit turns
    that into status="ok". A lock must not masquerade as a clean database."""
    import api.session_recovery as session_recovery

    db = tmp_path / "state.db"
    _make_state_db(db)
    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    # A WebUI-origin row with no JSON sidecar on disk: a real missing sidecar.
    with closing(sqlite3.connect(str(db))) as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, session_source, title, model, "
            "message_count, started_at) VALUES (?,?,?,?,?,?,?)",
            ("webui-orphan", "webui", "webui", "Orphan", "sonnet", 1, 1300.0),
        )
        conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) "
            "VALUES (?,?,?,?)",
            ("webui-orphan", "user", "hi", 1300.0),
        )
        conn.commit()

    found = session_recovery._read_state_db_missing_sidecar_rows(session_dir, db)
    assert [r["id"] for r in found] == ["webui-orphan"], (
        "fixture must produce a genuinely missing sidecar, or the lock case proves nothing"
    )

    with _write_locked_briefly(db):
        locked = session_recovery._read_state_db_missing_sidecar_rows(session_dir, db)

    assert [r["id"] for r in locked] == ["webui-orphan"], (
        "a locked state.db reported an empty scan — the audit would call this clean"
    )


def test_streaming_context_read_waits_out_contention(tmp_path, monkeypatch):
    """The streaming worker's model-context read must not degrade to an empty
    snapshot on a lock — that sends stale history to the model."""
    db = tmp_path / "state.db"
    _make_state_db(db)
    monkeypatch.setattr(models, "_active_state_db_path", lambda: db)

    assert models.get_state_db_session_messages("sess-1", authoritative=True)

    with _write_locked_briefly(db):
        msgs = models.get_state_db_session_messages("sess-1", authoritative=True)
    assert msgs, "authoritative context read returned an empty snapshot on a lock"

    # A request-thread read of the same data still degrades fast.
    with _write_locked_briefly(db):
        t0 = time.monotonic()
        assert models.get_state_db_session_messages("sess-1") == []
        assert time.monotonic() - t0 < LOCK_BUDGET_S


def test_streaming_worker_asks_for_the_authoritative_context_read():
    src = inspect.getsource(routes) if False else None
    import api.streaming as streaming

    src = inspect.getsource(streaming._run_agent_streaming)
    assert src.count("authoritative=True") == 2, (
        "both streaming context reads must opt into the authoritative budget"
    )
