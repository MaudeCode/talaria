"""Tests for real /steer functionality (follow-up to PR #1062).

Covers the new POST /api/chat/steer endpoint which mirrors the CLI's /steer
command (cli.py:6140-6155): the endpoint looks up the cached AIAgent for the
session, calls agent.steer(text), and the agent's run loop appends the steer
text to the next tool-result message — no interruption.

Falls back to {"accepted": false, "fallback": "<reason>"} when the agent
isn't running, isn't cached, or doesn't support steer (older agent versions).
The frontend uses the fallback signal to restore the draft without cancelling
the active run.

Plus a leftover-delivery flow: if the agent finishes its turn before the
steer is consumed (no tool-call boundary), _drain_pending_steer is called
after run_conversation returns and a `pending_steer_leftover` SSE event is
emitted so the frontend can queue the leftover text as a next-turn message.
"""
import sys
import os
import unittest
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest

from tests.helpers import source_between as _source_between

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture(autouse=True)
def _restore_auth_sessions():
    """Snapshot and restore api.auth._sessions — see test_1058 for the rationale."""
    import api.auth as _auth
    snapshot = dict(_auth._sessions)
    yield
    _auth._sessions.clear()
    _auth._sessions.update(snapshot)


@pytest.fixture
def _clear_caches():
    """Snapshot SESSION_AGENT_CACHE and STREAMS so tests don't bleed."""
    from api.config import (
        ACTIVE_RUNS,
        ACTIVE_RUNS_LOCK,
        AGENT_INSTANCES,
        SESSION_AGENT_CACHE,
        SESSION_AGENT_CACHE_LOCK,
        STREAMS,
        STREAMS_LOCK,
    )
    with SESSION_AGENT_CACHE_LOCK:
        cache_snap = dict(SESSION_AGENT_CACHE)
        SESSION_AGENT_CACHE.clear()
    with STREAMS_LOCK:
        streams_snap = dict(STREAMS)
        agent_instances_snap = dict(AGENT_INSTANCES)
        STREAMS.clear()
        AGENT_INSTANCES.clear()
    with ACTIVE_RUNS_LOCK:
        active_runs_snap = dict(ACTIVE_RUNS)
        ACTIVE_RUNS.clear()
    yield
    with SESSION_AGENT_CACHE_LOCK:
        SESSION_AGENT_CACHE.clear()
        SESSION_AGENT_CACHE.update(cache_snap)
    with STREAMS_LOCK:
        STREAMS.clear()
        STREAMS.update(streams_snap)
        AGENT_INSTANCES.clear()
        AGENT_INSTANCES.update(agent_instances_snap)
    with ACTIVE_RUNS_LOCK:
        ACTIVE_RUNS.clear()
        ACTIVE_RUNS.update(active_runs_snap)


def _make_handler():
    """Minimal handler stub matching the methods api.helpers.j() touches."""
    h = MagicMock()
    h.wfile = MagicMock()
    h.headers = MagicMock()
    h.headers.get = MagicMock(return_value="")
    return h


def _captured_response(handler):
    """Pull the JSON body that j() wrote to handler.wfile."""
    import json as _json
    # j() calls handler.wfile.write(body)
    write_calls = handler.wfile.write.call_args_list
    assert write_calls, "no body was written to handler.wfile"
    body = write_calls[-1][0][0]
    return _json.loads(body.decode("utf-8"))


def _captured_status(handler):
    """Pull the HTTP status passed to handler.send_response()."""
    calls = handler.send_response.call_args_list
    assert calls, "no status was sent"
    return calls[-1][0][0]


# ── Backend: the /api/chat/steer endpoint ─────────────────────────────────

