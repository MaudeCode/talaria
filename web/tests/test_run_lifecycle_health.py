"""Regression coverage for restart-safety run lifecycle reporting."""

import io
import time
from types import SimpleNamespace

import pytest


def test_health_counts_active_runs_even_when_no_sse_streams():
    """A worker run can outlive its SSE channel; health must expose the run."""
    from api import config, routes

    with config.STREAMS_LOCK:
        config.STREAMS.clear()
    with config.ACTIVE_RUNS_LOCK:
        config.ACTIVE_RUNS.clear()
        config.ACTIVE_RUNS["stream-1"] = {
            "stream_id": "stream-1",
            "session_id": "session-1",
            "workspace": "/private/workspace",
            "started_at": time.time() - 42,
            "phase": "running",
        }

    try:
        stream_check = routes._streams_lock_health()
        run_check = routes._run_lifecycle_health()

        assert stream_check["active_streams"] == 0
        assert run_check["active_runs"] == 1
        assert run_check["oldest_run_age_seconds"] >= 40
        run = run_check["runs"][0]
        assert "session_id" not in run
        assert "stream_id" not in run
        assert "workspace" not in run
    finally:
        with config.ACTIVE_RUNS_LOCK:
            config.ACTIVE_RUNS.clear()


def test_run_registry_unregister_records_last_finished_time():
    """Guards need a grace window after the last real worker exits."""
    from api import config

    with config.ACTIVE_RUNS_LOCK:
        config.ACTIVE_RUNS.clear()
        config.LAST_RUN_FINISHED_AT = None
    config.register_stream_owner("stream-2", "session-2")

    config.register_active_run("stream-2", session_id="session-2", phase="starting")
    with config.ACTIVE_RUNS_LOCK:
        assert "stream-2" in config.ACTIVE_RUNS
    assert config.stream_owner_session_id("stream-2") == "session-2"

    config.unregister_active_run("stream-2")

    with config.ACTIVE_RUNS_LOCK:
        assert "stream-2" not in config.ACTIVE_RUNS
        assert isinstance(config.LAST_RUN_FINISHED_AT, float)
    assert config.stream_owner_session_id("stream-2") is None


def test_health_degrades_for_blocked_admission_without_exposing_session():
    from api import config, routes

    with config.ACTIVE_RUNS_LOCK:
        config.ACTIVE_RUNS.clear()
        config.ACTIVE_RUNS["blocked-stream"] = {
            "stream_id": "blocked-stream",
            "session_id": "private-session",
            "workspace": "/private/workspace",
            "started_at": time.time() - 10,
            "phase": "waiting_for_session_lock",
            "lock_wait_started_at": time.time() - 3,
            "owner_thread_native_id": 123,
        }
    try:
        health = routes._run_lifecycle_health()
    finally:
        with config.ACTIVE_RUNS_LOCK:
            config.ACTIVE_RUNS.clear()

    assert health["status"] == "degraded"
    assert health["degraded_runs"] == 1
    assert health["runs"][0]["degraded"] is True
    assert health["runs"][0]["lock_wait_age_seconds"] >= 2
    assert "session_id" not in health["runs"][0]
    assert "workspace" not in health["runs"][0]


def test_admission_timeout_marks_only_its_owned_turn_stale():
    from api.streaming import _mark_chat_admission_timeout_stale

    owned = type("Session", (), {"active_stream_id": "owned", "pending_started_at": 123.0})()
    replaced = type("Session", (), {"active_stream_id": "newer", "pending_started_at": 456.0})()

    assert _mark_chat_admission_timeout_stale(owned, "owned") is True
    assert owned.pending_started_at is None
    assert _mark_chat_admission_timeout_stale(replaced, "old") is False
    assert replaced.pending_started_at == 456.0


