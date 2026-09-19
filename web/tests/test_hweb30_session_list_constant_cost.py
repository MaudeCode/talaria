"""HWEB-30: a cached /api/sessions response must cost ~constant CPU.

Holding the built payload only saved the *build*. Every cache hit still paid a
deepcopy of the payload, an O(N) reshape, one JSON serialize, and two global
lock acquisitions per session row — hundreds of milliseconds of pure Python per
sidebar poll on a large store, competing with the streaming worker for the GIL.
"""
import copy
import io
import json
import threading
from urllib.parse import urlparse

import api.profiles as profiles
import api.routes as routes
import pytest


SESSION_COUNT = 2000


@pytest.fixture(autouse=True)
def _clear_caches():
    routes._session_list_cache_clear()
    routes._SESSION_LIST_RESPONSE_CACHE.clear()
    yield
    routes._session_list_cache_clear()
    routes._SESSION_LIST_RESPONSE_CACHE.clear()


class _FakeHandler:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass

    def json_body(self):
        return json.loads(self.wfile.getvalue().decode("utf-8"))


class _CountingLock:
    """Stand-in for the global approvals lock that records every acquisition."""

    def __init__(self):
        self._lock = threading.Lock()
        self.acquires = 0

    def __enter__(self):
        self.acquires += 1
        return self._lock.__enter__()

    def __exit__(self, *exc):
        return self._lock.__exit__(*exc)


def _synthetic_rows(count=SESSION_COUNT):
    return [
        {
            "session_id": f"s{i:05d}",
            "title": f"Session {i}",
            "profile": "default",
            "archived": False,
            "message_count": 2,
            "created_at": 1000 + i,
            "updated_at": 1000 + i,
            "last_message_at": 1000 + i,
        }
        for i in range(count)
    ]


def _install_store(monkeypatch, rows):
    monkeypatch.setattr(routes, "all_sessions", lambda **_kwargs: [dict(r) for r in rows])
    monkeypatch.setattr(routes, "_enrich_sidebar_lineage_metadata", lambda _rows: None)
    monkeypatch.setattr(routes, "_reconcile_stale_stream_state_for_session_rows", lambda _rows: False)
    monkeypatch.setattr(routes, "load_settings", lambda: {"show_cli_sessions": False})
    monkeypatch.setattr(profiles, "get_active_profile_name", lambda: "default")


def _get_sessions():
    handler = _FakeHandler()
    routes.handle_get(handler, urlparse("http://example.com/api/sessions"))
    assert handler.status == 200
    return handler


def test_cached_sessions_response_is_constant_cost(monkeypatch):
    """A second /api/sessions over an unchanged store does no deepcopy, no
    reshape, and takes the approvals lock O(1) times rather than once per row."""
    _install_store(monkeypatch, _synthetic_rows())

    first = _get_sessions()
    assert len(first.json_body()["sessions"]) == SESSION_COUNT

    counting_lock = _CountingLock()
    monkeypatch.setattr(routes, "_lock", counting_lock)

    deepcopies = {"n": 0}
    real_deepcopy = copy.deepcopy

    def _counting_deepcopy(obj, *a, **k):
        deepcopies["n"] += 1
        return real_deepcopy(obj, *a, **k)

    monkeypatch.setattr(copy, "deepcopy", _counting_deepcopy)

    reshapes = {"n": 0}
    real_reshape = routes._session_list_payload_to_response

    def _counting_reshape(*a, **k):
        reshapes["n"] += 1
        return real_reshape(*a, **k)

    monkeypatch.setattr(routes, "_session_list_payload_to_response", _counting_reshape)

    second = _get_sessions()

    assert deepcopies["n"] == 0, f"cache hit deep-copied {deepcopies['n']}x"
    assert reshapes["n"] == 0, "cache hit re-shaped and re-serialized the payload"
    assert counting_lock.acquires <= 4, (
        f"approvals lock acquired {counting_lock.acquires}x for {SESSION_COUNT} rows; "
        "expected O(1), not one acquisition per session row"
    )

    # Identical rows, and a fresh per-response server clock.
    assert second.json_body()["sessions"] == first.json_body()["sessions"]
    assert second.json_body()["server_time"] >= first.json_body()["server_time"]