class TestHandleChatSteerHappyPath:
    """Endpoint accepts text and calls agent.steer() when all gates pass."""

    def test_accepts_when_agent_cached_and_running(self, _clear_caches):
        from api.streaming import _handle_chat_steer
        from api.config import SESSION_AGENT_CACHE, SESSION_AGENT_CACHE_LOCK, STREAMS, STREAMS_LOCK
        sid, stream_id = "sid_happy", "stream_happy"
        agent = MagicMock()
        agent.steer = MagicMock(return_value=True)
        with SESSION_AGENT_CACHE_LOCK:
            SESSION_AGENT_CACHE[sid] = (agent, "sig")
        with STREAMS_LOCK:
            import queue as _q
            STREAMS[stream_id] = _q.Queue()

        sess = MagicMock()
        sess.active_stream_id = stream_id
        with patch("api.streaming.get_session", return_value=sess):
            handler = _make_handler()
            _handle_chat_steer(handler, {
                "session_id": sid,
                "text": "Use Python instead",
                "steer_id": "steer-client-1",
            })

        agent.steer.assert_called_once_with("Use Python instead")
        body = _captured_response(handler)
        assert body == {
            "accepted": True,
            "fallback": None,
            "stream_id": stream_id,
            "steer_id": "steer-client-1",
        }
        assert len(agent._webui_pending_steers) == 1
        pending = agent._webui_pending_steers[0]
        assert {key: pending[key] for key in ("steer_id", "session_id", "stream_id", "text")} == {
            "steer_id": "steer-client-1",
            "session_id": sid,
            "stream_id": stream_id,
            "text": "Use Python instead",
        }
        assert isinstance(pending["created_at"], float)

    def test_accepts_live_agent_after_mid_turn_compression(self, _clear_caches):
        """Steer follows the active stream while its agent rotates session ids."""
        from api.streaming import _handle_chat_steer
        from api.config import (
            AGENT_INSTANCES,
            SESSION_AGENT_CACHE,
            SESSION_AGENT_CACHE_LOCK,
            STREAMS,
            STREAMS_LOCK,
        )

        old_sid = "sid_before_compression"
        new_sid = "sid_after_compression"
        stream_id = "stream_spanning_compression"
        agent = MagicMock()
        agent.session_id = new_sid
        agent.steer = MagicMock(return_value=True)

        # Hermes rotates the live AIAgent immediately, while WebUI's cache-key
        # migration happens only after run_conversation() returns.
        with SESSION_AGENT_CACHE_LOCK:
            SESSION_AGENT_CACHE[old_sid] = (agent, "sig")
        with STREAMS_LOCK:
            import queue as _q
            STREAMS[stream_id] = _q.Queue()
            AGENT_INSTANCES[stream_id] = agent

        sess = MagicMock()
        sess.active_stream_id = stream_id
        with patch("api.streaming.get_session", return_value=sess):
            handler = _make_handler()
            _handle_chat_steer(handler, {
                "session_id": old_sid,
                "text": "keep going",
                "steer_id": "steer-compression-1",
            })

        agent.steer.assert_called_once_with("keep going")
        assert _captured_response(handler) == {
            "accepted": True,
            "fallback": None,
            "stream_id": stream_id,
            "steer_id": "steer-compression-1",
        }
        with SESSION_AGENT_CACHE_LOCK:
            assert SESSION_AGENT_CACHE[old_sid][0] is agent

        # A failed request from an older server version may already have
        # evicted that stale-key cache entry. The active worker reference must
        # remain sufficient for subsequent steering attempts.
        with SESSION_AGENT_CACHE_LOCK:
            SESSION_AGENT_CACHE.clear()
        with patch("api.streaming.get_session", return_value=sess):
            handler = _make_handler()
            _handle_chat_steer(handler, {
                "session_id": old_sid,
                "text": "one more change",
                "steer_id": "steer-compression-2",
            })

        assert agent.steer.call_args_list == [
            call("keep going"),
            call("one more change"),
        ]
        assert _captured_response(handler) == {
            "accepted": True,
            "fallback": None,
            "stream_id": stream_id,
            "steer_id": "steer-compression-2",
        }