def test_route_admission_lock_is_bounded_and_visible_to_health():
    import threading
    from api import config, routes

    lock = threading.Lock()
    lock.acquire()
    try:
        with routes._bounded_chat_admission_lock("private-session", lock, 0.02) as acquired:
            assert acquired is False
        health = routes._run_lifecycle_health()
        assert health["status"] == "degraded"
        assert health["recent_admission_timeout"] is True
        assert health["active_runs"] == 0
    finally:
        lock.release()
        config.LAST_CHAT_ADMISSION_TIMEOUT_AT = None
        with config.ACTIVE_RUNS_LOCK:
            config.ACTIVE_RUNS.clear()


@pytest.mark.parametrize("entrypoint", ["stream", "wakeup", "sync"])
def test_all_chat_entrypoints_timeout_on_held_session_lock(
    monkeypatch, tmp_path, entrypoint
):
    import threading
    from api import config, routes

    session = SimpleNamespace(
        session_id=f"bounded-{entrypoint}",
        pre_compression_snapshot=False,
        active_stream_id=None,
        pending_user_message=None,
        workspace=str(tmp_path),
        model="test-model",
        model_provider=None,
        title="Bounded",
        messages=[],
    )
    held = threading.Lock()
    held.acquire()
    monkeypatch.setattr(routes, "_CHAT_LOCK_WAIT_SECONDS", 0.02)
    monkeypatch.setattr(routes, "_get_session_agent_lock", lambda _sid: held)
    monkeypatch.setattr(routes, "_agent_runtime_barrier_response", lambda **_kwargs: None)
    monkeypatch.setattr(routes, "get_session", lambda _sid: session)
    monkeypatch.setattr(
        routes, "_resolve_chat_workspace_with_recovery", lambda *_args: str(tmp_path)
    )
    monkeypatch.setattr(routes, "resolve_trusted_workspace", lambda value: value)
    monkeypatch.setattr(
        routes, "_read_profile_model_config", lambda *_args: (None, None, {})
    )
    monkeypatch.setattr(
        routes,
        "_resolve_compatible_session_model_state",
        lambda *_args, **_kwargs: ("test-model", None, False),
    )
    try:
        if entrypoint == "stream":
            response = routes._start_chat_stream_for_session(
                session,
                msg="hello",
                attachments=[],
                workspace=str(tmp_path),
                model="test-model",
            )
            status = response["_status"]
        elif entrypoint == "wakeup":
            response = routes.start_session_turn(session.session_id, "hello")
            status = response["_status"]
        else:
            handler = SimpleNamespace(
                wfile=io.BytesIO(),
                send_response=lambda value: setattr(handler, "status", value),
                send_header=lambda *_args: None,
                end_headers=lambda: None,
            )
            routes._handle_chat_sync(
                handler,
                {"session_id": session.session_id, "message": "hello"},
            )
            response = __import__("json").loads(handler.wfile.getvalue())
            status = handler.status
    finally:
        held.release()
        config.LAST_CHAT_ADMISSION_TIMEOUT_AT = None
        with config.ACTIVE_RUNS_LOCK:
            config.ACTIVE_RUNS.clear()

    assert status == 409
    assert response["code"] == "chat_admission_timeout"
    assert response["retryable"] is True


def test_public_health_exposes_retained_admission_timeout(monkeypatch):
    from api import config, routes

    captured = {}
    config.note_chat_admission_timeout()
    monkeypatch.setattr(
        routes, "_streams_lock_health", lambda: {"status": "ok", "active_streams": 0}
    )
    monkeypatch.setattr(routes, "_accept_loop_health", lambda _handler: {"status": "ok"})
    monkeypatch.setattr(
        routes,
        "j",
        lambda _handler, payload, status=200: captured.update(
            payload=payload, status=status
        ),
    )
    try:
        routes._handle_health(None, SimpleNamespace(query=""))
    finally:
        config.LAST_CHAT_ADMISSION_TIMEOUT_AT = None

    assert captured["status"] == 503
    assert captured["payload"]["recent_admission_timeout"] is True
    assert "admission_timeout_age_seconds" in captured["payload"]


