"""
Regression test: /api/session/compress/status must not return 404.

Bug: switching sessions triggered resumeManualCompressionForSession(),
which called GET /api/session/compress/status. The route handler returned
None (from j()) instead of True, causing do_GET's fallback to emit
{"error":"not found"} 404 in edge cases. The frontend then showed
"Compression failed: not found" toast on every session switch.

Fix (two-part):
  1. Backend: handle_get now returns True after _handle_session_compress_status
  2. Frontend: resumeManualCompressionForSession catches 404 silently
"""

import io
import json
from pathlib import Path

from api.routes import _handle_session_compress_status, handle_get
from tests._pytest_port import BASE


# ---------------------------------------------------------------------------
# Reuse the _FakeHandler pattern from test_sprint46
# ---------------------------------------------------------------------------
class _FakeHandler:
    def __init__(self):
        self.wfile = io.BytesIO()
        self.status = None
        self.sent_headers = {}

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.sent_headers[key] = value

    def end_headers(self):
        pass

    def payload(self):
        return json.loads(self.wfile.getvalue().decode("utf-8"))


# ======== Backend tests ========


def test_compress_status_returns_200_idle_for_unknown_session():
    """The idle case (no active compression) must return 200, not 404."""
    handler = _FakeHandler()
    result = _handle_session_compress_status(handler, "nonexistent_session_xyz")
    body = handler.payload()

    assert handler.status == 200
    assert body["ok"] is True
    assert body["status"] == "idle"


def test_compress_status_returns_200_idle_for_empty_session_id():
    """Empty session_id should return 400 (bad), not 404."""
    handler = _FakeHandler()
    _handle_session_compress_status(handler, "")
    assert handler.status == 400


def test_handle_get_returns_true_for_compress_status():
    """handle_get must return True (not None/False) for compress/status.

    This is the core fix: previously it returned None (from j()), which
    only worked because 'None is False' is False. But in edge cases
    (stale process state, exception during response write) the fallback
    could produce a 404. Returning True is defensive.
    """
    from urllib.parse import urlparse

    handler = _FakeHandler()
    parsed = urlparse("/api/session/compress/status?session_id=test_resume_sid")
    result = handle_get(handler, parsed)

    assert result is True, f"handle_get returned {result!r}, expected True"
    assert handler.status == 200


def test_handle_get_returns_true_for_compress_status_no_sid():
    """Even with missing session_id, handle_get returns True (400 handled internally)."""
    from urllib.parse import urlparse

    handler = _FakeHandler()
    parsed = urlparse("/api/session/compress/status")
    result = handle_get(handler, parsed)

    assert result is True
    # _handle_session_compress_status should return 400 for empty sid
    assert handler.status == 400


# ======== Frontend static tests ========


def _read_commands_js():
    with open(
        Path(__file__).resolve().parents[1] / "static" / "commands.js",
        encoding="utf-8",
    ) as f:
        return f.read()
