from __future__ import annotations

import json
import queue
from pathlib import Path

import pytest

from api import routes

ROOT = Path(__file__).resolve().parents[1]
# ── server: the merged endpoint ─────────────────────────────────────────────


class _Wfile:
    """Collects SSE bytes and hangs up once the handler has written enough.

    The handler loops until the client disconnects, so the disconnect is how a
    test ends it — `_CLIENT_DISCONNECT_ERRORS` is exactly what a real dropped
    browser connection raises.
    """

    def __init__(self, stop_after: int):
        self.chunks: list[bytes] = []
        self._stop_after = stop_after

    def write(self, data: bytes):
        self.chunks.append(data)
        if len(self.chunks) >= self._stop_after:
            raise BrokenPipeError("test client hung up")

    def flush(self):
        pass


class _Handler:
    def __init__(self, stop_after: int):
        self.wfile = _Wfile(stop_after)


class _FakeWatcher:
    """Stands in for GatewayWatcher: hands out a pre-filled subscriber queue."""

    def __init__(self, events, alive=True):
        self._q: queue.Queue = queue.Queue()
        for event in events:
            self._q.put(event)
        self._alive = alive
        self.unsubscribed: list[queue.Queue] = []

    def is_alive(self):
        return self._alive

    def subscribe(self):
        return self._q

    def unsubscribe(self, q):
        self.unsubscribed.append(q)


def _parse_frames(chunks):
    """Return [(event_name, payload_or_None)] from raw SSE bytes."""
    frames = []
    for raw in b"".join(chunks).decode("utf-8").split("\n\n"):
        if not raw.strip():
            continue
        if raw.startswith(":"):
            frames.append(("keepalive", None))
            continue
        event = None
        data = None
        for line in raw.split("\n"):
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        frames.append((event or "message", data))
    return frames


@pytest.fixture
def merged_sse(monkeypatch):
    """Drive `_handle_session_events_stream` with both producers stubbed out."""

    def run(*, query, session_events=(), gateway_events=(), watcher_alive=True,
            show_cli_sessions=True, stop_after=6):
        session_q: queue.Queue = queue.Queue()
        for event in session_events:
            session_q.put(event)
        watcher = _FakeWatcher(gateway_events, alive=watcher_alive)

        monkeypatch.setattr(routes, "start_sse_response", lambda handler, **kw: True)
        monkeypatch.setattr(routes, "_sse_set_write_deadline", lambda handler: None)
        monkeypatch.setattr(routes, "subscribe_session_events", lambda: session_q)
        monkeypatch.setattr(routes, "unsubscribe_session_events", lambda q: None)
        monkeypatch.setattr(
            routes, "load_settings", lambda *a, **kw: {"show_cli_sessions": show_cli_sessions}
        )
        monkeypatch.setattr("api.gateway_watcher.get_watcher", lambda *a, **kw: watcher)
        monkeypatch.setattr("api.models.get_cli_sessions", lambda *a, **kw: [{"session_id": "cli-1"}])
        # Keepalive cadence must not outlive the test.
        monkeypatch.setattr(routes, "_SSE_HEARTBEAT_INTERVAL_SECONDS", 0.05)

        handler = _Handler(stop_after)
        routes._handle_session_events_stream(handler, routes.urlsplit("/api/sessions/events" + query))
        return _parse_frames(handler.wfile.chunks), watcher

    return run


def test_merged_stream_carries_session_and_gateway_frames(merged_sse):
    """Both event kinds arrive on one connection, tagged by origin.

    This is the whole point of the merge: before it, the gateway payload only
    existed on `/api/sessions/gateway/stream`'s own socket.
    """
    frames, _watcher = merged_sse(
        query="?gateway=1",
        session_events=[{"type": "sessions_changed", "reason": "session_created", "profile": "default"}],
        gateway_events=[{"type": "sessions_changed", "sessions": [{"session_id": "cli-2"}]}],
    )
    by_stream = {(name, (data or {}).get("stream")) for name, data in frames}
    assert ("sessions_changed", "gateway") in by_stream
    assert ("sessions_changed", "sessions") in by_stream


def test_merged_stream_preserves_event_names_and_payload_shapes(merged_sse):
    """Names and payload keys are unchanged; `stream` is purely additive.

    Client handlers were written against these shapes on two endpoints, so the
    merge must not rename or restructure anything.
    """
    session_payload = {
        "type": "sessions_changed",
        "reason": "project_renamed",
        "profile": "work",
        "session_id": "abc",
        "version": 2,
    }
    gateway_payload = {"type": "sessions_changed", "sessions": [{"session_id": "cli-2", "updated_at": 7}]}
    frames, _watcher = merged_sse(
        query="?gateway=1",
        session_events=[session_payload],
        gateway_events=[gateway_payload],
    )
    got = {(data or {}).get("stream"): data for name, data in frames if name == "sessions_changed"}

    assert got["sessions"] == dict(session_payload, stream="sessions")
    assert got["gateway"] == dict(gateway_payload, stream="gateway")


