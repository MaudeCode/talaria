"""Regression tests for the embedded-terminal resource leak (#4633).

Two leaks are closed here:

1. **fd + dict entry on shell exit.** When a shell exited on its own (user typed
   `exit`, the process died), `_reader_loop` broke out of its loop but only set
   `closed` and emitted `terminal_closed`; it never closed the pty `master_fd`
   nor removed the `_TERMINALS` entry. Only an explicit `close_terminal` /
   restart / atexit did that, so a self-exited shell leaked its fd and dict
   entry for the rest of the WebUI's uptime. The reader loop now retires the
   session (identity-guarded so a restart's replacement is never touched).

2. **Unbounded accumulation of abandoned terminals.** A client that drops its
   output stream without POSTing /api/terminal/close (tab close, crash, network
   drop) leaves the shell running (no PDEATHSIG, by design). Without a ceiling
   these pile up toward fd/thread exhaustion. `_MAX_TERMINALS` now caps the live
   population, evicting the least-recently-active terminal to make room.

These use fakes for the shell/pty so they run without spawning real processes;
the real-shell path is covered by test_terminal_linux_lifecycle.
"""
import os
import threading
import time
import types

import pytest

if os.name != "posix":
    pytest.skip("terminal tests require POSIX terminal support", allow_module_level=True)

import api.terminal as terminal


class _FakeProc:
    """A shell process fake. ``alive`` controls poll()."""

    def __init__(self, pid=424242, alive=True):
        self.pid = pid
        self._alive = alive
        self.wait_calls = []

    def poll(self):
        return None if self._alive else 0

    def wait(self, timeout=None):
        self.wait_calls.append(timeout)
        return 0


def _make_registered_term(monkeypatch, sid, *, alive=True, last_activity=0.0, real_fd=True):
    """Build a TerminalSession, register it in _TERMINALS, no reader thread."""
    if real_fd:
        r, w = os.pipe()
        os.close(w)  # leave a real, closable fd as master_fd
        master_fd = r
    else:
        master_fd = -1
    term = terminal.TerminalSession(
        session_id=sid,
        workspace="/tmp",
        proc=_FakeProc(alive=alive),
        master_fd=master_fd,
        last_activity=last_activity,
    )
    with terminal._LOCK:
        terminal._TERMINALS[sid] = term
    return term


@pytest.fixture(autouse=True)
def _clean_terminals(monkeypatch):
    # Never kill real process groups in these unit tests.
    monkeypatch.setattr(terminal.os, "killpg", lambda *a, **k: None)
    monkeypatch.setattr(terminal, "_TERMINAL_SHUTTING_DOWN", False)
    yield
    with terminal._LOCK:
        sids = list(terminal._TERMINALS)
        pending = list(terminal._STARTING_TERMINALS.values())
        terminal._STARTING_TERMINALS.clear()
    for reservation in pending:
        reservation.done.set()
    for sid in sids:
        try:
            terminal.close_terminal(sid)
        except Exception:
            pass


# ── Leak 1: reader loop retires the session on shell exit ────────────────────

def test_reader_loop_retires_session_and_closes_fd(monkeypatch):
    sid = "leak-reader-exit"
    term = _make_registered_term(monkeypatch, sid, alive=False)
    fd = term.master_fd

    # Run the reader loop directly: a dead proc makes it exit its first iteration.
    terminal._reader_loop(term)

    with terminal._LOCK:
        assert sid not in terminal._TERMINALS, "entry not retired on shell exit"
    with pytest.raises(OSError):
        os.fstat(fd)  # master_fd was closed — no leak


def test_reader_loop_retire_is_identity_guarded_against_restart(monkeypatch):
    """An old reader thread finishing after a restart must not tear down the
    new terminal that replaced its session id."""
    sid = "leak-restart-race"
    old = _make_registered_term(monkeypatch, sid, alive=False)
    # Simulate a restart: a NEW terminal now occupies the same sid.
    new = _make_registered_term(monkeypatch, sid, alive=True)
    assert terminal._TERMINALS[sid] is new

    # The OLD reader loop finishes now.
    terminal._reader_loop(old)

    # The new terminal must still be registered and its fd open.
    assert terminal._TERMINALS.get(sid) is new
    os.fstat(new.master_fd)  # not closed