def test_worker_startup_lock_timeout_is_bounded_and_retained(monkeypatch):
    import threading
    from api import config, routes, streaming

    lock = threading.Lock()
    lock.acquire()
    config.register_active_run("worker-timeout", session_id="private")
    monkeypatch.setattr(streaming, "_CHAT_LOCK_WAIT_SECONDS", 0.02)
    try:
        with streaming._try_acquire_worker_session_lock(
            "worker-timeout", lock, "prestream_save"
        ) as acquired:
            assert acquired is False
        assert routes._run_lifecycle_health()["status"] == "degraded"
        assert config.LAST_CHAT_ADMISSION_TIMEOUT_AT is not None
    finally:
        lock.release()
        config.unregister_active_run("worker-timeout")
        config.LAST_CHAT_ADMISSION_TIMEOUT_AT = None


def test_checkpoint_lock_wait_is_bounded_and_stop_aware(monkeypatch):
    import threading
    from api import streaming

    lock = threading.Lock()
    lock.acquire()
    stop_event = threading.Event()
    stop_event.set()
    monkeypatch.setattr(streaming, "_CHAT_LOCK_WAIT_SECONDS", 0.02)
    started = time.monotonic()
    try:
        with streaming._try_acquire_checkpoint_session_lock(
            lock, stop_event
        ) as acquired:
            assert acquired is False
    finally:
        lock.release()

    assert time.monotonic() - started < 0.2


def test_last_resort_recovery_timeout_records_finalization(monkeypatch, tmp_path):
    import threading
    from api import config, models, streaming

    lock = threading.Lock()
    lock.acquire()
    session = SimpleNamespace(session_id="final-recovery", profile="default")
    config.LAST_CHAT_ADMISSION_TIMEOUT_AT = None
    config.LAST_CHAT_FINALIZATION_TIMEOUT_AT = None
    monkeypatch.setattr(streaming, "_CHAT_LOCK_WAIT_SECONDS", 0.02)
    monkeypatch.setattr(models, "_get_profile_home", lambda _profile: tmp_path)
    try:
        streaming._last_resort_sync_from_core(session, "final-recovery-stream", lock)
    finally:
        lock.release()

    assert config.LAST_CHAT_ADMISSION_TIMEOUT_AT is None
    assert config.LAST_CHAT_FINALIZATION_TIMEOUT_AT is not None
    config.LAST_CHAT_FINALIZATION_TIMEOUT_AT = None


def test_post_execution_writeback_timeout_is_not_retryable():
    from api.routes import _chat_writeback_timeout_response

    response = _chat_writeback_timeout_response()
    assert response["_status"] == 503
    assert response["retryable"] is False
    assert response["outcome_unknown"] is True


def test_synchronous_writeback_wait_records_finalization_not_admission(monkeypatch):
    import threading
    from api import config, routes

    lock = threading.Lock()
    lock.acquire()
    config.LAST_CHAT_ADMISSION_TIMEOUT_AT = None
    config.LAST_CHAT_FINALIZATION_TIMEOUT_AT = None
    monkeypatch.setattr(routes, "_CHAT_LOCK_WAIT_SECONDS", 0.02)
    try:
        with routes._bounded_chat_admission_lock(
            "sync-writeback", lock, finalization=True
        ) as acquired:
            assert acquired is False
    finally:
        lock.release()

    assert config.LAST_CHAT_ADMISSION_TIMEOUT_AT is None
    assert config.LAST_CHAT_FINALIZATION_TIMEOUT_AT is not None
    config.LAST_CHAT_FINALIZATION_TIMEOUT_AT = None


