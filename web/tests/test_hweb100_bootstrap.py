"""HWEB-100: ``GET /api/bootstrap`` replaces the inline boot globals."""
from __future__ import annotations

import json
import urllib.request


def _get_json(base_url: str, path: str, headers: dict | None = None):
    req = urllib.request.Request(base_url + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read()), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}"), dict(exc.headers)


def test_bootstrap_shape_without_auth(base_url):
    status, body, headers = _get_json(base_url, "/api/bootstrap")
    assert status == 200
    assert headers.get("Cache-Control") == "no-store"
    assert set(body) == {"webui_version", "max_upload_bytes", "csrf_token", "language", "bot_name", "auth", "profile", "onboarding", "features"}
    assert isinstance(body["webui_version"], str) and body["webui_version"]
    assert isinstance(body["max_upload_bytes"], int) and body["max_upload_bytes"] > 0
    assert body["csrf_token"] == ""  # auth disabled in the test server: no session token exists
    assert body["auth"]["auth_enabled"] is False
    assert body["profile"] == {"name": body["profile"]["name"], "is_default": body["profile"]["is_default"]}
    assert isinstance(body["onboarding"]["completed"], bool)
    assert set(body["features"]) == {"dashboard", "terminal_remote_backend", "extensions", "single_profile_mode"}
    for v in body["features"].values():
        assert isinstance(v, bool)


def test_bootstrap_auth_block_matches_auth_status(base_url):
    _, boot, _ = _get_json(base_url, "/api/bootstrap")
    _, auth, _ = _get_json(base_url, "/api/auth/status")
    assert boot["auth"] == auth


def test_bootstrap_contains_no_secret_material(base_url):
    _, body, _ = _get_json(base_url, "/api/bootstrap")
    text = json.dumps(body)
    for forbidden in ("password_hash", "api_key", "cookie", "token\": \"ey"):
        assert forbidden not in text