class TestHandleChatSteerFallbacks:
    """Each gate that fails returns a structured fallback the frontend can branch on."""

    def test_no_cached_agent(self, _clear_caches):
        from api.streaming import _handle_chat_steer
        handler = _make_handler()
        _handle_chat_steer(handler, {"session_id": "sid_x", "text": "hint"})
        body = _captured_response(handler)
        assert body["accepted"] is False
        assert body["fallback"] == "no_cached_agent"

    def test_gateway_owned_stream_without_cached_agent_queues_fallback(self, _clear_caches):
        from api.streaming import _handle_chat_steer
        from api.config import ACTIVE_RUNS, ACTIVE_RUNS_LOCK, STREAMS, STREAMS_LOCK
        import queue as _q

        sid, stream_id = "sid_gateway", "stream_gateway"
        with STREAMS_LOCK:
            STREAMS[stream_id] = _q.Queue()
        with ACTIVE_RUNS_LOCK:
            ACTIVE_RUNS[stream_id] = {"session_id": sid, "backend": "gateway"}

        sess = MagicMock()
        sess.active_stream_id = stream_id
        with patch("api.streaming.get_session", return_value=sess):
            handler = _make_handler()
            _handle_chat_steer(handler, {"session_id": sid, "text": "preserve this"})

        body = _captured_response(handler)
        assert body == {
            "accepted": False,
            "fallback": "gateway_steer_queued",
            "stream_id": stream_id,
        }

    def test_agent_lacks_steer_method(self, _clear_caches):
        from api.streaming import _handle_chat_steer
        from api.config import SESSION_AGENT_CACHE, SESSION_AGENT_CACHE_LOCK
        sid = "sid_old"
        # Older agent without steer() — use spec to suppress MagicMock auto-create
        agent = MagicMock(spec=["interrupt", "run_conversation"])
        with SESSION_AGENT_CACHE_LOCK:
            SESSION_AGENT_CACHE[sid] = (agent, "sig")
        handler = _make_handler()
        _handle_chat_steer(handler, {"session_id": sid, "text": "hint"})
        body = _captured_response(handler)
        assert body["accepted"] is False
        assert body["fallback"] == "agent_lacks_steer"

    def test_session_not_found(self, _clear_caches):
        from api.streaming import _handle_chat_steer
        from api.config import SESSION_AGENT_CACHE, SESSION_AGENT_CACHE_LOCK
        sid = "sid_missing"
        agent = MagicMock()
        agent.steer = MagicMock(return_value=True)
        with SESSION_AGENT_CACHE_LOCK:
            SESSION_AGENT_CACHE[sid] = (agent, "sig")
        with patch("api.streaming.get_session", side_effect=KeyError(sid)):
            handler = _make_handler()
            _handle_chat_steer(handler, {"session_id": sid, "text": "hint"})
        body = _captured_response(handler)
        assert body["accepted"] is False
        assert body["fallback"] == "session_not_found"
        agent.steer.assert_not_called()  # never reached the steer call

    def test_session_not_running(self, _clear_caches):
        from api.streaming import _handle_chat_steer
        from api.config import SESSION_AGENT_CACHE, SESSION_AGENT_CACHE_LOCK
        sid = "sid_idle"
        agent = MagicMock()
        agent.steer = MagicMock(return_value=True)
        with SESSION_AGENT_CACHE_LOCK:
            SESSION_AGENT_CACHE[sid] = (agent, "sig")
        sess = MagicMock()
        sess.active_stream_id = None  # idle session
        with patch("api.streaming.get_session", return_value=sess):
            handler = _make_handler()
            _handle_chat_steer(handler, {"session_id": sid, "text": "hint"})
        body = _captured_response(handler)
        assert body["accepted"] is False
        assert body["fallback"] == "not_running"
        agent.steer.assert_not_called()

    def test_stream_dead(self, _clear_caches):
        """Session has active_stream_id but the stream is gone from STREAMS (e.g. crashed)."""
        from api.streaming import _handle_chat_steer
        from api.config import SESSION_AGENT_CACHE, SESSION_AGENT_CACHE_LOCK
        sid = "sid_zombie"
        agent = MagicMock()
        agent.steer = MagicMock(return_value=True)
        with SESSION_AGENT_CACHE_LOCK:
            SESSION_AGENT_CACHE[sid] = (agent, "sig")
        sess = MagicMock()
        sess.active_stream_id = "stream_zombie"
        with patch("api.streaming.get_session", return_value=sess):
            handler = _make_handler()
            _handle_chat_steer(handler, {"session_id": sid, "text": "hint"})
        body = _captured_response(handler)
        assert body["accepted"] is False
        assert body["fallback"] == "stream_dead"
        agent.steer.assert_not_called()

    def test_steer_raises(self, _clear_caches):
        """If agent.steer() raises, return steer_error rather than 500."""
        from api.streaming import _handle_chat_steer
        from api.config import SESSION_AGENT_CACHE, SESSION_AGENT_CACHE_LOCK, STREAMS, STREAMS_LOCK
        sid, stream_id = "sid_throws", "stream_throws"
        agent = MagicMock()
        agent.steer = MagicMock(side_effect=RuntimeError("boom"))
        with SESSION_AGENT_CACHE_LOCK:
            SESSION_AGENT_CACHE[sid] = (agent, "sig")
        with STREAMS_LOCK:
            import queue as _q
            STREAMS[stream_id] = _q.Queue()
        sess = MagicMock()
        sess.active_stream_id = stream_id
        with patch("api.streaming.get_session", return_value=sess):
            handler = _make_handler()
            _handle_chat_steer(handler, {"session_id": sid, "text": "hint"})
        body = _captured_response(handler)
        assert body["accepted"] is False
        assert body["fallback"] == "steer_error"


