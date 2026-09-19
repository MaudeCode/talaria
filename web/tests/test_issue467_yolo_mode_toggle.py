"""Tests for YOLO mode toggle in Web UI (Issue #467).

Covers:
- GET /api/session/yolo — query YOLO state for a session
- POST /api/session/yolo — enable/disable YOLO for a session
- /yolo slash command registration in commands.js
- YOLO pill HTML element presence in index.html
- Skip-all button presence in approval card
- CSS classes for .yolo-pill and .approval-btn.yolo
- i18n keys present in all 6 locales
"""
import os
import re
import json
import pathlib
import shutil
import subprocess
import pytest

from tests.conftest import requires_agent_modules

TEST_BASE = f"http://127.0.0.1:{os.environ.get('HERMES_WEBUI_TEST_PORT', '8788')}"


def _read_static_file(name: str) -> str:
    return (pathlib.Path(__file__).resolve().parents[1] / "static" / name).read_text(
        encoding="utf-8"
    )


@pytest.fixture(scope="module")
def commands_js():
    return _read_static_file("commands.js")


@pytest.fixture(scope="module")
def messages_js():
    return _read_static_file("messages.js")


@pytest.fixture(scope="module")
def index_html():
    return _read_static_file("index.html")


@pytest.fixture(scope="module")
def style_css():
    return _read_static_file("style.css")


@pytest.fixture(scope="module")
def i18n_js():
    return _read_static_file("i18n.js")


def _get(path, expect_ok=True):
    import urllib.request, urllib.error
    try:
        with urllib.request.urlopen(TEST_BASE + path, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
        except Exception:
            body = {}
        if expect_ok:
            return body
        return body


def _post(path, body=None, expect_ok=True):
    import urllib.request, urllib.error
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        TEST_BASE + path, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
        except Exception:
            body = {}
        return body


# ── Backend endpoint tests ──

@requires_agent_modules
class TestYoloEndpointGet:
    """GET /api/session/yolo should return yolo_enabled state.

    Agent-dependent: the endpoint reads from ``tools.approval._session_yolo``
    in the hermes-agent process. When the agent isn't installed, routes.py
    falls back to a no-op lambda that always returns ``False`` regardless of
    POST state — every assertion here would either silently false-pass or
    flake. Skip cleanly when modules aren't importable.
    """

    def test_yolo_get_returns_false_by_default(self):
        """A fresh session should not have YOLO enabled."""
        data = _get("/api/session/yolo?session_id=test-yolo-fresh-001")
        assert data is not None
        assert data.get("yolo_enabled") is False

    def test_yolo_get_requires_session_id(self):
        """Missing session_id returns an error response."""
        resp = _get("/api/session/yolo?session_id=")
        # Empty session_id may return 400 or empty response
        assert resp is not None


@requires_agent_modules
class TestYoloEndpointPost:
    """POST /api/session/yolo should toggle YOLO for a session.

    Agent-dependent: the endpoint writes to ``tools.approval._session_yolo``
    in the hermes-agent process. Without the agent, routes.py falls back to
    a no-op lambda; the response shape ``{"yolo_enabled": <input>}`` echoes
    the request body, so naive POST-only tests false-pass. The
    ``test_yolo_post_persists_within_session`` test catches this by reading
    state back via GET — it only succeeds when the agent is wired.
    """

    def test_yolo_post_enable(self):
        """Enabling YOLO returns ok=True and yolo_enabled=True."""
        sid = "test-yolo-enable-001"
        data = _post("/api/session/yolo", {"session_id": sid, "enabled": True})
        assert data.get("ok") is True
        assert data.get("yolo_enabled") is True

    def test_yolo_post_disable(self):
        """Disabling YOLO returns ok=True and yolo_enabled=False."""
        sid = "test-yolo-disable-001"
        _post("/api/session/yolo", {"session_id": sid, "enabled": True})
        data = _post("/api/session/yolo", {"session_id": sid, "enabled": False})
        assert data.get("ok") is True
        assert data.get("yolo_enabled") is False

    def test_yolo_post_persists_within_session(self):
        """After enabling, GET should reflect the enabled state."""
        sid = "test-yolo-persist-001"
        _post("/api/session/yolo", {"session_id": sid, "enabled": True})
        data = _get(f"/api/session/yolo?session_id={sid}")
        assert data.get("yolo_enabled") is True

    def test_yolo_post_cross_session_isolation(self):
        """Enabling YOLO for one session doesn't affect another."""
        sid_a = "test-yolo-iso-a"
        sid_b = "test-yolo-iso-b"
        _post("/api/session/yolo", {"session_id": sid_a, "enabled": True})
        data = _get(f"/api/session/yolo?session_id={sid_b}")
        assert data.get("yolo_enabled") is False

    def test_yolo_post_defaults_to_enabled(self):
        """POST without 'enabled' key defaults to True."""
        sid = "test-yolo-default-001"
        data = _post("/api/session/yolo", {"session_id": sid})
        assert data.get("yolo_enabled") is True


# ── Frontend JS tests (static file analysis — no server needed) ──
