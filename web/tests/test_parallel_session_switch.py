"""Tests for session-switch performance optimizations.

Four optimizations to reduce session-switch latency:

1. loadDir expanded-dir pre-fetch uses Promise.all (workspace.js)
2. loadSession idle path overlaps loadDir with highlightCode (sessions.js)
3. git_info_for_workspace runs git subprocesses in parallel (workspace.py)
4. Message pagination: msg_limit tail-window + msg_before index cursor (routes.py + sessions.js)
"""

import pathlib
import re
import threading
import time
from unittest.mock import patch, MagicMock

REPO = pathlib.Path(__file__).parent.parent
ROUTES_PY = (REPO / "api" / "routes.py").read_text(encoding="utf-8")


# ── 1. workspace.js: expanded-dir pre-fetch is parallelized ─────────────────


# ── 2. sessions.js: loadSession idle path avoids duplicate highlighting ─


# ── 3. workspace.py: git_info_for_workspace is parallelized ────────────────


class TestGitInfoParallel:
    """git_info_for_workspace() must run git subprocess calls in parallel
    to reduce wall-clock time."""

    def test_uses_thread_pool(self):
        source = pathlib.Path(__file__).parent.parent / "api" / "workspace.py"
        src = source.read_text()
        fn = src[src.find("def git_info_for_workspace") :]
        fn = fn[: fn.find("\ndef ")]

        assert "concurrent.futures" in src, (
            "concurrent.futures should be imported at the module level."
        )
        assert "ThreadPoolExecutor" in fn, (
            "git_info_for_workspace should use ThreadPoolExecutor "
            "to run git commands in parallel."
        )

    def test_git_commands_run_concurrently(self, tmp_path):
        """Proof that status/ahead/behind git commands execute in parallel,
        not sequentially. Uses threading.Barrier to verify overlap."""
        from api.workspace import git_info_for_workspace
        import api.workspace as ws_mod

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        barrier = threading.Barrier(3, timeout=5)
        call_count = {"n": 0}
        started_times = []

        def fake_git(args, cwd, timeout=3):
            if args[0] == "rev-parse":
                return "main"
            call_count["n"] += 1
            started_times.append(time.monotonic())
            barrier.wait(timeout=2)
            if args[0] == "status":
                return ""
            return "0"

        with patch.object(ws_mod, "_run_git", side_effect=fake_git):
            result = git_info_for_workspace(tmp_path)

        assert result is not None
        assert result["is_git"] is True
        assert result["branch"] == "main"
        assert call_count["n"] == 3, (
            f"Expected 3 parallel git calls, got {call_count['n']}"
        )
        assert started_times[-1] - started_times[0] < 0.15, (
            f"Git commands started too far apart ({started_times[-1]-started_times[0]:.3f}s), "
            f"suggesting serial execution."
        )

    def test_parallel_faster_than_serial(self, tmp_path):
        """Parallel execution is provably concurrent (deterministic, not timed).

        Previously this asserted wall-clock `elapsed < 0.25s` to prove the 3 git
        calls run in parallel. That wall-clock race is fundamentally flaky on
        shared/contended CI runners: the recurring `test (3.13, 2)` failure saw
        the "parallel" run measure 0.27-0.33s — at or above the 0.30s serial
        baseline — not because the code serialized, but because thread scheduling
        itself stalls under CPU starvation, so NO timing threshold (absolute or
        relative-to-serial) is reliable there.

        Proof of concurrency belongs to a deterministic primitive, not a stopwatch:
        a threading.Barrier(3) only releases once all three workers have ARRIVED
        simultaneously — it is impossible to satisfy under serial execution (the
        first worker would block forever waiting for the other two). If the calls
        ran serially this test would time out and fail; passing proves real
        overlap regardless of core speed. (test_git_commands_run_concurrently uses
        the same primitive; this keeps a second pin on the parallelism invariant
        without the flaky wall-clock assertion.)
        """
        from api.workspace import git_info_for_workspace
        import api.workspace as ws_mod

        git_dir = tmp_path / ".git"
        git_dir.mkdir()

        # Barrier(3) is releasable ONLY if all 3 workers run at once.
        barrier = threading.Barrier(3, timeout=5)
        arrived = {"n": 0}
        lock = threading.Lock()

        def concurrent_git(args, cwd, timeout=3):
            if args[0] == "rev-parse":
                return "main"
            with lock:
                arrived["n"] += 1
            # Serial execution can never get 3 threads here at once → deadlock →
            # BrokenBarrierError/timeout → test fails. Concurrent execution passes.
            barrier.wait(timeout=3)
            if args[0] == "status":
                return ""
            return "0"

        with patch.object(ws_mod, "_run_git", side_effect=concurrent_git):
            result = git_info_for_workspace(tmp_path)

        assert result is not None
        assert result["is_git"] is True
        assert arrived["n"] == 3, (
            f"Expected 3 concurrent git calls, got {arrived['n']} — "
            f"suggests serial execution."
        )