def test_attention_lock_cost_does_not_grow_with_session_count(monkeypatch):
    """The per-row attention lookup is gone: 10x the rows, same lock traffic."""
    counts = {}
    for size in (20, 200):
        routes._session_list_cache_clear()
        routes._SESSION_LIST_RESPONSE_CACHE.clear()
        with monkeypatch.context() as m:
            _install_store(m, _synthetic_rows(size))
            counting_lock = _CountingLock()
            m.setattr(routes, "_lock", counting_lock)
            _get_sessions()
            counts[size] = counting_lock.acquires
    assert counts[200] == counts[20], f"attention lock traffic scaled with rows: {counts}"


def test_pending_attention_still_surfaces_on_the_snapshot_path(monkeypatch):
    """Hoisting the keyspace must not drop a session that really has attention."""
    rows = _synthetic_rows(5)
    _install_store(monkeypatch, rows)
    monkeypatch.setattr(
        routes, "approvals_pending_session_keys", lambda: {"s00002"}
    )
    monkeypatch.setattr(routes, "clarify_pending_session_keys", lambda: set())
    monkeypatch.setattr(
        routes,
        "_session_attention_summary",
        lambda sid: {"kind": "approval", "count": 1, "severity": "critical"},
    )

    body = _get_sessions().json_body()
    attention = {row["session_id"]: row["attention"] for row in body["sessions"]}
    assert attention["s00002"] == {"kind": "approval", "count": 1, "severity": "critical"}
    assert all(v is None for k, v in attention.items() if k != "s00002")


def test_unreadable_attention_keyspace_falls_back_to_per_row_lookup(monkeypatch):
    """An unreadable keyspace must not be reported as 'no attention anywhere'."""
    rows = _synthetic_rows(3)
    _install_store(monkeypatch, rows)

    def _boom():
        raise RuntimeError("approvals store unavailable")

    monkeypatch.setattr(routes, "approvals_pending_session_keys", _boom)
    monkeypatch.setattr(
        routes,
        "_session_attention_summary",
        lambda sid: {"kind": "clarify", "count": 1, "severity": "question"},
    )

    body = _get_sessions().json_body()
    assert all(row["attention"]["kind"] == "clarify" for row in body["sessions"])


def test_source_stamp_is_computed_once_per_request_on_the_stale_path(monkeypatch):
    """The stale branch used to compute the stamp twice: once for the payload and
    again for the staleness reason. It is a SQLite connect, two queries and five
    stat() calls, so it must run exactly once per request."""
    _install_store(monkeypatch, _synthetic_rows(5))
    _get_sessions()

    # Age the entry out of its TTL so the next request takes the stale branch.
    monkeypatch.setattr(routes, "_SESSIONS_CACHE_TTL_SECONDS", 0.0)
    monkeypatch.setattr(
        routes._route_session_list_cache, "_SESSIONS_CACHE_TTL_SECONDS", 0.0
    )

    # Count only the request thread: the stale branch also kicks off a
    # background rebuild, whose own stamping is not the cost under test.
    stamps = {"n": 0}
    request_thread = threading.current_thread()
    real_stamp = routes._route_session_list_cache._session_list_cache_source_stamp

    def _counting_stamp(key):
        if threading.current_thread() is request_thread:
            stamps["n"] += 1
        return real_stamp(key)

    monkeypatch.setattr(routes, "_session_list_cache_source_stamp", _counting_stamp)

    handler = _FakeHandler()
    routes.handle_get(handler, urlparse("http://example.com/api/sessions"))
    assert handler.status == 200

    assert stamps["n"] == 1, (
        f"source stamp computed {stamps['n']}x on the request thread; the stale "
        "path must resolve the payload and its staleness reason from one read"
    )


def test_response_bytes_cache_reflects_a_new_live_stream(monkeypatch):
    """Cached bytes must not outlive the runtime overlay they were built from."""
    _install_store(monkeypatch, _synthetic_rows(4))
    monkeypatch.setattr(
        routes._route_session_list_cache, "_session_list_cache_active_stream_ids", lambda: set()
    )
    routes.SESSIONS["s00001"] = type(
        "LiveSession",
        (),
        {"active_stream_id": "stream-1", "pending_user_message": None,
         "pending_started_at": 0, "updated_at": 0, "last_message_at": 0},
    )()
    try:
        body = _get_sessions().json_body()
        assert all(row["is_streaming"] is False for row in body["sessions"])

        monkeypatch.setattr(
            routes._route_session_list_cache,
            "_session_list_cache_active_stream_ids",
            lambda: {"stream-1"},
        )
        body = _get_sessions().json_body()
        streaming = [row["session_id"] for row in body["sessions"] if row["is_streaming"]]
        assert streaming == ["s00001"]
    finally:
        routes.SESSIONS.pop("s00001", None)
