"""HWEB-103: session loads must not scale with the full transcript.

Covers the four server-side pieces:

1. ``messages=0`` never reconciles or hashes the transcript.
2. ``messages=1&msg_limit=N`` merges only the sidecar tail once the prefix
   proof passes, and falls back to the full merge when it does not.
3. The regeneration revision is a function of the row count, the tail rows
   and the session markers, not of every row.
4. The display-merge cache hits on a repeated identical GET and misses after
   state.db grows.
"""

from __future__ import annotations

import io
import json
import sqlite3
from collections import OrderedDict
from urllib.parse import urlparse

import pytest

from api import models, routes, session_ops
from api.models import Session


SID = "hweb103tailsession"
T0 = 1_700_000_000.0


@pytest.fixture(autouse=True)
def _clear_module_caches():
    """Leave no per-session cache state behind for later tests in the shard."""
    yield
    with routes._display_merge_cache_lock:
        routes._display_merge_cache.clear()
    with routes._lineage_display_cache_lock:
        routes._lineage_display_cache.clear()
    with routes._prefix_proof_cache_lock:
        routes._prefix_proof_cache.clear()
    try:
        models.clear_sidecar_metadata_cache()
    except Exception:
        pass
    try:
        routes._clear_session_list_cache()
    except Exception:
        pass


def _rows(count):
    rows = []
    ts = T0
    for index in range(count):
        role = ("user", "assistant", "tool")[index % 3]
        # Repeated contents exercise the visible-duplicate accounting.
        content = f"repeat {index % 7}" if index % 5 == 0 else f"row {index}"
        ts += 1.0
        row = {"role": role, "content": content, "timestamp": ts}
        if role == "tool":
            row.update({"tool_call_id": f"call{index}", "tool_name": "terminal", "name": "terminal"})
        rows.append(row)
    return rows


