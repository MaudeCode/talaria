import queue
import threading
import time
from pathlib import Path

import api.config as config
import api.routes as routes

REPO = Path(__file__).resolve().parents[1]
ROUTES_SRC = (REPO / "api" / "routes.py").read_text(encoding="utf-8")
class _GateLock:
    def __init__(self):
        self._lock = threading.Lock()
        self.lookup_finished = threading.Event()
        self.writer_finished = threading.Event()

    def __enter__(self):
        self._lock.acquire()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._lock.release()
        if not self.lookup_finished.is_set():
            self.lookup_finished.set()
            assert self.writer_finished.wait(2), "writer did not finish race setup"
        return False


class _FakeSession:
    session_id = "issue1533-session"

    def __init__(self):
        self.active_stream_id = "stale-stream"
        self.pending_user_message = "old prompt"
        self.pending_attachments = ["old.txt"]
        self.pending_started_at = 123
        self.messages = []
        self.saved_stream_ids = []
        self.saved_touch_updated_at = []

    def save(self, *, touch_updated_at=True):
        self.saved_stream_ids.append(self.active_stream_id)
        self.saved_touch_updated_at.append(touch_updated_at)


def test_stale_stream_cleanup_helper_exists():
    assert "def _clear_stale_stream_state(session, *, lock_held: bool = False)" in ROUTES_SRC
    assert "stream_id in STREAMS" in ROUTES_SRC
    assert "session.active_stream_id = None" in ROUTES_SRC
    assert "session.pending_user_message = None" in ROUTES_SRC
    assert "session.pending_attachments = []" in ROUTES_SRC
    assert "session.pending_started_at = None" in ROUTES_SRC
    assert "session.save(touch_updated_at=False)" in ROUTES_SRC


def test_stale_stream_cleanup_does_not_refresh_sidebar_timestamp(monkeypatch):
    config.STREAMS.clear()
    config.SESSION_AGENT_LOCKS.clear()
    session = _FakeSession()
    monkeypatch.setattr(routes, "get_session", lambda sid: session)

    assert routes._clear_stale_stream_state(session) is True

    assert session.active_stream_id is None
    assert session.saved_touch_updated_at == [False]


def test_lock_held_stale_cleanup_does_not_reacquire(monkeypatch):
    config.STREAMS.clear()
    session = _FakeSession()
    monkeypatch.setattr(routes, "get_session", lambda sid: session)
    monkeypatch.setattr(
        routes,
        "_get_session_agent_lock",
        lambda _sid: (_ for _ in ()).throw(AssertionError("lock reacquired")),
    )

    assert routes._clear_stale_stream_state(session, lock_held=True) is True


def test_session_load_clears_stale_stream_before_response():
    load_pos = ROUTES_SRC.index("s = get_session(sid, metadata_only=(not load_messages))")
    cleanup_pos = ROUTES_SRC.index("_clear_stale_stream_state(s)", load_pos)
    response_pos = ROUTES_SRC.index('"active_stream_id": getattr(s, "active_stream_id", None)', cleanup_pos)
    assert load_pos < cleanup_pos < response_pos


def test_chat_start_clears_stale_pending_state_not_only_active_id():
    stale_comment_pos = ROUTES_SRC.index("locked_stream_id = getattr(s, \"active_stream_id\", None)")
    cleanup_pos = ROUTES_SRC.index(
        "_clear_stale_stream_state(s, lock_held=True)", stale_comment_pos
    )
    assert stale_comment_pos < cleanup_pos


