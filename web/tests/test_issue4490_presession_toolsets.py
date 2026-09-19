"""Regression tests for #4490 pre-session toolset staging."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from unittest.mock import patch

from api.models import new_session
from api.routes import handle_post

REPO = Path(__file__).resolve().parents[1]
def _function_body(src: str, signature: str) -> str:
    start = src.index(signature)
    brace = src.index("{", start)
    depth = 0
    for i in range(brace, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[start : i + 1]
    raise AssertionError(f"function body not found: {signature}")


class _DummyHandler:
    command = "POST"

    def __init__(self, body: dict):
        raw = json.dumps(body).encode("utf-8")
        self.headers = {"Content-Length": str(len(raw))}
        self.rfile = tempfile.SpooledTemporaryFile()
        self.rfile.write(raw)
        self.rfile.seek(0)
        self.status = None
        self.response = {}
        self.wfile = tempfile.SpooledTemporaryFile()
        self.client_address = ("127.0.0.1", 12345)

    def send_response(self, code: int):
        self.status = code

    def send_header(self, key: str, value: str):
        self.response.setdefault("headers", {})[key] = value

    def end_headers(self):
        pass

    def payload(self) -> dict:
        self.wfile.seek(0)
        return json.loads(self.wfile.read().decode("utf-8"))


def test_backend_new_session_accepts_enabled_toolsets():
    with tempfile.TemporaryDirectory() as tmp:
        session = new_session(workspace=tmp, enabled_toolsets=["filesystem", "shell"])

    assert session.enabled_toolsets == ["filesystem", "shell"]


def test_api_session_new_accepts_enabled_toolsets():
    with tempfile.TemporaryDirectory() as tmp, patch(
        "api.routes.get_last_workspace", return_value=tmp
    ):
        handler = _DummyHandler({"enabled_toolsets": ["filesystem", "shell"]})
        handle_post(handler, urlparse("/api/session/new"))

    payload = handler.payload()
    assert handler.status == 200
    assert payload["session"]["enabled_toolsets"] == ["filesystem", "shell"]


def test_api_session_new_rejects_malformed_enabled_toolsets():
    cases = [
        {"enabled_toolsets": []},
        {"enabled_toolsets": "filesystem"},
        {"enabled_toolsets": ["filesystem", ""]},
        {"enabled_toolsets": ["filesystem", 42]},
    ]
    with tempfile.TemporaryDirectory() as tmp, patch(
        "api.routes.get_last_workspace", return_value=tmp
    ):
        for body in cases:
            handler = _DummyHandler(body)
            handle_post(handler, urlparse("/api/session/new"))
            assert handler.status == 400