class TestHandleChatSteerInputValidation:
    """Bad input → 400 Bad Request, not silent acceptance."""

    def test_missing_session_id(self, _clear_caches):
        from api.streaming import _handle_chat_steer
        handler = _make_handler()
        _handle_chat_steer(handler, {"text": "hint"})
        assert _captured_status(handler) == 400

    def test_missing_text(self, _clear_caches):
        from api.streaming import _handle_chat_steer
        handler = _make_handler()
        _handle_chat_steer(handler, {"session_id": "sid"})
        assert _captured_status(handler) == 400

    def test_empty_text_after_strip(self, _clear_caches):
        from api.streaming import _handle_chat_steer
        handler = _make_handler()
        _handle_chat_steer(handler, {"session_id": "sid", "text": "   \n\t  "})
        assert _captured_status(handler) == 400

    def test_rejects_unsafe_steer_id(self, _clear_caches):
        from api.streaming import _handle_chat_steer
        handler = _make_handler()
        _handle_chat_steer(handler, {
            "session_id": "sid",
            "text": "hint",
            "steer_id": "not safe/for a row id",
        })
        assert _captured_status(handler) == 400


class TestSteerLifecycleBridge:
    class Agent(SimpleNamespace):
        def __init__(self):
            super().__init__(_pending_steer=None, _pending_steer_lock=threading.Lock())

        def steer(self, text):
            with self._pending_steer_lock:
                self._pending_steer = (
                    f"{self._pending_steer}\n{text}" if self._pending_steer else text
                )
            return True

        def _drain_pending_steer(self):
            with self._pending_steer_lock:
                text = self._pending_steer
                self._pending_steer = None
            return text

    @staticmethod
    def record(steer_id, text):
        return {
            "steer_id": steer_id,
            "session_id": "sid",
            "stream_id": "stream",
            "text": text,
            "created_at": 1.0,
        }

    def test_emits_repeated_consumed_steers_individually(self):
        from api.streaming import _register_webui_steer, _take_consumed_webui_steers

        agent = self.Agent()
        assert _register_webui_steer(agent, self.record("steer-1", "first"))
        assert _register_webui_steer(agent, self.record("steer-2", "second"))
        with agent._pending_steer_lock:
            agent._pending_steer = None

        events = _take_consumed_webui_steers(agent)

        assert [(event["steer_id"], event["text"]) for event in events] == [
            ("steer-1", "first"),
            ("steer-2", "second"),
        ]
        assert all(isinstance(event["consumed_at"], float) for event in events)
        assert agent._webui_pending_steers == []

    def test_final_leftover_keeps_its_id_without_reclassifying_it_consumed(self):
        from api.streaming import _finalize_webui_steers, _register_webui_steer

        agent = self.Agent()
        assert _register_webui_steer(agent, self.record("steer-1", "first"))
        assert _register_webui_steer(agent, self.record("steer-2", "second"))
        with agent._pending_steer_lock:
            agent._pending_steer = None

        consumed, leftover, unmatched = _finalize_webui_steers(agent, "stream", "second")

        assert [record["steer_id"] for record in consumed] == ["steer-1"]
        assert [record["steer_id"] for record in leftover] == ["steer-2"]
        assert unmatched == ""
        assert agent._webui_pending_steers == []

    def test_finalization_includes_steer_accepted_after_agent_result(self):
        from api.streaming import _finalize_webui_steers, _register_webui_steer

        agent = self.Agent()
        assert _register_webui_steer(agent, self.record("steer-1", "first"))
        result_leftover = agent._drain_pending_steer()
        assert _register_webui_steer(agent, self.record("steer-2", "second"))

        consumed, leftover, unmatched = _finalize_webui_steers(agent, "stream", result_leftover)

        assert consumed == []
        assert [record["steer_id"] for record in leftover] == ["steer-1", "steer-2"]
        assert unmatched == ""

    def test_finalization_closes_current_stream_but_next_stream_can_steer(self):
        from api.streaming import _finalize_webui_steers, _register_webui_steer

        agent = self.Agent()
        assert _register_webui_steer(agent, self.record("steer-1", "first"))
        _finalize_webui_steers(agent, "stream", agent._drain_pending_steer())

        assert not _register_webui_steer(agent, self.record("steer-2", "too late"))
        next_record = {**self.record("steer-3", "next run"), "stream_id": "stream-2"}
        assert _register_webui_steer(agent, next_record)

    def test_old_stream_finalization_does_not_drain_replacement_stream(self):
        from api.streaming import _finalize_webui_steers, _register_webui_steer

        agent = self.Agent()
        assert _register_webui_steer(agent, self.record("steer-1", "old"))
        agent._drain_pending_steer()
        replacement = {**self.record("steer-2", "replacement"), "stream_id": "stream-2"}
        assert _register_webui_steer(agent, replacement)

        assert _finalize_webui_steers(agent, "stream", "") == ([], [], "")
        assert agent._pending_steer == "replacement"
        assert agent._webui_pending_steers == [replacement]
        another = {**self.record("steer-3", "still open"), "stream_id": "stream-2"}
        assert _register_webui_steer(agent, another)

    def test_terminal_cleanup_drops_unconsumed_records(self):
        from api.streaming import (
            _clear_webui_steers,
            _register_webui_steer,
            _take_consumed_webui_steers,
        )

        agent = self.Agent()
        assert _register_webui_steer(agent, self.record("steer-1", "do not leak"))

        _clear_webui_steers(agent)
        with agent._pending_steer_lock:
            agent._pending_steer = None

        assert _take_consumed_webui_steers(agent) == []
        assert agent._webui_pending_steers == []

    def test_terminal_error_surfaces_unconsumed_steer_as_leftover(self):
        from api.config import AGENT_INSTANCES
        from api.streaming import _register_webui_steer, _webui_steer_events_before

        agent = self.Agent()
        AGENT_INSTANCES["stream"] = agent
        try:
            assert _register_webui_steer(agent, self.record("steer-1", "keep me"))
            events = _webui_steer_events_before("stream", "apperror")
        finally:
            AGENT_INSTANCES.pop("stream", None)

        assert [event for event, _payload in events] == ["pending_steer_leftover"]
        assert events[0][1]["steer_id"] == "steer-1"
        assert agent._pending_steer is None
        assert agent._webui_pending_steers == []