# ── Leak 2: _MAX_TERMINALS cap evicts the least-recently-active terminal ──────

def test_cap_evicts_least_recently_active(monkeypatch):
    monkeypatch.setattr(terminal, "_MAX_TERMINALS", 3)
    # Fill to the cap with alive terminals of increasing activity.
    terms = {}
    for i in range(3):
        terms[i] = _make_registered_term(
            monkeypatch, f"cap-{i}", alive=True, last_activity=100.0 + i
        )
    # cap-0 is least-recently-active. Enforcing the cap for a NEW sid evicts it.
    terminal._enforce_terminal_cap(exclude_sid="cap-new")

    with terminal._LOCK:
        live = set(terminal._TERMINALS)
    assert "cap-0" not in live, "least-recently-active terminal was not evicted"
    assert {"cap-1", "cap-2"} <= live
    assert len(live) < 3  # room was made for the new terminal


def test_cap_prefers_dead_terminals_for_eviction(monkeypatch):
    monkeypatch.setattr(terminal, "_MAX_TERMINALS", 3)
    # A dead terminal that is NOT the least-recently-active must still go first.
    _make_registered_term(monkeypatch, "cap-dead", alive=False, last_activity=999.0)
    _make_registered_term(monkeypatch, "cap-live-a", alive=True, last_activity=1.0)
    _make_registered_term(monkeypatch, "cap-live-b", alive=True, last_activity=2.0)

    terminal._enforce_terminal_cap(exclude_sid="cap-new")

    with terminal._LOCK:
        live = set(terminal._TERMINALS)
    assert "cap-dead" not in live, "dead terminal not preferred for eviction"
    assert {"cap-live-a", "cap-live-b"} <= live


def test_cap_reuse_of_existing_sid_evicts_nothing(monkeypatch):
    monkeypatch.setattr(terminal, "_MAX_TERMINALS", 2)
    _make_registered_term(monkeypatch, "keep-a", alive=True, last_activity=1.0)
    _make_registered_term(monkeypatch, "keep-b", alive=True, last_activity=2.0)

    # Reusing an already-registered sid replaces in place — no growth, no evict.
    terminal._enforce_terminal_cap(exclude_sid="keep-a")

    with terminal._LOCK:
        assert {"keep-a", "keep-b"} <= set(terminal._TERMINALS)


def test_reused_terminal_resize_is_atomic_with_registry_close(monkeypatch, tmp_path):
    current = _make_registered_term(monkeypatch, "reuse-atomic", alive=True)
    current.workspace = str(terminal.Path(current.workspace).resolve())
    close_started = threading.Event()
    close_finished = threading.Event()
    closer = None

    def resize(_term, _rows, _cols):
        nonlocal closer
        closer = threading.Thread(
            target=lambda: (
                close_started.set(),
                terminal.close_terminal("reuse-atomic", expected=current),
                close_finished.set(),
            )
        )
        closer.start()
        assert close_started.wait(1)
        assert close_finished.wait(0.1) is False

    monkeypatch.setattr(terminal, "_set_size", resize)

    assert terminal.start_terminal("reuse-atomic", terminal.Path(current.workspace)) is current
    closer.join(1)
    assert close_finished.is_set()


def test_blocked_spawn_does_not_delay_unrelated_close(monkeypatch, tmp_path):
    other = _make_registered_term(monkeypatch, "other", alive=False)
    request_ready = threading.Event()
    captured = {}
    errors = []

    def put(request):
        captured["request"] = request
        request_ready.set()

    monkeypatch.setattr(terminal, "_spawn_queue", types.SimpleNamespace(put=put))
    monkeypatch.setattr(terminal, "_ensure_spawn_supervisor", lambda: None)
    monkeypatch.setattr(terminal, "_ensure_terminal_reaper", lambda: None)

    def start_and_capture():
        try:
            terminal.start_terminal("blocked", tmp_path)
        except Exception as exc:
            errors.append(exc)

    starter = threading.Thread(target=start_and_capture)
    starter.start()
    assert request_ready.wait(1)

    closed = threading.Event()
    closer = threading.Thread(
        target=lambda: (terminal.close_terminal("other", expected=other), closed.set())
    )
    closer.start()
    unrelated_close_progressed = closed.wait(0.2)

    captured["request"].error = RuntimeError("synthetic spawn failure")
    captured["request"].done.set()
    starter.join(1)
    closer.join(1)

    assert unrelated_close_progressed is True
    assert errors and str(errors[0]) == "synthetic spawn failure"
    assert "blocked" not in terminal._STARTING_TERMINALS


