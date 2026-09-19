from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

import api.config as api_config
import api.routes as routes
import api.updates


ROOT = Path(__file__).resolve().parent.parent


class _FakeHandler:
    def __init__(self, request_headers=None):
        self.status = None
        self.sent_headers = []
        self.body = bytearray()
        self.headers = dict(request_headers or {})
        self.wfile = self

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.sent_headers.append((name, value))

    def end_headers(self):
        pass

    def write(self, data):
        self.body.extend(data)

    def header(self, name):
        for key, value in self.sent_headers:
            if key.lower() == name.lower():
                return value
        return None


def _get(path, request_headers=None):
    handler = _FakeHandler(request_headers)
    routes.handle_get(handler, SimpleNamespace(path=path, query=""))
    return handler


def test_config_owner_returns_checkout_static_root():
    static_root = ROOT / "static"
    assert api_config.get_static_root() == static_root


def test_manifest_routes_follow_selected_static_root(tmp_path, monkeypatch):
    static_root = tmp_path / "static"
    (static_root / "dist").mkdir(parents=True)
    manifest_path = static_root / "dist" / "manifest.webmanifest"
    payload = json.dumps({"name": "temp", "display": "standalone"}).encode("utf-8")
    manifest_path.write_bytes(payload)
    monkeypatch.setattr(api_config, "get_static_root", lambda: static_root)

    handler = _get("/manifest.json")
    assert handler.status == 200
    assert handler.header("Content-Type") == "application/manifest+json; charset=utf-8"
    assert handler.header("Cache-Control") == "no-cache"
    assert bytes(handler.body) == payload

    session_handler = _get("/session/manifest.webmanifest")
    assert session_handler.status == 200
    assert bytes(session_handler.body) == payload


def test_service_worker_and_favicon_follow_selected_static_root(tmp_path, monkeypatch):
    static_root = tmp_path / "static"
    (static_root / "dist").mkdir(parents=True)
    (static_root / "brand").mkdir()
    sw_path = static_root / "dist" / "sw.js"
    sw_path.write_text("const version = '__WEBUI_VERSION__';\n", encoding="utf-8")
    favicon_path = static_root / "brand" / "favicon.ico"
    favicon_path.write_bytes(b"favicon-bytes")
    monkeypatch.setattr(api_config, "get_static_root", lambda: static_root)

    sw_handler = _get("/sw.js")
    # Read the version the way the route does — an attribute lookup at call
    # time, not a name bound when this module was imported. A test that evicts
    # `api.updates` from sys.modules leaves a second module object behind, and a
    # stale binding would then be compared against the live one; on a tagless
    # checkout the two `git describe --always` calls can even differ in
    # abbreviation length, which is exactly how this test failed in CI.
    expected = sw_path.read_text(encoding="utf-8").replace(
        "__WEBUI_VERSION__", quote(api.updates.WEBUI_VERSION, safe="")
    ).encode("utf-8")
    assert sw_handler.status == 200
    assert sw_handler.header("Service-Worker-Allowed") == "/"
    assert sw_handler.header("Cache-Control") == "no-store"
    assert bytes(sw_handler.body) == expected

    favicon_handler = _get("/favicon.ico")
    assert favicon_handler.status == 200
    assert favicon_handler.header("Content-Type") == "image/x-icon"
    assert bytes(favicon_handler.body) == b"favicon-bytes"

    favicon_path.unlink()
    missing_favicon_handler = _get("/favicon.ico")
    assert missing_favicon_handler.status == 204


def test_index_shell_and_static_route_use_selected_root(tmp_path, monkeypatch):
    static_root = tmp_path / "static"
    (static_root / "dist").mkdir(parents=True)
    (static_root / "brand").mkdir()

    index_path = static_root / "dist" / "index.html"
    index_path.write_bytes(b'<html lang="__LANG__"><head><base href="__BASE_HREF__"></head><body>__WEBUI_VERSION__ temp</body></html>')
    brand_path = static_root / "brand" / "temp.svg"
    brand_path.write_bytes(b"<svg/>")

    monkeypatch.setattr(api_config, "get_static_root", lambda: static_root)
    monkeypatch.setattr(routes, "_STATIC_CACHE", {})

    shell = _get("/session/abc")
    assert shell.status == 200
    body = bytes(shell.body).decode("utf-8")
    assert "temp" in body
    assert '<base href="../">' in body
    assert "__WEBUI_VERSION__" not in body and "__LANG__" not in body

    temp_static = _get("/static/brand/temp.svg")
    assert temp_static.status == 200
    assert bytes(temp_static.body) == b"<svg/>"

    traversal = _get("/static/../api/routes.py")
    assert traversal.status == 404