def _install(tmp_path, monkeypatch, rows):
    import api.config as config

    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    index_file = session_dir / "_index.json"
    for module in (models, config, routes):
        monkeypatch.setattr(module, "SESSION_DIR", session_dir, raising=False)
        monkeypatch.setattr(module, "SESSION_INDEX_FILE", index_file, raising=False)
    monkeypatch.setattr(models, "SESSIONS", OrderedDict(), raising=False)
    db_path = tmp_path / "state.db"
    monkeypatch.setattr(models, "_active_state_db_path", lambda: db_path)

    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT,
            content TEXT,
            tool_call_id TEXT,
            tool_calls TEXT,
            tool_name TEXT,
            timestamp REAL,
            active INTEGER DEFAULT 1
        )
        """
    )
    sidecar = []
    for row in rows:
        cur = conn.execute(
            "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, active) "
            "VALUES (?, ?, ?, ?, NULL, ?, ?, 1)",
            (SID, row["role"], row["content"], row.get("tool_call_id"), row.get("tool_name"), row["timestamp"]),
        )
        sidecar.append({**row, "id": cur.lastrowid, "_row_id": cur.lastrowid, "_db_persisted": True})
    conn.commit()
    conn.close()

    Session(session_id=SID, title="tail", messages=sidecar).save()
    routes._display_merge_cache.clear()
    routes._lineage_display_cache.clear()
    return db_path


class _Handler:
    headers = {}
    client_address = ("127.0.0.1", 1)
    command = "GET"
    server = None

    def __init__(self, path):
        self.path = path
        self.wfile = io.BytesIO()
        self.rfile = io.BytesIO()

    def send_response(self, *args, **kwargs):
        pass

    def send_header(self, *args, **kwargs):
        pass

    def end_headers(self):
        pass

    def log_message(self, *args):
        pass

    def _safe_webui_print(self, *args, **kwargs):
        pass


def _get(path):
    handler = _Handler(path)
    routes._handle_session_get(handler, urlparse(path))
    return json.loads(handler.wfile.getvalue())


META = f"/api/session?session_id={SID}&messages=0&resolve_model=0"
WINDOW = f"/api/session?session_id={SID}&messages=1&resolve_model=0&msg_limit=30&expand_renderable=1"


@pytest.fixture
def merge_calls(monkeypatch):
    calls = []
    original = models.merge_session_messages_append_only

    def recording(sidecar_messages, state_messages, **kwargs):
        calls.append((len(list(sidecar_messages or [])), len(list(state_messages or []))))
        return original(sidecar_messages, state_messages, **kwargs)

    monkeypatch.setattr(models, "merge_session_messages_append_only", recording)
    monkeypatch.setattr(routes, "merge_session_messages_append_only", recording)
    return calls


def test_metadata_load_never_touches_the_transcript(tmp_path, monkeypatch, merge_calls):
    _install(tmp_path, monkeypatch, _rows(2000))
    counters = {"regeneration_state": 0, "state_rows": 0}

    def _count(name, original):
        def wrapper(*args, **kwargs):
            counters[name] += 1
            return original(*args, **kwargs)
        return wrapper

    monkeypatch.setattr(session_ops, "regeneration_state", _count("regeneration_state", session_ops.regeneration_state))
    reader = models.get_state_db_session_messages
    monkeypatch.setattr(models, "get_state_db_session_messages", _count("state_rows", reader))
    monkeypatch.setattr(routes, "get_state_db_session_messages", _count("state_rows", reader))

    body = _get(META)

    assert body["session"]["message_count"] == 2000
    assert "regeneration_revision" not in body["session"]
    assert counters == {"regeneration_state": 0, "state_rows": 0}
    assert merge_calls == []


def test_limited_load_merges_only_the_sidecar_tail(tmp_path, monkeypatch, merge_calls):
    _install(tmp_path, monkeypatch, _rows(2000))

    body = _get(WINDOW)

    assert body["session"]["message_count"] == 2000
    assert body["session"]["_messages_truncated"] is True
    assert body["session"]["messages"]
    # raw_budget (300) state rows against at most anchor (300) + tail (300) sidecar rows.
    assert len(merge_calls) == 1
    sidecar_len, state_len = merge_calls[0]
    assert state_len == 300
    assert sidecar_len <= routes._DISPLAY_TAIL_MERGE_ANCHOR_ROWS + 300

    # The bounded merge is exactly the full merge.
    session = models.get_session(SID)
    sidecar = routes._webui_sidecar_lineage_messages_for_display(session)
    floor, _ = routes._state_db_since_timestamp_for_limited_display(session, 30)
    assert floor is not None
    state_tail = models.get_state_db_session_messages(SID, since_timestamp=floor)
    state_all = models.get_state_db_session_messages(SID)
    bounded = routes._limited_webui_messages_for_display_with_sidecar(
        session, sidecar, state_tail, tail_floor=floor, state_db_signature=None
    )
    original = merge_calls.copy()
    full_tail = models.merge_session_messages_append_only(list(sidecar), state_tail)
    full_all = models.merge_session_messages_append_only(list(sidecar), state_all)
    assert bounded == full_tail == full_all
    assert len(bounded) == 2000
    assert merge_calls[len(original):] == [(2000, 300), (2000, 2000)]


def test_limited_load_falls_back_when_any_prefix_row_differs(tmp_path, monkeypatch, merge_calls):
    db_path = _install(tmp_path, monkeypatch, _rows(2000))
    # A same-count rewrite deep in the prefix (row 10 of 2000, far from the
    # tail floor) must still be detected: the whole skipped prefix is proven.
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE messages SET content = 'rewritten' WHERE id = 10")
    conn.commit()
    conn.close()

    body = _get(WINDOW)

    # Full merge over every row, exactly as before this change; the rewritten
    # row no longer matches its sidecar mirror, so append-only reconciliation
    # surfaces it as an extra row rather than silently keeping the stale one.
    assert merge_calls == [(2000, 2000)]
    assert body["session"]["message_count"] == 2001


def test_prefix_proof_is_memoized_on_both_revisions(tmp_path, monkeypatch, merge_calls):
    db_path = _install(tmp_path, monkeypatch, _rows(2000))
    calls = []
    original = models.get_state_db_session_message_keys_before_timestamp

    def counting(*args, **kwargs):
        calls.append(args[1])
        return original(*args, **kwargs)

    monkeypatch.setattr(routes, "get_state_db_session_message_keys_before_timestamp", counting)

    _get(WINDOW)
    _get(WINDOW)
    assert len(calls) == 1, "an unchanged sidecar + state.db must reuse the prefix proof"

    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE messages SET content = 'rewritten' WHERE id = 10")
    conn.commit()
    conn.close()
    routes._display_merge_cache.clear()

    _get(WINDOW)
    assert len(calls) == 2, "a state.db write must invalidate the memoized proof"
    assert merge_calls[-1] == (2000, 2000)


def test_state_only_tail_row_forces_the_full_merge(tmp_path, monkeypatch, merge_calls):
    db_path = _install(tmp_path, monkeypatch, _rows(2000))
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'user', 'only in state.db', ?, 1)",
        (SID, T0 + 2001.0),
    )
    conn.commit()
    conn.close()

    body = _get(WINDOW)

    assert merge_calls == [(2000, 301)]
    assert body["session"]["message_count"] == 2001
    assert body["session"]["messages"][-1]["content"] == "only in state.db"


def test_display_merge_cache_hits_until_state_db_grows(tmp_path, monkeypatch, merge_calls):
    db_path = _install(tmp_path, monkeypatch, _rows(2000))

    first = _get(WINDOW)
    second = _get(WINDOW)
    assert first["session"]["messages"] == second["session"]["messages"]
    assert len(merge_calls) == 1, "second identical GET must be served from the display-merge cache"

    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'user', 'appended later', ?, 1)",
        (SID, T0 + 2001.0),
    )
    conn.commit()
    conn.close()

    third = _get(WINDOW)
    assert len(merge_calls) == 2
    assert third["session"]["messages"][-1]["content"] == "appended later"


def test_both_load_responses_carry_the_same_load_revision(tmp_path, monkeypatch):
    db_path = _install(tmp_path, monkeypatch, _rows(400))

    meta = _get(META)["session"]
    window = _get(WINDOW)["session"]
    assert meta["_load_revision"] and meta["_load_revision"] == window["_load_revision"]

    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE messages SET content = 'rewritten in place' WHERE id = 5")
    conn.commit()
    conn.close()
    assert _get(META)["session"]["_load_revision"] != meta["_load_revision"]


def test_prefix_proof_memo_sees_a_rewrite_the_session_signature_misses(tmp_path, monkeypatch):
    """A prefix rewrite invalidates the memo even when the session signature is frozen."""
    db_path = _install(tmp_path, monkeypatch, _rows(2000))
    monkeypatch.setattr(routes, "_state_db_session_signature", lambda sid, profile=None: ("frozen",))
    calls = []
    original = models.get_state_db_session_message_keys_before_timestamp

    def counting(*args, **kwargs):
        calls.append(args[1])
        return original(*args, **kwargs)

    monkeypatch.setattr(routes, "get_state_db_session_message_keys_before_timestamp", counting)

    _get(WINDOW)
    _get(WINDOW)
    assert len(calls) == 1

    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE messages SET content = content || ' (edited)' WHERE id = 10")
    conn.commit()
    conn.close()
    routes._display_merge_cache.clear()

    _get(WINDOW)
    assert len(calls) == 2, "the prefix aggregate must invalidate the memo on a deep rewrite"


def test_load_revision_is_a_one_off_token_when_a_write_lands_mid_request(tmp_path, monkeypatch):
    db_path = _install(tmp_path, monkeypatch, _rows(400))
    session = models.get_session(SID)
    stable = routes._session_load_revision(session)
    assert stable

    reader = routes.get_state_db_session_messages

    def write_during_read(*args, **kwargs):
        rows = reader(*args, **kwargs)
        conn = sqlite3.connect(db_path)
        conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'user', 'landed mid-read', ?, 1)",
            (SID, T0 + 401.0),
        )
        conn.commit()
        conn.close()
        return rows

    monkeypatch.setattr(routes, "get_state_db_session_messages", write_during_read)
    window = _get(WINDOW)["session"]
    assert window["_load_revision"].startswith("unstable-")
    assert window["_load_revision"] != routes._session_load_revision(models.get_session(SID))
    assert window["_load_revision"] != stable


def test_load_revision_covers_lineage_parents(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch, _rows(400))
    parent_id = "hweb103parent"
    Session(session_id=parent_id, title="parent", messages=_rows(4), pre_compression_snapshot=True).save()
    child = models.get_session(SID)
    child.parent_session_id = parent_id
    child.save()
    child = models.get_session(SID)

    before = routes._session_load_revision(child)
    assert before
    parent = Session.load(parent_id)
    parent.title = "parent repaired"
    parent.save()
    assert routes._session_load_revision(child) != before


def test_load_revision_is_stable_when_state_db_is_absent(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch, _rows(40))
    monkeypatch.setattr(models, "_active_state_db_path", lambda: tmp_path / "missing-state.db")
    meta = _get(META)["session"]
    window = _get(WINDOW)["session"]
    assert meta["_load_revision"] == window["_load_revision"]
    assert not meta["_load_revision"].startswith("unstable-")


def test_cache_weight_counts_ascii_strings_at_their_real_size():
    rows = [{"role": "user", "content": "x" * 10_000}]
    weight = routes._display_merge_messages_weight(rows, limit=10**9)
    assert weight < 12_000, "a 10 KB ASCII string must not be weighed as 40 KB"


def test_regeneration_revision_is_bounded_to_the_tail(monkeypatch):
    session = Session(session_id=SID, title="rev", messages=[])
    rows = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}", "timestamp": T0 + i} for i in range(1000)]
    seen_tail_sizes = []
    real_dumps = session_ops.json.dumps

    def spy(payload, **kwargs):
        if isinstance(payload, dict) and "messages_tail" in payload:
            seen_tail_sizes.append(len(payload["messages_tail"]))
        return real_dumps(payload, **kwargs)

    monkeypatch.setattr(session_ops.json, "dumps", spy)

    base = session_ops.regeneration_revision_for(rows, session=session, context=rows)
    assert seen_tail_sizes == [session_ops._REGENERATION_REVISION_TAIL_ROWS]
    assert base == session_ops.regeneration_revision_for(rows, session=session, context=[])
    appended = rows + [{"role": "user", "content": "new", "timestamp": T0 + 1000}]
    assert session_ops.regeneration_revision_for(appended, session=session) != base
    tail_edit = [dict(r) for r in rows]
    tail_edit[-1]["content"] = "edited"
    assert session_ops.regeneration_revision_for(tail_edit, session=session) != base
    # Documented ceiling: an edit deeper than the tail window is invisible.
    deep_edit = [dict(r) for r in rows]
    deep_edit[0]["content"] = "edited"
    assert session_ops.regeneration_revision_for(deep_edit, session=session) == base
    session.compression_anchor_message_key = {"ts": T0 + 10, "role": "user"}
    assert session_ops.regeneration_revision_for(rows, session=session) != base