def test_pty_setup_failure_releases_start_reservation(monkeypatch, tmp_path):
    monkeypatch.setattr(
        terminal.os,
        "openpty",
        lambda: (_ for _ in ()).throw(OSError("fd exhaustion")),
    )

    with pytest.raises(OSError, match="fd exhaustion"):
        terminal.start_terminal("pty-failure", tmp_path)

    assert "pty-failure" not in terminal._STARTING_TERMINALS


def test_pre_enqueue_failure_signals_spawn_event(monkeypatch, tmp_path):
    captured = {}
    original_request = terminal._SpawnRequest

    def capture_request(*args, **kwargs):
        request = original_request(*args, **kwargs)
        captured["request"] = request
        return request

    monkeypatch.setattr(terminal, "_SpawnRequest", capture_request)
    monkeypatch.setattr(terminal, "_ensure_spawn_supervisor", lambda: None)
    monkeypatch.setattr(
        terminal,
        "_ensure_terminal_reaper",
        lambda: (_ for _ in ()).throw(RuntimeError("thread unavailable")),
    )

    with pytest.raises(RuntimeError, match="thread unavailable"):
        terminal.start_terminal("pre-enqueue-failure", tmp_path)

    assert captured["request"].done.is_set()
    assert "pre-enqueue-failure" not in terminal._STARTING_TERMINALS


def test_request_construction_failure_closes_untransferred_slave_fd(
    monkeypatch, tmp_path
):
    closed = []
    monkeypatch.setattr(terminal.os, "openpty", lambda: (100, 101))
    monkeypatch.setattr(terminal.os, "dup", lambda _fd: 102)
    monkeypatch.setattr(terminal, "_safe_close_fd", lambda fd: closed.append(fd))
    monkeypatch.setattr(
        terminal,
        "_SpawnRequest",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(MemoryError("allocation")),
    )

    with pytest.raises(MemoryError, match="allocation"):
        terminal.start_terminal("request-allocation-failure", tmp_path)

    assert set(closed) == {100, 101, 102}


def test_cancelled_start_keeps_capacity_until_owner_cleans_up(monkeypatch, tmp_path):
    monkeypatch.setattr(terminal, "_MAX_TERMINALS", 1)
    request_ready = threading.Event()
    captured = {}
    errors = []

    def put(request):
        captured["request"] = request
        request_ready.set()

    monkeypatch.setattr(terminal, "_spawn_queue", types.SimpleNamespace(put=put))
    monkeypatch.setattr(terminal, "_ensure_spawn_supervisor", lambda: None)
    monkeypatch.setattr(terminal, "_ensure_terminal_reaper", lambda: None)

    def start_blocked():
        try:
            terminal.start_terminal("blocked-cap", tmp_path)
        except Exception as exc:
            errors.append(exc)

    owner = threading.Thread(target=start_blocked)
    owner.start()
    assert request_ready.wait(1)
    assert terminal.close_terminal("blocked-cap") is True

    with pytest.raises(RuntimeError, match="capacity is busy"):
        terminal.start_terminal("second", tmp_path)

    captured["request"].error = RuntimeError("synthetic spawn failure")
    captured["request"].done.set()
    owner.join(1)

    assert errors
    assert "blocked-cap" not in terminal._STARTING_TERMINALS


def test_duplicate_pending_start_does_not_evict_live_terminal(monkeypatch):
    monkeypatch.setattr(terminal, "_MAX_TERMINALS", 2)
    live = _make_registered_term(monkeypatch, "live", alive=True)
    with terminal._LOCK:
        terminal._STARTING_TERMINALS["pending"] = terminal._StartReservation()

    terminal._enforce_terminal_cap(exclude_sid="pending")

    assert terminal._TERMINALS["live"] is live


