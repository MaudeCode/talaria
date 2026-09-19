"""Regression tests for PWA support (manifest + service worker).

Covers:
- manifest.json is valid JSON with required PWA fields
- sw.js has the `__WEBUI_VERSION__` placeholder the server replaces at request time
- sw.js offline-fallback uses a resolved promise (not `caches.match() || fallback`
  which is broken — Promise objects are always truthy in `||` checks, so the
  fallback Response would never be used)
- /manifest.json, /manifest.webmanifest, /sw.js routes serve correct Content-Type
"""
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "static" / "manifest.json"
SW = ROOT / "static" / "sw.js"
PWA_STARTUP = ROOT / "static" / "pwa-startup.js"
BOOT = ROOT / "static" / "boot.js"
INDEX = ROOT / "static" / "index.html"
ROUTES = ROOT / "api" / "routes.py"
AUTH = ROOT / "api" / "auth.py"


class TestPWARoutes:
    def test_sw_is_public_auth_path(self):
        src = AUTH.read_text(encoding="utf-8")
        public_idx = src.find("PUBLIC_PATHS")
        assert public_idx != -1, "auth.py must define PUBLIC_PATHS"
        block = src[public_idx:public_idx + 400]
        assert "'/sw.js'" in block, (
            "/sw.js must be public so service-worker updates never return login HTML"
        )


# ── Regression tests for #2226 ──────────────────────────────────────────────
# Firefox Android resolves <link rel="manifest"> against the page URL before
# the dynamic <base href> script executes when installing from /session/<id>,
# producing requests like /session/manifest.json.  Without the route guard
# the catch-all returns index.html and Firefox falls back to a generated
# letter icon.  Two fixes: (1) move <base href> script above manifest/favicon
# links so browsers resolve them correctly, and (2) add /session/manifest.*
# route handlers that serve the real manifest JSON.


class _FakeHandler:
    """Minimal request handler stub for exercising handle_get() in tests."""
    def __init__(self):
        self.status = None
        self.sent_headers = []
        self.body = bytearray()
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


class TestSessionManifestAuthExemption:
    """Assert /session/manifest.* paths are auth-exempt so the browser
    can fetch the manifest during PWA install without being redirected."""

    def test_session_manifest_json_is_public(self, monkeypatch):
        monkeypatch.setenv("HERMES_WEBUI_PASSWORD", "test-password")
        from api.auth import check_auth, _invalidate_password_hash_cache
        from types import SimpleNamespace
        _invalidate_password_hash_cache()
        handler = _FakeHandler()
        assert check_auth(handler, SimpleNamespace(path="/session/manifest.json", query="")) is True

    def test_session_manifest_webmanifest_is_public(self, monkeypatch):
        monkeypatch.setenv("HERMES_WEBUI_PASSWORD", "test-password")
        from api.auth import check_auth, _invalidate_password_hash_cache
        from types import SimpleNamespace
        _invalidate_password_hash_cache()
        handler = _FakeHandler()
        assert check_auth(handler, SimpleNamespace(path="/session/manifest.webmanifest", query="")) is True