def test_chat_start_rechecks_active_stream_under_session_lock(monkeypatch, tmp_path):
    """A concurrent chat_start must not overwrite stream ownership.

    The first request can pass the pre-lock active_stream_id check while another
    request is waiting/running. Once this request enters the session lock, it
    must re-read active_stream_id and reject instead of creating a ghost stream.
    """
    config.STREAMS.clear()
    config.SESSION_AGENT_LOCKS.clear()
    existing_stream_id = "already-running-stream"

    class ChatStartSession:
        session_id = "duplicate-start-session"

        def __init__(self):
            self.active_stream_id = None
            self.pending_user_message = None
            self.pending_attachments = []
            self.pending_started_at = None
            self.messages = []
            self.title = "Untitled"
            self.worktree_path = None
            self.workspace = None
            self.model = None
            self.model_provider = None

        def save(self, *args, **kwargs):
            return None

    session = ChatStartSession()
    monkeypatch.setattr(routes, "get_session", lambda sid: session)
    routes.PENDING_GOAL_CONTINUATION.add(session.session_id)
    routes.PENDING_BG_TASK_COMPLETIONS.add(session.session_id)

    class MutatingSessionLock:
        def acquire(self, timeout=None):
            session.active_stream_id = existing_stream_id
            session.pending_user_message = "prompt already claimed by another start"
            session.pending_started_at = 123.0
            routes.STREAMS[existing_stream_id] = queue.Queue()
            return True

        def release(self):
            pass

    class NoopThread:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

        def start(self):
            return None

    monkeypatch.setattr(routes, "_get_session_agent_lock", lambda sid: MutatingSessionLock())
    monkeypatch.setattr(routes.uuid, "uuid4", lambda: type("FakeUuid", (), {"hex": "new-stream"})())
    monkeypatch.setattr(routes, "set_last_workspace", lambda workspace, **_kw: None)
    monkeypatch.setattr(routes, "create_stream_channel", lambda: queue.Queue())
    monkeypatch.setattr(routes.threading, "Thread", NoopThread)

    try:
        response = routes._start_chat_stream_for_session(
            session,
            msg="please start once",
            attachments=[],
            workspace=str(tmp_path),
            model="test-model",
            model_provider=None,
        )

        assert response["_status"] == 409
        assert response["active_stream_id"] == existing_stream_id
        assert session.active_stream_id == existing_stream_id
        assert "new-stream" not in routes.STREAMS
        assert session.session_id in routes.PENDING_GOAL_CONTINUATION
        assert session.session_id in routes.PENDING_BG_TASK_COMPLETIONS
    finally:
        routes.STREAMS.pop(existing_stream_id, None)
        routes.PENDING_GOAL_CONTINUATION.discard(session.session_id)
        routes.PENDING_BG_TASK_COMPLETIONS.discard(session.session_id)


def test_chat_start_stale_deleted_handle_cannot_resurrect_session(monkeypatch, tmp_path):
    """Delete can win after the route captured ``s`` but before start claims it."""
    config.STREAMS.clear()
    config.ACTIVE_RUNS.clear()
    config.SESSION_AGENT_LOCKS.clear()

    class DeletedSessionHandle:
        session_id = "deleted-before-chat-lock"
        active_stream_id = None
        pending_user_message = None
        pending_attachments = []
        pending_started_at = None
        messages = []
        title = "Deleted"
        worktree_path = None
        workspace = None
        model = None
        model_provider = None

        def __init__(self):
            self.save_calls = 0

        def save(self, *args, **kwargs):
            self.save_calls += 1

    stale = DeletedSessionHandle()
    routes.PENDING_GOAL_CONTINUATION.add(stale.session_id)
    routes.PENDING_BG_TASK_COMPLETIONS.add(stale.session_id)

    def missing(_sid, *args, **kwargs):
        raise KeyError(_sid)

    monkeypatch.setattr(routes, "get_session", missing)
    try:
        response = routes._start_chat_stream_for_session(
            stale,
            msg="must not resurrect",
            attachments=[],
            workspace=str(tmp_path),
            model="test-model",
            model_provider=None,
        )

        assert response["_status"] == 404
        assert stale.save_calls == 0
        assert not routes.STREAMS
        assert stale.session_id in routes.PENDING_GOAL_CONTINUATION
        assert stale.session_id in routes.PENDING_BG_TASK_COMPLETIONS
    finally:
        routes.PENDING_GOAL_CONTINUATION.discard(stale.session_id)
        routes.PENDING_BG_TASK_COMPLETIONS.discard(stale.session_id)