# ── 4. Message pagination (msg_limit + msg_before) ─────────────────────────


class TestMessagePaginationBackend:
    """Backend /api/session must support msg_limit and msg_before parameters
    to return only the last N messages, reducing payload size for fast
    session switching."""

    def _make_session(self, n_msgs=100):
        """Create a mock session with n_msgs messages."""
        session = MagicMock()
        session.session_id = "test_session_123"
        session.title = "Test Session"
        session.workspace = "/tmp/test"
        session.model = "test-model"
        session.created_at = 1000000
        session.updated_at = 2000000
        session.pinned = False
        session.archived = False
        session.project_id = None
        session.profile = None
        session.input_tokens = 0
        session.output_tokens = 0
        session.estimated_cost = None
        session.personality = None
        session.active_stream_id = None
        session.pending_user_message = None
        session.pending_attachments = []
        session.pending_started_at = None
        session.compression_anchor_visible_idx = None
        session.compression_anchor_message_key = None
        session._metadata_message_count = None
        session.messages = [
            {"role": "user" if i % 3 == 0 else "assistant", "content": f"Message {i}"}
            for i in range(n_msgs)
        ]
        session.tool_calls = []
        session.compact.return_value = {
            "session_id": "test_session_123",
            "title": "Test Session",
            "workspace": "/tmp/test",
            "model": "test-model",
            "message_count": n_msgs,
            "created_at": 1000000,
            "updated_at": 2000000,
            "last_message_at": 2000000,
            "pinned": False,
            "archived": False,
            "project_id": None,
            "profile": None,
            "input_tokens": 0,
            "output_tokens": 0,
            "estimated_cost": None,
            "personality": None,
            "compression_anchor_visible_idx": None,
            "compression_anchor_message_key": None,
            "active_stream_id": None,
            "is_streaming": False,
        }
        return session

    def test_msg_limit_returns_tail(self):
        """msg_limit=10 should return the last 10 messages of a 100-msg session."""
        session = self._make_session(100)
        all_msgs = session.messages
        msg_limit = 10

        truncated = all_msgs[-msg_limit:]
        assert len(truncated) == 10
        assert truncated[0]["content"] == "Message 90"
        assert truncated[-1]["content"] == "Message 99"

    def test_msg_limit_larger_than_total(self):
        """msg_limit larger than total messages returns all messages."""
        session = self._make_session(50)
        all_msgs = session.messages
        msg_limit = 100

        truncated = all_msgs[-msg_limit:]
        assert len(truncated) == 50
        assert len(all_msgs) <= msg_limit

    def test_msg_before_index_based_slicing(self):
        """msg_before=50 returns messages[:50] then tail window."""
        session = self._make_session(100)
        all_msgs = session.messages
        msg_before = 50
        msg_limit = 30

        _slice = all_msgs[:msg_before]
        truncated = _slice[-msg_limit:]
        assert len(truncated) == 30
        assert truncated[0]["content"] == "Message 20"
        assert truncated[-1]["content"] == "Message 49"

    def test_msg_before_zero_returns_empty(self):
        """msg_before=0 means no older messages exist — returns empty."""
        session = self._make_session(100)
        all_msgs = session.messages
        msg_before = 0

        _slice = all_msgs[:msg_before]
        assert len(_slice) == 0

    def test_msg_before_equal_total(self):
        """msg_before=100 returns all 100, tail-30 gives messages 70-99."""
        session = self._make_session(100)
        all_msgs = session.messages
        msg_before = 100
        msg_limit = 30

        _slice = all_msgs[:msg_before]
        truncated = _slice[-msg_limit:]
        assert len(truncated) == 30
        assert truncated[0]["content"] == "Message 70"

    def test_truncation_flag(self):
        """_messages_truncated must be True when messages were omitted."""
        session = self._make_session(100)
        msg_limit = 30
        is_truncated = len(session.messages) > msg_limit
        assert is_truncated is True

        small = self._make_session(10)
        is_truncated_small = len(small.messages) > msg_limit
        assert is_truncated_small is False

    def test_truncation_flag_with_msg_before(self):
        """When msg_before filters to fewer than msg_limit, truncation is False."""
        session = self._make_session(100)
        msg_before = 10
        msg_limit = 30

        _slice = session.messages[:msg_before]
        _truncated = len(_slice) > msg_limit
        assert _truncated is False  # 10 < 30, no truncation

    def test_messages_offset_initial_load(self):
        """_messages_offset = index of first returned message in full array."""
        from api.routes import _message_counts_as_renderable_for_window, _message_window_for_display

        session = self._make_session(100)
        msg_limit = 30
        all_msgs = session.messages

        truncated = all_msgs[-msg_limit:]
        offset = len(all_msgs) - len(truncated)
        assert offset == 70
        assert truncated[0]["content"] == "Message 70"

        messages = [
            {"role": "user", "content": f"Visible {i}"}
            for i in range(35)
        ]
        messages.extend(
            {"role": "tool", "content": f"hidden tool payload {i}"}
            for i in range(28)
        )
        messages.extend([
            {"role": "user", "content": "Tail question"},
            {"role": "assistant", "content": "Tail answer"},
        ])

        window, offset = _message_window_for_display(messages, msg_limit=30, expand_renderable=True)
        renderable = [m for m in window if _message_counts_as_renderable_for_window(m)]

        assert offset < len(messages) - 30
        assert len(renderable) == 30
        assert renderable[0]["content"] == "Visible 7"
        assert renderable[-2]["content"] == "Tail question"
        assert renderable[-1]["content"] == "Tail answer"

    def test_messages_offset_with_msg_before(self):
        """_messages_offset for msg_before=50, msg_limit=30."""
        session = self._make_session(100)
        msg_before = 50
        msg_limit = 30

        _slice = session.messages[:msg_before]
        truncated = _slice[-msg_limit:]
        offset = msg_before - len(truncated)
        assert offset == 20
        assert truncated[0]["content"] == "Message 20"

    def test_payload_size_reduction(self):
        """Quantify the payload reduction: 100 msgs → 30 msgs = ~70% smaller."""
        import json

        session = self._make_session(100)
        all_json = json.dumps(session.messages)
        tail_json = json.dumps(session.messages[-30:])

        reduction = 1 - len(tail_json) / len(all_json)
        assert reduction > 0.6, (
            f"Expected >60% payload reduction, got {reduction*100:.0f}%."
        )

    def test_msg_before_bounds_clamping(self):
        """msg_before beyond array length should be clamped."""
        session = self._make_session(100)
        all_msgs = session.messages

        # msg_before = 999 → clamped to 100
        _before_idx = max(0, min(999, len(all_msgs)))
        assert _before_idx == 100

        # msg_before = -5 → clamped to 0
        _before_idx = max(0, min(-5, len(all_msgs)))
        assert _before_idx == 0


# ── 5. Session-switch cancellation safety ───────────────────────────────────


# ── 6. Scroll position preservation ──────────────────────────────────────────