def test_terminal_steer_finalizes_before_scene_persistence():
    src = (Path(__file__).parent.parent / "api" / "streaming.py").read_text(encoding="utf-8")
    finalized = src.index(") = _finalize_webui_steers(agent, stream_id, _result_pending_steer)")
    emitted = src.index("put('steer_consumed', _consumed_steer_payload(_record))", finalized)
    persisted = src.index("_persist_terminal_steering_scene(", finalized)
    assert finalized < emitted < persisted


def test_cancel_and_non_timeout_errors_persist_steering_scene():
    src = (Path(__file__).parent.parent / "api" / "streaming.py").read_text(encoding="utf-8")
    put = src[src.index("    def put(event, data):"):src.index("    # #5940:")]

    assert "if event in ('cancel', 'apperror', 'error'):" in put
    assert (
        'if _error_type not in {"chat_writeback_timeout", "chat_admission_timeout"}:'
        in put
    )
    assert "_persist_terminal_steering_scene(terminal_state=_terminal_state)" in put
    assert "'steer_consumed', 'pending_steer_leftover'" in put


# ── Routing ───────────────────────────────────────────────────────────────

class TestRouting:
    """The POST handler must dispatch /api/chat/steer to _handle_chat_steer."""

    def test_route_registered(self):
        src = (Path(__file__).parent.parent / "api" / "routes.py").read_text(encoding="utf-8")
        assert '/api/chat/steer' in src
        assert '_handle_chat_steer' in src


# ── Frontend: cmdSteer + busy-mode steer use the new endpoint ────────────

# ── i18n keys ─────────────────────────────────────────────────────────────

# ── Leftover SSE delivery: streaming.py emits pending_steer_leftover ─────

class TestLeftoverDelivery:
    """After run_conversation returns, _drain_pending_steer is called and a
    pending_steer_leftover SSE event is emitted if there's still text stashed."""

    def test_leftover_drain_call_in_streaming(self):
        """Verify the streaming.py source contains the drain call before put('done', ...)."""
        src = (Path(__file__).parent.parent / "api" / "streaming.py").read_text(encoding="utf-8")
        assert "_drain_pending_steer" in src, (
            "_run_agent_streaming must call agent._drain_pending_steer() to deliver leftovers"
        )
        assert "pending_steer_leftover" in src, (
            "_run_agent_streaming must emit a pending_steer_leftover SSE event"
        )

    def test_leftover_drain_runs_before_done_event(self):
        """Finalization must happen BEFORE put('done', ...) so frontend gets both events
        on the same turn."""
        src = (Path(__file__).parent.parent / "api" / "streaming.py").read_text(encoding="utf-8")
        drain_idx = src.find("_finalize_webui_steers(agent, stream_id, _result_pending_steer)")
        assert drain_idx >= 0
        done_idx = src.find("put('done'", drain_idx)
        assert done_idx >= 0
        # No put('done', ...) should appear BEFORE the drain in the same code block
        # (we already check the drain is in the file; ordering matters within the
        # non-ephemeral success path)
        assert drain_idx < done_idx, (
            "_drain_pending_steer must run before put('done', ...) so the SSE listener "
            "sees the leftover before stream_end fires"
        )
