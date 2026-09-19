import os
import pathlib
import io
import json
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest


REPO_ROOT = pathlib.Path(__file__).parent.parent.resolve()


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_terminal_routes_are_registered():
    routes = _read("api/routes.py")
    for path in (
        "/api/terminal/start",
        "/api/terminal/input",
        "/api/terminal/output",
        "/api/terminal/resize",
        "/api/terminal/close",
    ):
        assert path in routes


def test_terminal_process_does_not_mutate_global_terminal_cwd(tmp_path, monkeypatch):
    from api.terminal import close_terminal, start_terminal

    if os.name == "nt":
        pytest.skip("Embedded terminal PTY startup is not supported on Windows")

    monkeypatch.delenv("TERMINAL_CWD", raising=False)
    sid = "test-terminal-env"
    term = start_terminal(sid, tmp_path, rows=8, cols=40, restart=True)
    try:
        assert term.workspace == str(tmp_path.resolve())
        assert os.environ.get("TERMINAL_CWD") is None
    finally:
        close_terminal(sid)


def test_terminal_output_preserves_control_sequences_for_xterm():
    import codecs
    from api.terminal import _decode_terminal_output

    raw = "\x1b[?2004h$ \x1b[32mhello\x1b[0m\n"
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    assert _decode_terminal_output(decoder, raw.encode()) == raw


class _RouteHandler:
    def __init__(self):
        self.headers = {}
        # Real terminal requests come from a same-host browser; present as a
        # genuine loopback client so the embedded-terminal local-origin gate
        # (CVD #3 / test_cvd3_terminal_local_origin_gate.py) admits the request
        # and these tests exercise the terminal logic they target.
        self.client_address = ("127.0.0.1", 12345)
        self.wfile = io.BytesIO()
        self.responses = []

    def send_response(self, status):
        self.responses.append(status)

    def send_header(self, _name, _value):
        pass

    def end_headers(self):
        pass


def test_workspaces_route_exposes_terminal_remote_backend_flag(monkeypatch):
    import api.routes as routes

    monkeypatch.setattr(
        routes,
        "load_workspaces",
        lambda: [{"path": "/tmp/project", "name": "Project"}],
    )
    monkeypatch.setattr(routes, "get_last_workspace", lambda: "/tmp/project")
    monkeypatch.setattr(routes, "get_config", lambda: {"terminal": {"backend": "ssh"}})

    handler = _RouteHandler()
    routes.handle_get(handler, urlsplit("/api/workspaces"))
    payload = json.loads(handler.wfile.getvalue().decode("utf-8"))

    assert handler.responses == [200]
    assert payload["terminal_remote_backend"] is True
    assert payload["workspaces"][0]["path"] == "/tmp/project"
    assert payload["last"] == "/tmp/project"


def test_terminal_start_rejects_remote_backend_with_stale_workspace_before_local_validation(monkeypatch):
    import api.routes as routes

    monkeypatch.setattr(
        routes,
        "get_session",
        lambda sid: SimpleNamespace(
            session_id=sid,
            workspace="/Users/other/projects/stale-remote-workspace",
        ),
    )
    monkeypatch.setattr(routes, "session_workspace_supports_local_io", lambda _session: False)

    handler = _RouteHandler()
    routes._handle_terminal_start(
        handler,
        {"session_id": "session-1", "rows": 24, "cols": 80, "restart": False},
    )
    payload = json.loads(handler.wfile.getvalue().decode("utf-8"))

    assert handler.responses == [400]
    assert payload == {
        "error": "remote_terminal_backend_unsupported",
        "message": "Embedded terminal is only supported for local terminal backends.",
    }