def test_reader_start_failure_rolls_back_published_terminal(monkeypatch, tmp_path):
    class BrokenThread:
        def start(self):
            raise RuntimeError("thread exhaustion")

    def put(request):
        request.proc = _FakeProc(alive=False)
        request.done.set()

    monkeypatch.setattr(terminal, "_spawn_queue", types.SimpleNamespace(put=put))
    monkeypatch.setattr(terminal, "_ensure_spawn_supervisor", lambda: None)
    monkeypatch.setattr(terminal, "_ensure_terminal_reaper", lambda: None)
    monkeypatch.setattr(terminal, "_set_nonblocking", lambda _fd: None)
    monkeypatch.setattr(terminal, "_set_size", lambda *_args: None)
    monkeypatch.setattr(terminal.threading, "Thread", lambda *_args, **_kwargs: BrokenThread())

    with pytest.raises(RuntimeError, match="thread exhaustion"):
        terminal.start_terminal("reader-failure", tmp_path)

    assert "reader-failure" not in terminal._TERMINALS
    assert "reader-failure" not in terminal._STARTING_TERMINALS


def test_close_all_waits_for_pending_start_cleanup(monkeypatch, tmp_path):
    request_ready = threading.Event()
    captured = {}
    errors = []

    def put(request):
        captured["request"] = request
        request_ready.set()

    monkeypatch.setattr(terminal, "_spawn_queue", types.SimpleNamespace(put=put))
    monkeypatch.setattr(terminal, "_ensure_spawn_supervisor", lambda: None)
    monkeypatch.setattr(terminal, "_ensure_terminal_reaper", lambda: None)

    def start_and_capture():
        try:
            terminal.start_terminal("shutdown-pending", tmp_path)
        except Exception as exc:
            errors.append(str(exc))

    owner = threading.Thread(target=start_and_capture)
    owner.start()
    assert request_ready.wait(1)
    waiter = threading.Thread(target=start_and_capture)
    waiter.start()
    time.sleep(0.05)
    closed = threading.Event()
    shutdown = threading.Thread(
        target=lambda: (terminal.close_all_terminals(), closed.set())
    )
    shutdown.start()
    assert closed.wait(0.1) is False

    captured["request"].error = RuntimeError("shutdown")
    captured["request"].done.set()
    owner.join(1)
    waiter.join(1)
    shutdown.join(1)

    assert closed.is_set()
    assert waiter.is_alive() is False
    assert "terminal subsystem is shutting down" in errors
    assert "shutdown-pending" not in terminal._STARTING_TERMINALS


def test_shutdown_wait_covers_full_pending_start_cleanup_path():
    # Replacement teardown (2.5s) + spawn wait (5s) + cancellation teardown
    # (2.5s), with room for scheduling overhead.
    assert terminal._TERMINAL_SHUTDOWN_WAIT_SECONDS >= 11.0


def test_shutdown_waits_for_supervisor_owned_late_spawn_cleanup(monkeypatch):
    reservation = terminal._StartReservation()
    reservation.done.set()
    reservation.spawn_done = threading.Event()
    with terminal._LOCK:
        terminal._STARTING_TERMINALS["late-spawn"] = reservation
    finished = threading.Event()
    shutdown = threading.Thread(
        target=lambda: (terminal.close_all_terminals(), finished.set())
    )
    shutdown.start()
    assert finished.wait(0.1) is False

    reservation.spawn_done.set()
    shutdown.join(1)

    assert finished.is_set()