def test_worker_writeback_lock_timeout_emits_terminal_error(monkeypatch):
    import threading
    from api import config, routes, streaming

    lock = threading.Lock()
    lock.acquire()
    events = []
    config.LAST_CHAT_ADMISSION_TIMEOUT_AT = None
    config.LAST_CHAT_FINALIZATION_TIMEOUT_AT = None
    config.register_active_run("writeback-timeout", session_id="private")
    monkeypatch.setattr(streaming, "_CHAT_LOCK_WAIT_SECONDS", 0.02)
    try:
        with pytest.raises(streaming._WorkerWritebackTimeout):
            with streaming._bounded_worker_writeback_lock(
                "writeback-timeout", lock, "result_writeback"
            ):
                pytest.fail("timed-out writeback body must not run")
        streaming._emit_worker_writeback_timeout(
            "private", lambda event, payload: events.append((event, payload))
        )
        with config.ACTIVE_RUNS_LOCK:
            assert config.ACTIVE_RUNS["writeback-timeout"]["phase"] == "finalization_blocked"
        assert config.LAST_CHAT_ADMISSION_TIMEOUT_AT is None
    finally:
        lock.release()
        config.unregister_active_run("writeback-timeout")
        config.LAST_CHAT_ADMISSION_TIMEOUT_AT = None

    assert config.LAST_CHAT_FINALIZATION_TIMEOUT_AT is not None
    health = routes._run_lifecycle_health()
    assert health["status"] == "degraded"
    assert health["recent_finalization_timeout"] is True
    config.LAST_CHAT_FINALIZATION_TIMEOUT_AT = None
    assert events[0][0] == "apperror"
    assert events[0][1]["type"] == "chat_writeback_timeout"
    assert events[0][1]["retryable"] is False
    assert events[0][1]["outcome_unknown"] is True


def test_gateway_error_writeback_timeout_is_terminal(monkeypatch):
    import threading
    from api import config, gateway_chat, streaming

    lock = threading.Lock()
    lock.acquire()
    config.register_active_run("gateway-timeout", session_id="private")
    monkeypatch.setattr(streaming, "_CHAT_LOCK_WAIT_SECONDS", 0.02)
    monkeypatch.setattr(gateway_chat, "_get_session_agent_lock", lambda _sid: lock)
    try:
        payload = gateway_chat._settle_gateway_terminal_error(
            "private", "gateway-timeout", "/tmp", "model", "provider", "failed"
        )
        with config.ACTIVE_RUNS_LOCK:
            assert config.ACTIVE_RUNS["gateway-timeout"]["phase"] == "finalization_blocked"
    finally:
        lock.release()
        config.unregister_active_run("gateway-timeout")
        config.LAST_CHAT_ADMISSION_TIMEOUT_AT = None
        config.LAST_CHAT_FINALIZATION_TIMEOUT_AT = None

    assert payload["type"] == "chat_writeback_timeout"
    assert payload["retryable"] is False
    assert payload["outcome_unknown"] is True


def test_health_only_admission_waiter_never_blocks_worker_start():
    from api import background_process, config, routes

    previous_finished_at = config.LAST_RUN_FINISHED_AT
    config.register_active_run(
        "admission-observation",
        session_id="shared-session",
        phase="waiting_for_session_lock",
        health_only=True,
        attachable=False,
        profile=None,
    )
    try:
        assert routes._active_run_stream_for_session("shared-session") is None
        assert background_process._session_has_active_turn("shared-session") is False
    finally:
        config.unregister_active_run("admission-observation")
    assert config.LAST_RUN_FINISHED_AT == previous_finished_at


def test_worker_lock_acquisition_clears_wait_and_preserves_cancelling_phase():
    import threading
    from api import config, streaming

    config.register_active_run(
        "cancel-transition", session_id="session", health_only=True, profile=None
    )
    try:
        with streaming._try_acquire_worker_session_lock(
            "cancel-transition", threading.Lock(), "prestream_save"
        ) as acquired:
            assert acquired is True
            with config.ACTIVE_RUNS_LOCK:
                entry = config.ACTIVE_RUNS["cancel-transition"]
                assert entry["phase"] == "running"
                assert entry["lock_stage"] is None
                assert entry["lock_wait_started_at"] is None
            config.update_active_run("cancel-transition", phase="cancelling")
        with config.ACTIVE_RUNS_LOCK:
            assert config.ACTIVE_RUNS["cancel-transition"]["phase"] == "cancelling"
    finally:
        config.unregister_active_run("cancel-transition")