def test_merged_stream_sends_initial_gateway_snapshot(merged_sse):
    """The gateway half opens with a snapshot, exactly as its own endpoint did."""
    frames, _watcher = merged_sse(query="?gateway=1")
    snapshots = [
        data for name, data in frames
        if name == "sessions_changed" and (data or {}).get("stream") == "gateway"
    ]
    assert snapshots and snapshots[0]["sessions"] == [{"session_id": "cli-1"}]


def test_gateway_half_is_opt_in(merged_sse):
    """Without ?gateway=1 the endpoint behaves exactly as it did before.

    Clients that subscribe to `/api/sessions/events` directly (and the
    standalone gateway endpoint they may also hold) must not start receiving
    gateway frames they never asked for.
    """
    frames, watcher = merged_sse(
        query="",
        session_events=[{"type": "sessions_changed", "reason": "session_created"}],
    )
    assert all((data or {}).get("stream") != "gateway" for _name, data in frames)
    assert all(name != "gateway_status" for name, _data in frames)


def test_unusable_gateway_reports_status_instead_of_failing_the_stream(merged_sse):
    """A dead watcher must not take the session-events half down with it.

    On the merged stream the client cannot learn about a broken gateway from
    `onerror` any more, so the server states it — that frame is what starts the
    30s poll fallback.
    """
    frames, _watcher = merged_sse(
        query="?gateway=1",
        watcher_alive=False,
        session_events=[{"type": "sessions_changed", "reason": "session_created"}],
    )
    statuses = [data for name, data in frames if name == "gateway_status"]
    assert statuses and statuses[0]["ok"] is False
    assert statuses[0]["watcher_running"] is False
    assert statuses[0]["fallback_poll_ms"]
    # The session-events half still delivers.
    assert any((data or {}).get("stream") == "sessions" for _name, data in frames)


def test_watcher_shutdown_ends_the_response_so_the_client_resubscribes(merged_sse):
    """The watcher's None sentinel must end the response, not downgrade in place.

    `restart_watcher_for_profile()` (another client's profile switch) stops the
    old watcher and starts a REPLACEMENT this connection is not subscribed to.
    Ending the response lets the browser's automatic EventSource reconnect pick
    up the live registry, which is what the standalone gateway stream did before
    the merge. Downgrading to the poll fallback instead would strand the tab at
    30s updates until some unrelated focus or panel event reconnected it.
    """
    frames, watcher = merged_sse(
        query="?gateway=1",
        gateway_events=[None],
        session_events=[{"type": "sessions_changed", "reason": "session_created"}],
        stop_after=99,  # the handler must stop on its own, not on a disconnect
    )
    # Nothing after the sentinel: no downgrade frame, no session frame.
    assert not [d for name, d in frames if name == "gateway_status" and d.get("ok") is False]
    assert not [d for _n, d in frames if (d or {}).get("stream") == "sessions"]
    assert watcher.unsubscribed, "the gateway queue must be released, not leaked"


def test_merged_stream_releases_both_subscriptions_on_disconnect(monkeypatch):
    """Neither producer may leak a queue when the browser hangs up."""
    released: list[str] = []
    session_q: queue.Queue = queue.Queue()
    session_q.put({"type": "sessions_changed", "reason": "session_created"})
    watcher = _FakeWatcher([])

    monkeypatch.setattr(routes, "start_sse_response", lambda handler, **kw: True)
    monkeypatch.setattr(routes, "_sse_set_write_deadline", lambda handler: None)
    monkeypatch.setattr(routes, "subscribe_session_events", lambda: session_q)
    monkeypatch.setattr(routes, "unsubscribe_session_events", lambda q: released.append("sessions"))
    monkeypatch.setattr(routes, "load_settings", lambda *a, **kw: {"show_cli_sessions": True})
    monkeypatch.setattr("api.gateway_watcher.get_watcher", lambda *a, **kw: watcher)
    monkeypatch.setattr("api.models.get_cli_sessions", lambda *a, **kw: [])

    handler = _Handler(stop_after=1)
    routes._handle_session_events_stream(handler, routes.urlsplit("/api/sessions/events?gateway=1"))

    assert released == ["sessions"]
    assert watcher.unsubscribed


def test_standalone_gateway_endpoint_still_routed():
    """Other clients (and the probe) keep their dedicated endpoint."""
    assert "if parsed.path == '/api/sessions/gateway/stream':" in routes_source()
    assert "return _handle_gateway_sse_stream(handler, parsed)" in routes_source()


def routes_source() -> str:
    return (ROOT / "api" / "routes.py").read_text(encoding="utf-8")


# ── client: the two-stream ceiling ──────────────────────────────────────────