def test_process_wakeup_retargets_snapshot_created_while_waiting_for_admission(
    monkeypatch, tmp_path
):
    """A compression-boundary waiter must start only on the live child."""
    config.STREAMS.clear()
    config.ACTIVE_RUNS.clear()
    config.SESSION_AGENT_LOCKS.clear()

    class CompressionSession:
        def __init__(self, session_id, *, snapshot=False):
            self.session_id = session_id
            self.pre_compression_snapshot = snapshot
            self.active_stream_id = None
            self.pending_user_message = None
            self.pending_attachments = []
            self.pending_started_at = None
            self.pending_user_source = None
            self.messages = [{"role": "user", "content": "existing"}]
            self.title = "Compression race"
            self.worktree_path = None

    parent = CompressionSession("compression-race-parent")
    child = CompressionSession("compression-race-child")
    sessions = {parent.session_id: parent, child.session_id: child}
    lock_entries = []

    class AdmissionLock:
        def __init__(self, session_id):
            self.session_id = session_id

        def acquire(self, timeout=None):
            lock_entries.append(self.session_id)
            if self.session_id == parent.session_id:
                # The caller captured a writable parent, then the active turn
                # compressed it before this queued wakeup acquired admission.
                parent.pre_compression_snapshot = True
            return True

        def release(self):
            pass

    prepared = []

    def prepare(session, **kwargs):
        prepared.append(session.session_id)
        session.active_stream_id = kwargs["stream_id"]
        session.pending_user_message = kwargs["msg"]
        session.pending_attachments = kwargs["attachments"]
        session.pending_started_at = 123.0
        session.pending_user_source = kwargs["source"]

    class NoopThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            return None

    monkeypatch.setattr(routes, "get_session", lambda sid: sessions[sid])
    monkeypatch.setattr(
        routes,
        "_pre_compression_continuation_session_id",
        lambda session: child.session_id if session is parent else None,
    )
    monkeypatch.setattr(
        routes, "_get_session_agent_lock", lambda sid: AdmissionLock(sid)
    )
    monkeypatch.setattr(routes, "_prepare_chat_start_session_for_stream", prepare)
    monkeypatch.setattr(routes, "_agent_runtime_barrier_response", lambda **_: None)
    monkeypatch.setattr(routes, "webui_gateway_chat_enabled", lambda _cfg: False)
    monkeypatch.setattr(
        routes.uuid,
        "uuid4",
        lambda: type("FakeUuid", (), {"hex": "redirected-stream"})(),
    )
    monkeypatch.setattr(routes, "set_last_workspace", lambda _workspace, **_kwargs: None)
    monkeypatch.setattr(routes, "create_stream_channel", queue.Queue)
    monkeypatch.setattr(routes, "register_stream_owner", lambda *_args: None)
    monkeypatch.setattr(routes.threading, "Thread", NoopThread)
    import api.turn_journal as turn_journal

    monkeypatch.setattr(turn_journal, "append_turn_journal_event", lambda *_a, **_k: {})

    try:
        response = routes._start_chat_stream_for_session(
            parent,
            msg="delegation complete",
            attachments=[],
            workspace=str(tmp_path),
            model="test-model",
            model_provider=None,
            source="process_wakeup",
        )

        assert response["session_id"] == child.session_id
        assert response["stream_id"] == "redirected-stream"
        assert lock_entries == [parent.session_id, child.session_id]
        assert prepared == [child.session_id]
        assert parent.active_stream_id is None
        assert child.pending_user_source == "process_wakeup"
    finally:
        routes.STREAMS.pop("redirected-stream", None)


