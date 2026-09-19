"""Regression coverage for bounded full-session resolution."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest


def _install_lightweight_resolve_stubs(monkeypatch, models) -> None:
    """Keep the tests focused on full sidecar materialization."""
    monkeypatch.setattr(
        models,
        "_sync_sidecar_from_state_db_if_newer",
        lambda _session, **_kwargs: False,
    )
    monkeypatch.setattr(models, "_repair_stale_pending", lambda _session: False)
    monkeypatch.setattr(models, "_session_has_pending_journal_retry", lambda _session: False)


def _empty_session(models, sid: str):
    return models.Session(session_id=sid, messages=[])


@pytest.fixture(autouse=True)
def _clear_session_cache():
    import api.models as models

    with models.LOCK:
        models.SESSIONS.clear()
    yield
    with models.LOCK:
        models.SESSIONS.clear()


def test_same_session_cold_load_is_single_flight(monkeypatch):
    import api.models as models

    _install_lightweight_resolve_stubs(monkeypatch, models)
    workers = 4
    start = threading.Barrier(workers)
    state_lock = threading.Lock()
    calls = 0
    active = 0
    peak = 0

    def fake_load(cls, sid):
        nonlocal calls, active, peak
        with state_lock:
            calls += 1
            active += 1
            peak = max(peak, active)
        time.sleep(0.08)
        with state_lock:
            active -= 1
        return _empty_session(models, sid)

    monkeypatch.setattr(models.Session, "load", classmethod(fake_load))

    def resolve():
        start.wait(timeout=2)
        return models.get_session("same-session")

    with ThreadPoolExecutor(max_workers=workers) as executor:
        results = [future.result(timeout=3) for future in [executor.submit(resolve) for _ in range(workers)]]

    assert calls == 1
    assert peak == 1
    assert {result.session_id for result in results} == {"same-session"}


def test_stale_cached_session_is_single_flight(monkeypatch):
    import api.models as models

    _install_lightweight_resolve_stubs(monkeypatch, models)
    stale = _empty_session(models, "stale-session")
    with models.LOCK:
        models.SESSIONS[stale.session_id] = stale
    monkeypatch.setattr(
        models,
        "_cached_session_lags_disk",
        lambda session, **_kwargs: session is stale,
    )
    monkeypatch.setattr(models, "_inactive_cache_tail_needs_disk_check", lambda _session: False)

    workers = 4
    start = threading.Barrier(workers)
    state_lock = threading.Lock()
    calls = 0
    active = 0
    peak = 0

    def fake_load(cls, sid):
        nonlocal calls, active, peak
        with state_lock:
            calls += 1
            active += 1
            peak = max(peak, active)
        time.sleep(0.08)
        with state_lock:
            active -= 1
        return _empty_session(models, sid)

    monkeypatch.setattr(models.Session, "load", classmethod(fake_load))

    def resolve():
        start.wait(timeout=2)
        return models.get_session("stale-session")

    with ThreadPoolExecutor(max_workers=workers) as executor:
        results = [
            future.result(timeout=3)
            for future in [executor.submit(resolve) for _ in range(workers)]
        ]

    assert calls == 1
    assert peak == 1
    assert all(result is results[0] for result in results)
    assert results[0] is not stale


def test_distinct_cold_loads_have_a_global_concurrency_bound(monkeypatch):
    import api.models as models

    _install_lightweight_resolve_stubs(monkeypatch, models)
    session_ids = ("session-a", "session-b", "session-c", "session-d")
    start = threading.Barrier(len(session_ids))
    state_lock = threading.Lock()
    active = 0
    peak = 0

    def fake_load(cls, sid):
        nonlocal active, peak
        with state_lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.08)
        with state_lock:
            active -= 1
        return _empty_session(models, sid)

    monkeypatch.setattr(models.Session, "load", classmethod(fake_load))

    def resolve(sid):
        start.wait(timeout=2)
        return models.get_session(sid)

    with ThreadPoolExecutor(max_workers=len(session_ids)) as executor:
        results = [
            future.result(timeout=3)
            for future in [executor.submit(resolve, sid) for sid in session_ids]
        ]

    assert peak == 2
    assert {result.session_id for result in results} == set(session_ids)


def test_cached_legacy_fallback_loads_share_global_concurrency_bound(monkeypatch):
    import api.models as models

    _install_lightweight_resolve_stubs(monkeypatch, models)
    session_ids = ("cached-a", "cached-b", "cached-c", "cached-d")
    with models.LOCK:
        for sid in session_ids:
            models.SESSIONS[sid] = _empty_session(models, sid)

    monkeypatch.setattr(
        models,
        "_persisted_session_meta_prefix",
        lambda _sid: {"anchor_scene_index": {}},
    )
    monkeypatch.setattr(
        models,
        "_inactive_cache_tail_needs_disk_check",
        lambda _session: False,
    )
    state_lock = threading.Lock()
    active = 0
    peak = 0

    def fake_load(cls, sid):
        nonlocal active, peak
        with state_lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.08)
        with state_lock:
            active -= 1
        return _empty_session(models, sid)

    def fake_persisted_count(sid, *, allow_full_load=True):
        if not allow_full_load:
            raise models._FullSessionResolveRequired
        models.Session.load(sid)
        return 0

    monkeypatch.setattr(models.Session, "load", classmethod(fake_load))
    monkeypatch.setattr(models, "_persisted_message_count", fake_persisted_count)

    with ThreadPoolExecutor(max_workers=len(session_ids)) as executor:
        results = list(executor.map(models.get_session, session_ids))

    assert peak == models._FULL_SESSION_RESOLVE_MAX_CONCURRENT
    assert {result.session_id for result in results} == set(session_ids)


def test_cached_metadata_fallback_loads_share_global_concurrency_bound(monkeypatch):
    import api.models as models

    _install_lightweight_resolve_stubs(monkeypatch, models)
    session_ids = ("meta-cache-a", "meta-cache-b", "meta-cache-c", "meta-cache-d")
    with models.LOCK:
        for sid in session_ids:
            models.SESSIONS[sid] = _empty_session(models, sid)

    monkeypatch.setattr(models, "_persisted_message_count", lambda *_a, **_k: None)
    monkeypatch.setattr(models, "_inactive_cache_tail_needs_disk_check", lambda _session: False)
    state_lock = threading.Lock()
    active = 0
    peak = 0

    def fake_full_load(cls, sid):
        nonlocal active, peak
        with state_lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.08)
        with state_lock:
            active -= 1
        return _empty_session(models, sid)

    def fake_metadata_load(cls, sid, *, allow_full_load=True, **_kwargs):
        if not allow_full_load:
            raise models._FullSessionResolveRequired
        return models.Session.load(sid)

    monkeypatch.setattr(models.Session, "load", classmethod(fake_full_load))
    monkeypatch.setattr(models.Session, "load_metadata_only", classmethod(fake_metadata_load))

    with ThreadPoolExecutor(max_workers=len(session_ids)) as executor:
        results = list(executor.map(models.get_session, session_ids))

    assert peak == models._FULL_SESSION_RESOLVE_MAX_CONCURRENT
    assert {result.session_id for result in results} == set(session_ids)


def test_cold_load_is_not_published_before_reconciliation(monkeypatch):
    import api.models as models

    monkeypatch.setattr(models, "_repair_stale_pending", lambda _session: False)
    monkeypatch.setattr(models, "_session_has_pending_journal_retry", lambda _session: False)
    monkeypatch.setattr(
        models,
        "_cached_session_lags_disk",
        lambda _session, **_kwargs: False,
    )
    monkeypatch.setattr(
        models,
        "_inactive_cache_tail_needs_disk_check",
        lambda _session: False,
    )
    reconcile_entered = threading.Event()
    release_reconcile = threading.Event()
    sync_calls = 0

    def fake_load(cls, sid):
        return _empty_session(models, sid)

    def fake_sync(session, **_kwargs):
        nonlocal sync_calls
        sync_calls += 1
        if sync_calls == 1:
            reconcile_entered.set()
            assert release_reconcile.wait(timeout=2)
            session.messages.append({"role": "assistant", "content": "recovered"})
        return False

    monkeypatch.setattr(models.Session, "load", classmethod(fake_load))
    monkeypatch.setattr(models, "_sync_sidecar_from_state_db_if_newer", fake_sync)

    with ThreadPoolExecutor(max_workers=2) as executor:
        leader = executor.submit(models.get_session, "reconcile-session")
        assert reconcile_entered.wait(timeout=2)
        waiter = executor.submit(models.get_session, "reconcile-session", True)
        time.sleep(0.05)
        assert not waiter.done()
        release_reconcile.set()
        leader_result = leader.result(timeout=2)
        waiter_result = waiter.result(timeout=2)

    assert waiter_result is leader_result
    assert waiter_result.messages == [{"role": "assistant", "content": "recovered"}]


def test_metadata_only_load_bypasses_full_resolve_slots(monkeypatch):
    import api.models as models

    _install_lightweight_resolve_stubs(monkeypatch, models)
    heavy_entered = threading.Barrier(3)
    release_heavy = threading.Event()

    def fake_load(cls, sid):
        heavy_entered.wait(timeout=2)
        assert release_heavy.wait(timeout=2)
        return _empty_session(models, sid)

    def fake_load_metadata_only(cls, sid, **_kwargs):
        return _empty_session(models, sid)

    monkeypatch.setattr(models.Session, "load", classmethod(fake_load))
    monkeypatch.setattr(models.Session, "load_metadata_only", classmethod(fake_load_metadata_only))

    with ThreadPoolExecutor(max_workers=3) as executor:
        first = executor.submit(models.get_session, "heavy-a")
        second = executor.submit(models.get_session, "heavy-b")
        heavy_entered.wait(timeout=2)
        metadata = executor.submit(models.get_session, "metadata", True)
        try:
            assert metadata.result(timeout=0.5).session_id == "metadata"
        finally:
            release_heavy.set()
        assert first.result(timeout=2).session_id == "heavy-a"
        assert second.result(timeout=2).session_id == "heavy-b"


def test_metadata_fallback_full_loads_share_global_concurrency_bound(monkeypatch):
    import api.models as models

    _install_lightweight_resolve_stubs(monkeypatch, models)
    session_ids = ("metadata-a", "metadata-b", "metadata-c", "metadata-d")
    state_lock = threading.Lock()
    active = 0
    peak = 0

    def fake_full_load(cls, sid):
        nonlocal active, peak
        with state_lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.08)
        with state_lock:
            active -= 1
        return _empty_session(models, sid)

    def fake_metadata_load(cls, sid, *, allow_full_load=True, **_kwargs):
        if not allow_full_load:
            raise models._FullSessionResolveRequired
        return models.Session.load(sid)

    monkeypatch.setattr(models.Session, "load", classmethod(fake_full_load))
    monkeypatch.setattr(models.Session, "load_metadata_only", classmethod(fake_metadata_load))

    with ThreadPoolExecutor(max_workers=len(session_ids)) as executor:
        results = list(executor.map(lambda sid: models.get_session(sid, True), session_ids))

    assert peak == models._FULL_SESSION_RESOLVE_MAX_CONCURRENT
    assert {result.session_id for result in results} == set(session_ids)


def test_cross_session_nested_resolution_does_not_deadlock(monkeypatch):
    import api.models as models

    monkeypatch.setattr(models, "_repair_stale_pending", lambda _session: False)
    monkeypatch.setattr(models, "_session_has_pending_journal_retry", lambda _session: False)
    nested_barrier = threading.Barrier(2)
    nested_local = threading.local()

    def fake_load(cls, sid):
        return _empty_session(models, sid)

    def fake_sync(session, **_kwargs):
        if getattr(nested_local, "active", False):
            return False
        nested_local.active = True
        try:
            nested_barrier.wait(timeout=2)
            other_sid = "nested-b" if session.session_id == "nested-a" else "nested-a"
            models.get_session(other_sid)
        finally:
            nested_local.active = False
        return False

    monkeypatch.setattr(models.Session, "load", classmethod(fake_load))
    monkeypatch.setattr(models, "_sync_sidecar_from_state_db_if_newer", fake_sync)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(models.get_session, "nested-a")
        second = executor.submit(models.get_session, "nested-b")
        assert first.result(timeout=3).session_id == "nested-a"
        assert second.result(timeout=3).session_id == "nested-b"


def test_fresh_cache_hit_bypasses_full_resolve_slots(monkeypatch):
    import api.models as models

    _install_lightweight_resolve_stubs(monkeypatch, models)
    cached = _empty_session(models, "cached")
    with models.LOCK:
        models.SESSIONS[cached.session_id] = cached
    monkeypatch.setattr(
        models,
        "_cached_session_lags_disk",
        lambda _session, **_kwargs: False,
    )
    monkeypatch.setattr(models, "_inactive_cache_tail_needs_disk_check", lambda _session: False)

    heavy_entered = threading.Barrier(3)
    release_heavy = threading.Event()

    def fake_load(cls, sid):
        heavy_entered.wait(timeout=2)
        assert release_heavy.wait(timeout=2)
        return _empty_session(models, sid)

    monkeypatch.setattr(models.Session, "load", classmethod(fake_load))

    with ThreadPoolExecutor(max_workers=3) as executor:
        first = executor.submit(models.get_session, "heavy-a")
        second = executor.submit(models.get_session, "heavy-b")
        heavy_entered.wait(timeout=2)
        cache_hit = executor.submit(models.get_session, "cached")
        try:
            assert cache_hit.result(timeout=0.5) is cached
        finally:
            release_heavy.set()
        first.result(timeout=2)
        second.result(timeout=2)


def test_failed_leader_releases_single_flight_state(monkeypatch):
    import api.models as models

    _install_lightweight_resolve_stubs(monkeypatch, models)
    attempts = 0

    def fake_load(cls, sid):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("simulated sidecar failure")
        return _empty_session(models, sid)

    monkeypatch.setattr(models.Session, "load", classmethod(fake_load))

    with pytest.raises(OSError, match="simulated sidecar failure"):
        models.get_session("retryable")

    recovered = models.get_session("retryable")

    assert recovered.session_id == "retryable"
    assert attempts == 2
    assert models._FULL_SESSION_RESOLVE_INFLIGHT == {}