def test_worker_lock_entry_does_not_overwrite_cancelling_phase():
    import threading
    from api import config, streaming

    config.register_active_run(
        "cancel-entry", session_id="session", health_only=True, profile=None
    )
    config.update_active_run(
        "cancel-entry", phase="cancelling", cancelled_at=time.time()
    )
    try:
        with streaming._try_acquire_worker_session_lock(
            "cancel-entry", threading.Lock(), "post_run_cancel"
        ) as acquired:
            assert acquired is True
            with config.ACTIVE_RUNS_LOCK:
                assert config.ACTIVE_RUNS["cancel-entry"]["phase"] == "cancelling"
    finally:
        config.unregister_active_run("cancel-entry")


def test_deferred_pause_clear_requires_unchanged_idle_session(monkeypatch):
    import threading
    from api import streaming

    pause = {"paused": True, "classification": "credential_pool_empty"}
    saved = []
    session = SimpleNamespace(
        active_stream_id=None,
        process_wakeup_pause=dict(pause),
        save=lambda **_kwargs: saved.append(True),
    )
    lock = threading.Lock()
    lock.acquire()
    monkeypatch.setattr(streaming, "get_session", lambda _sid: session)
    monkeypatch.setattr(streaming, "_get_session_agent_lock", lambda _sid: lock)
    monkeypatch.setattr(streaming, "_CHAT_LOCK_WAIT_SECONDS", 0.02)

    thread = streaming._schedule_deferred_process_wakeup_pause_clear(
        "deferred-pause", pause
    )
    assert thread is not None
    time.sleep(0.05)
    assert thread.is_alive() is True
    lock.release()
    thread.join(timeout=1)

    assert thread.is_alive() is False
    assert session.process_wakeup_pause == {}
    assert saved == [True]


def test_deferred_pause_clear_stops_after_bounded_lock_retries(monkeypatch):
    import threading
    from api import streaming

    lock = threading.Lock()
    lock.acquire()
    monkeypatch.setattr(streaming, "_get_session_agent_lock", lambda _sid: lock)
    monkeypatch.setattr(streaming, "_CHAT_LOCK_WAIT_SECONDS", 0.01)
    monkeypatch.setattr(streaming, "_DEFERRED_SESSION_RETRY_DELAYS", (0.0, 0.0))

    thread = streaming._schedule_deferred_process_wakeup_pause_clear(
        "bounded-pause", {"paused": True}
    )
    assert thread is not None
    thread.join(timeout=1)

    assert thread.is_alive() is False
    assert "bounded-pause" not in streaming._DEFERRED_PAUSE_CLEAR_THREADS
    lock.release()


def test_health_only_waiter_does_not_skip_agent_eviction(monkeypatch):
    from api import config, session_lifecycle

    closed = []
    agent = SimpleNamespace(
        _session_db=SimpleNamespace(close=lambda: closed.append(True))
    )
    with config.SESSION_AGENT_CACHE_LOCK:
        config.SESSION_AGENT_CACHE["evict-session"] = (agent, "sig")
    config.register_active_run(
        "evict-observation",
        session_id="evict-session",
        health_only=True,
        profile=None,
    )
    monkeypatch.setattr(session_lifecycle, "has_uncommitted_work", lambda _sid: False)
    monkeypatch.setattr(session_lifecycle, "unregister_agent", lambda _sid: None)
    monkeypatch.setattr(session_lifecycle, "discard_session", lambda _sid: None)
    try:
        config._evict_session_agent("evict-session")
    finally:
        config.unregister_active_run("evict-observation")

    assert closed == [True]