def test_chat_start_blocks_same_session_active_run_after_cancel_clears_stream_id(monkeypatch, tmp_path):
    """Regression for #3808: cancel clears active_stream_id before worker exit.

    interrupt-and-send queues a successor message, then calls cancel_stream().
    cancel_stream() intentionally clears session.active_stream_id so Stop remains
    responsive, but the old worker remains in ACTIVE_RUNS until its finally block
    unregisters it. chat/start must still block by session_id during that window.
    """
    config.STREAMS.clear()
    config.ACTIVE_RUNS.clear()
    config.SESSION_AGENT_LOCKS.clear()

    class ChatStartSession:
        session_id = "interrupt-send-session"

        def __init__(self):
            self.active_stream_id = None
            self.pending_user_message = None
            self.pending_attachments = []
            self.pending_started_at = None
            self.messages = []
            self.title = "Interrupt Send"
            self.worktree_path = None
            self.workspace = None
            self.model = None
            self.model_provider = None

        def save(self, *args, **kwargs):
            return None

    session = ChatStartSession()
    monkeypatch.setattr(routes, "get_session", lambda sid: session)
    old_stream_id = "old-cancelling-stream"
    config.register_active_run(old_stream_id, session_id=session.session_id, phase="cancelling")

    class NoopThread:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

        def start(self):
            return None

    monkeypatch.setattr(routes.uuid, "uuid4", lambda: type("FakeUuid", (), {"hex": "new-stream"})())
    monkeypatch.setattr(routes, "set_last_workspace", lambda workspace, **_kw: None)
    monkeypatch.setattr(routes, "create_stream_channel", lambda: queue.Queue())
    monkeypatch.setattr(routes.threading, "Thread", NoopThread)

    try:
        response = routes._start_chat_stream_for_session(
            session,
            msg="successor prompt",
            attachments=[],
            workspace=str(tmp_path),
            model="test-model",
            model_provider=None,
        )

        assert response["_status"] == 409
        assert response["active_stream_id"] == old_stream_id
        assert session.active_stream_id is None
        assert session.pending_user_message is None
        assert "new-stream" not in routes.STREAMS
    finally:
        config.unregister_active_run(old_stream_id)


def test_chat_start_allows_same_session_after_active_run_unregisters(monkeypatch, tmp_path):
    """The #3808 guard must release once the old worker unregisters ACTIVE_RUNS."""
    config.STREAMS.clear()
    config.ACTIVE_RUNS.clear()
    config.SESSION_AGENT_LOCKS.clear()

    class ChatStartSession:
        session_id = "interrupt-send-session-released"

        def __init__(self):
            self.active_stream_id = None
            self.pending_user_message = None
            self.pending_attachments = []
            self.pending_started_at = None
            self.messages = []
            self.title = "Interrupt Send"
            self.worktree_path = None
            self.workspace = None
            self.model = None
            self.model_provider = None

        def save(self, *args, **kwargs):
            return None

    session = ChatStartSession()
    monkeypatch.setattr(routes, "get_session", lambda sid: session)

    class NoopThread:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

        def start(self):
            return None

    monkeypatch.setattr(routes.uuid, "uuid4", lambda: type("FakeUuid", (), {"hex": "new-stream"})())
    monkeypatch.setattr(routes, "set_last_workspace", lambda workspace, **_kw: None)
    monkeypatch.setattr(routes, "create_stream_channel", lambda: queue.Queue())
    monkeypatch.setattr(routes.threading, "Thread", NoopThread)

    response = routes._start_chat_stream_for_session(
        session,
        msg="successor prompt",
        attachments=[],
        workspace=str(tmp_path),
        model="test-model",
        model_provider=None,
    )

    try:
        assert "error" not in response
        assert response["stream_id"] == "new-stream"
        assert session.active_stream_id == "new-stream"
        assert session.pending_user_message == "successor prompt"
    finally:
        routes.STREAMS.pop("new-stream", None)