def test_spawn_timeout_retains_capacity_until_supervisor_cleanup(monkeypatch, tmp_path):
    captured = {}

    class NeverDone:
        def wait(self, timeout=None):
            return False

        def is_set(self):
            return False

    def put(request):
        request.done = NeverDone()
        captured["request"] = request

    monkeypatch.setattr(terminal, "_spawn_queue", types.SimpleNamespace(put=put))
    monkeypatch.setattr(terminal, "_ensure_spawn_supervisor", lambda: None)
    monkeypatch.setattr(terminal, "_ensure_terminal_reaper", lambda: None)

    with pytest.raises(TimeoutError, match="terminal spawn timeout"):
        terminal.start_terminal("late-timeout", tmp_path)

    assert "late-timeout" in terminal._STARTING_TERMINALS
    request = captured["request"]
    request.done = threading.Event()
    request.done.set()
    terminal._release_abandoned_spawn_reservation(request)
    terminal._close_spawn_request_fds(request)
    assert "late-timeout" not in terminal._STARTING_TERMINALS


def test_shutdown_cancelled_queued_spawns_skip_process_creation():
    requests = []
    for index in range(3):
        sid = f"queued-{index}"
        reservation = terminal._StartReservation(cancelled=True)
        read_fd, spawn_fd = os.pipe()
        request = terminal._SpawnRequest(
            {},
            reservation_sid=sid,
            reservation=reservation,
            spawn_fds=(spawn_fd,),
        )
        with terminal._LOCK:
            terminal._STARTING_TERMINALS[sid] = reservation
        requests.append((sid, reservation, request, read_fd, spawn_fd))

    try:
        for sid, reservation, request, _read_fd, spawn_fd in requests:
            assert terminal._cancel_spawn_before_popen(request) is True
            assert request.done.is_set()
            assert reservation.done.is_set()
            assert sid not in terminal._STARTING_TERMINALS
            with pytest.raises(OSError):
                os.fstat(spawn_fd)
    finally:
        for _sid, _reservation, _request, read_fd, _spawn_fd in requests:
            os.close(read_fd)


# ── F1: writes/resizes are serialized against close (no fd-reuse injection) ───

def test_write_after_close_raises_and_never_touches_fd(monkeypatch):
    """A write racing a teardown must not reach os.write once the terminal is
    closed — otherwise the recycled fd number could receive foreign input."""
    sid = "io-write-after-close"
    term = _make_registered_term(monkeypatch, sid, alive=True)

    calls = []
    monkeypatch.setattr(terminal.os, "write", lambda fd, data: calls.append(fd))

    # Simulate the teardown having marked the terminal closed.
    term.closed.set()
    with pytest.raises(KeyError):
        terminal.write_terminal(sid, "rm -rf /\n")
    assert calls == [], "write reached os.write after close — fd-reuse risk"


def test_close_acquires_io_lock_before_closing_fd(monkeypatch):
    """close_terminal must take io_lock around os.close so a concurrent writer
    holding io_lock finishes (or bails) first — proving the two are serialized."""
    import threading

    sid = "io-close-serialized"
    term = _make_registered_term(monkeypatch, sid, alive=False)
    fd = term.master_fd

    closed_fd = []
    monkeypatch.setattr(terminal.os, "close", lambda f: closed_fd.append(f))

    # Hold io_lock, then kick off a close in another thread and confirm it blocks
    # on the fd-close until we release.
    with term.io_lock:
        t = threading.Thread(target=lambda: terminal.close_terminal(sid, expected=term))
        t.start()
        t.join(timeout=0.3)
        assert closed_fd == [], "close closed the fd without waiting for io_lock"
    t.join(timeout=2.0)
    assert closed_fd == [fd], "close did not close the fd after io_lock released"


# ── F2: cap eviction is identity-guarded ─────────────────────────────────────

def test_cap_eviction_uses_expected_guard(monkeypatch):
    monkeypatch.setattr(terminal, "_MAX_TERMINALS", 1)
    victim = _make_registered_term(monkeypatch, "cap-victim", alive=True, last_activity=1.0)

    seen = {}

    real_close = terminal.close_terminal

    def _spy_close(sid, *, expected=None):
        seen["sid"] = sid
        seen["expected"] = expected
        return real_close(sid, expected=expected)

    monkeypatch.setattr(terminal, "close_terminal", _spy_close)
    terminal._enforce_terminal_cap(exclude_sid="cap-new")

    assert seen.get("sid") == "cap-victim"
    assert seen.get("expected") is victim, "cap eviction must pass expected= for identity safety"
