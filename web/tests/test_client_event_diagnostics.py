"""Regression coverage for browser-side SSE disconnect diagnostics.

When an EventSource fails in the browser, the server normally only sees a dead
socket or follow-up probe. Persisting a small, sanitized client event makes the
next incident diagnosable without logging prompt text or credentials.
"""
from pathlib import Path
from io import BytesIO
from types import SimpleNamespace

import api.routes as routes


REPO = Path(__file__).resolve().parents[1]
def test_client_event_log_sanitizes_and_whitelists_fields():
    payload = {
        "event": "sse_error",
        "source": "gateway-sessions",
        "session_id": "abc123",
        "stream_id": "stream456",
        "ready_state": 2,
        "visibility_state": "hidden",
        "online": True,
        "url_path": "/chat/abc123?debug=1",
        "reason": "onerror",
        "password": "must-not-survive",
        "content": "prompt text must not survive",
        "cookie": "session=secret",
    }

    sanitized = routes._sanitize_client_event_payload(payload)

    assert sanitized == {
        "event": "sse_error",
        "source": "gateway-sessions",
        "session_id": "abc123",
        "stream_id": "stream456",
        "ready_state": 2,
        "visibility_state": "hidden",
        "online": True,
        "url_path": "/chat/abc123",
        "reason": "onerror",
    }
    assert "secret" not in repr(sanitized)
    assert "prompt text" not in repr(sanitized)


def test_client_event_log_bounds_untrusted_values():
    payload = {
        "event": "x" * 200,
        "source": "chat" * 100,
        "session_id": "s" * 200,
        "stream_id": "t" * 200,
        "ready_state": "not-a-number",
        "visibility_state": "visible" * 40,
        "online": "yes",
        "url_path": "https://example.invalid/path?debug=1",
        "reason": "network" * 80,
    }

    sanitized = routes._sanitize_client_event_payload(payload)

    assert sanitized["event"] == "x" * 64
    assert len(sanitized["source"]) == 80
    assert len(sanitized["session_id"]) == 128
    assert len(sanitized["stream_id"]) == 128
    assert "ready_state" not in sanitized
    assert sanitized["visibility_state"] == ("visible" * 40)[:32]
    assert sanitized["online"] is True
    assert sanitized["url_path"] == "/path"
    assert len(sanitized["reason"]) == 160


def test_client_event_log_route_is_wired(monkeypatch):
    captured = {}

    body_bytes = b'{"event":"sse_error","source":"chat-response"}'

    def fake_handle(handler, body):
        captured["body"] = body
        return True

    monkeypatch.setattr(routes, "_check_csrf", lambda handler: True)
    monkeypatch.setattr(routes, "_handle_client_event_log", fake_handle)

    handler = SimpleNamespace(headers={"Content-Length": str(len(body_bytes))}, rfile=BytesIO(body_bytes))
    handled = routes.handle_post(handler, SimpleNamespace(path="/api/client-events/log"))

    assert handled is True
    assert captured["body"] == {"event": "sse_error", "source": "chat-response"}


def test_client_event_log_has_endpoint_specific_body_cap():
    too_large = b"{" + b"x" * (routes._CLIENT_EVENT_MAX_BODY_BYTES + 32) + b"}"
    handler = SimpleNamespace(
        headers={"Content-Length": str(len(too_large))},
        rfile=BytesIO(too_large),
        close_connection=False,
    )

    payload = routes._read_client_event_payload(handler)

    assert payload == {"event": "discarded", "reason": "body_too_large"}
    assert handler.rfile.tell() == routes._CLIENT_EVENT_MAX_BODY_BYTES
    assert handler.close_connection is True


def test_client_event_log_rate_limits_per_client(monkeypatch):
    routes._CLIENT_EVENT_RATE_LIMIT.clear()
    monkeypatch.setattr(routes, "j", lambda handler, payload, status=200: payload.update({"status": status}) or True)
    handler = SimpleNamespace(client_address=("203.0.113.10", 1234))

    for i in range(routes._CLIENT_EVENT_RATE_LIMIT_MAX):
        assert routes._handle_client_event_log(handler, {"event": f"sse_error_{i}"}) is True

    limited = {}
    monkeypatch.setattr(routes, "j", lambda handler, payload, status=200: limited.update(payload, status=status) or True)
    assert routes._handle_client_event_log(handler, {"event": "sse_error_over_limit"}) is True

    assert limited == {"ok": False, "error": "rate_limited", "status": 429}
    routes._CLIENT_EVENT_RATE_LIMIT.clear()