def test_chat_start_keeps_aged_detached_live_worker_blocking(monkeypatch, tmp_path):
    """A disconnected browser must not make a long worker safe to supersede."""
    config.STREAMS.clear()
    config.ACTIVE_RUNS.clear()
    config.SESSION_AGENT_LOCKS.clear()

    class ChatStartSession:
        session_id = "interrupt-send-session-stale"

        def __init__(self):
            self.active_stream_id = None
            self.pending_user_message = None
            self.pending_attachments = []
            self.pending_started_at = None
            self.messages = []
            self.title = "Interrupt Send"
            self.worktree_path = None
            self.workspace = None
            self.model = None
            self.model_provider = None

        def save(self, *args, **kwargs):
            return None

    session = ChatStartSession()
    monkeypatch.setattr(routes, "get_session", lambda sid: session)
    stale_stream_id = "wedged-old-stream"
    config.register_active_run(stale_stream_id, session_id=session.session_id, phase="running")
    # The SSE stream is detached and the run is old, but register_active_run()
    # recorded this still-live test thread as the worker owner.
    with config.ACTIVE_RUNS_LOCK:
        config.ACTIVE_RUNS[stale_stream_id]["started_at"] = time.time() - 600

    assert routes._active_run_stream_for_session(session.session_id) == stale_stream_id
    assert stale_stream_id in config.ACTIVE_RUNS

    class NoopThread:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

        def start(self):
            return None

    monkeypatch.setattr(routes.uuid, "uuid4", lambda: type("FakeUuid", (), {"hex": "new-stream"})())
    monkeypatch.setattr(routes, "set_last_workspace", lambda workspace, **_kw: None)
    monkeypatch.setattr(routes, "create_stream_channel", lambda: queue.Queue())
    monkeypatch.setattr(routes.threading, "Thread", NoopThread)

    try:
        response = routes._start_chat_stream_for_session(
            session,
            msg="successor prompt",
            attachments=[],
            workspace=str(tmp_path),
            model="test-model",
            model_provider=None,
        )
        assert response["_status"] == 409
        assert response["active_stream_id"] == stale_stream_id
        assert session.active_stream_id is None
        assert session.pending_user_message is None
    finally:
        config.unregister_active_run(stale_stream_id)
        config.unregister_active_run("new-stream")
        routes.STREAMS.pop("new-stream", None)


def test_dead_worker_row_without_stream_is_reaped():
    """Thread ownership preserves stale-row recovery without an age guess."""
    config.STREAMS.clear()
    config.ACTIVE_RUNS.clear()
    sid = "dead-worker-session"
    stream_id = "dead-worker-stream"

    def register_then_exit():
        config.register_active_run(stream_id, session_id=sid, phase="running")

    worker = threading.Thread(target=register_then_exit)
    worker.start()
    worker.join(2)
    assert not worker.is_alive()

    assert routes._active_run_stream_for_session(sid) is None
    assert stream_id not in config.ACTIVE_RUNS


def test_compression_tip_blocks_active_snapshot_ancestor(monkeypatch, tmp_path):
    """Automatic work cannot overlap a writer registered on an older segment."""
    config.STREAMS.clear()
    config.ACTIVE_RUNS.clear()
    config.SESSION_AGENT_LOCKS.clear()

    class CompressionSession:
        def __init__(self, sid, *, parent=None, snapshot=False):
            self.session_id = sid
            self.parent_session_id = parent
            self.pre_compression_snapshot = snapshot
            self.relationship_type = None
            self.profile = "default"
            self.active_stream_id = None
            self.pending_user_message = None
            self.pending_attachments = []
            self.pending_started_at = None
            self.messages = []
            self.title = "Compression lineage"
            self.worktree_path = None

        def save(self, *args, **kwargs):
            return None

    root = CompressionSession("compression-active-root", snapshot=True)
    tip = CompressionSession(
        "compression-idle-tip",
        parent=root.session_id,
        snapshot=False,
    )
    sessions = {root.session_id: root, tip.session_id: tip}
    monkeypatch.setattr(routes, "get_session", lambda sid, **_kwargs: sessions[sid])
    monkeypatch.setattr(
        routes.Session,
        "load_metadata_only",
        lambda sid, **_kwargs: sessions.get(sid),
    )

    active_stream = "root-live-stream"
    config.register_active_run(active_stream, session_id=root.session_id, phase="running")
    try:
        response = routes._start_chat_stream_for_session(
            tip,
            msg="delegation complete",
            attachments=[],
            workspace=str(tmp_path),
            model="test-model",
            model_provider=None,
            source="process_wakeup",
        )
        assert response["_status"] == 409
        assert response["active_stream_id"] == active_stream
        assert tip.pending_user_message is None
        assert not routes.STREAMS
    finally:
        config.unregister_active_run(active_stream)


def test_compression_admission_lineage_does_not_cross_ordinary_fork(monkeypatch):
    class Row:
        profile = "default"
        relationship_type = None

        def __init__(self, sid, *, parent=None, snapshot=False):
            self.session_id = sid
            self.parent_session_id = parent
            self.pre_compression_snapshot = snapshot

    parent = Row("ordinary-fork-parent", snapshot=False)
    fork = Row("ordinary-fork-child", parent=parent.session_id)
    rows = {parent.session_id: parent, fork.session_id: fork}
    monkeypatch.setattr(routes, "get_session", lambda sid, **_kwargs: rows[sid])
    monkeypatch.setattr(
        routes.Session,
        "load_metadata_only",
        lambda sid, **_kwargs: rows.get(sid),
    )

    assert routes._compression_admission_lineage_ids(fork.session_id) == {fork.session_id}


def test_live_worker_age_never_disables_active_run_guard():
    """An aged worker remains both registered and reported as blocking."""
    config.STREAMS.clear()
    config.ACTIVE_RUNS.clear()
    sid = "live-teardown-session"
    live_stream_id = "still-alive-stream"
    config.register_active_run(live_stream_id, session_id=sid, phase="running")
    # Age the entry past the ceiling AND keep the worker present in STREAMS.
    with config.ACTIVE_RUNS_LOCK:
        config.ACTIVE_RUNS[live_stream_id]["started_at"] = time.time() - 600
    config.STREAMS[live_stream_id] = object()
    try:
        assert routes._active_run_stream_for_session(sid) == live_stream_id
        assert live_stream_id in config.ACTIVE_RUNS
    finally:
        config.STREAMS.pop(live_stream_id, None)
        config.unregister_active_run(live_stream_id)


def test_stale_stream_cleanup_does_not_clobber_concurrent_chat_start(monkeypatch):
    """Regression for #1533: stale cleanup must not erase a new stream id.

    The gate lock pauses the cleanup thread after it has decided that the old
    stream id is stale, then lets a chat_start-like writer register and persist
    a new active_stream_id for the same session.
    """
    config.STREAMS.clear()
    config.SESSION_AGENT_LOCKS.clear()
    gate_lock = _GateLock()
    session = _FakeSession()
    new_stream_id = "new-stream"
    result = {}

    monkeypatch.setattr(routes, "STREAMS_LOCK", gate_lock)

    def cleanup_stale_stream():
        result["cleared"] = routes._clear_stale_stream_state(session)

    def start_new_stream():
        assert gate_lock.lookup_finished.wait(2), "cleanup did not reach race point"
        with routes.STREAMS_LOCK:
            routes.STREAMS[new_stream_id] = queue.Queue()
        with routes._get_session_agent_lock(session.session_id):
            session.active_stream_id = new_stream_id
            session.pending_user_message = "new prompt"
            session.pending_attachments = ["new.txt"]
            session.pending_started_at = 456
            session.save()
        gate_lock.writer_finished.set()

    cleanup_thread = threading.Thread(target=cleanup_stale_stream)
    writer_thread = threading.Thread(target=start_new_stream)
    cleanup_thread.start()
    writer_thread.start()
    cleanup_thread.join(2)
    writer_thread.join(2)

    assert not cleanup_thread.is_alive()
    assert not writer_thread.is_alive()
    assert result["cleared"] is False
    assert session.active_stream_id == new_stream_id
    assert session.pending_user_message == "new prompt"
    assert session.pending_attachments == ["new.txt"]
    assert session.pending_started_at == 456
