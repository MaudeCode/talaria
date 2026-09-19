"""HWEB-100: unified sandboxed extension platform, server side.

Covers the sanitized manifest projection (hostile input), the manifests
endpoint, the sandbox policy on plugin panels, and the null-origin API guard.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from api.extension_manifests import build_manifests, _from_extension_entry, _theme


def _get(base_url: str, path: str, headers: dict | None = None):
    req = urllib.request.Request(base_url + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)


def test_manifest_projection_sanitizes_hostile_entries():
    entry = {
        "id": "Evil Ext",  # invalid id -> dropped
    }
    assert _from_extension_entry(entry) is None
    entry = {
        "id": "good-ext",
        "name": "<b>Good</b>" + "x" * 200,
        "version": "1.0\x00",
        "effective_enabled": True,
        "manifest": {
            "panel": "../../etc/passwd.html",  # traversal -> rejected
            "capabilities": ["settings", "root", "sidecar", 42],
            "theme": {"key": "Bad Key!", "name": "T", "tokens": {"--bg": "url(javascript:alert(1))", "--accent": "#123456", "--not-allowed": "#000"}},
            "tts": {"id": "browser", "label": "Shadow built-in"},
        },
        "scripts": ["good-ext/legacy.js"],
        "permissions": {"network_external": True, "weird": "yes"},
    }
    m = _from_extension_entry(entry)
    assert m is not None
    assert m["panel"] is None and "panel_path_rejected" in m["warnings"]
    assert m["legacy_injection"] is True and m["enabled"] is False
    assert "root" not in m["capabilities"] and "settings" in m["capabilities"]
    # theme key is slugified and namespaced; the hostile token is dropped, the allowlisted one kept
    assert m["theme"] is not None and m["theme"]["tokens"] == {"--accent": "#123456"}
    assert m["theme"]["key"].startswith("good-ext-")
    assert m["tts"] is None  # built-in ids are reserved
    assert m["permissions"] == {"network_external": True, "weird": True}
    assert "\x00" not in m["version"] and len(m["name"]) <= 80


def test_manifest_projection_accepts_a_valid_panel_extension():
    entry = {
        "id": "hello-panel",
        "name": "Hello Panel",
        "effective_enabled": True,
        "manifest": {"panel": "hello-panel/index.html", "nav": {"label": "Hello"}, "capabilities": ["settings", "toast"], "theme": {"key": "mint", "name": "Mint", "scheme": "light", "tokens": {"--bg": "#f4fffa"}}},
        "sidecar": {"origin": "http://127.0.0.1:17787", "health_path": "/health", "consented": False},
        "settings_schema": [{"key": "greeting", "type": "string", "label": "Greeting", "default": "Hi"}],
    }
    m = _from_extension_entry(entry)
    assert m == {
        "id": "hello-panel", "name": "Hello Panel", "version": "", "description": "", "source": "manifest", "enabled": True,
        "panel": "extensions/hello-panel/hello-panel/index.html", "nav": {"label": "Hello"},
        "capabilities": ["settings", "toast", "sidecar", "theme"],
        "permissions": {}, "settings_schema": [{"key": "greeting", "type": "string", "label": "Greeting", "default": "Hi"}],
        "theme": {"key": "hello-panel-mint", "name": "Mint", "tokens": {"--bg": "#f4fffa"}, "colors": [], "scheme": "light"},
        "tts": None, "sidecar": {"origin": "http://127.0.0.1:17787", "health_path": "/health", "consented": False},
        "legacy_injection": False, "warnings": [],
    }


def test_theme_requires_tokens_and_valid_scheme():
    theme, warnings = _theme({"key": "x", "name": "X", "tokens": {}}, "ext")
    assert theme is None and "theme_rejected" in warnings
    theme, _ = _theme({"key": "x", "name": "X", "scheme": "sepia", "tokens": {"--bg": "#fff"}}, "ext")
    assert theme is not None and "scheme" not in theme


def test_dashboard_plugins_become_panel_manifests():
    out = build_manifests(
        extension_status={"extensions": []},
        plugin_manifests={"stats": {"label": "Stats", "tab": {"name": "Stats", "path": "/stats"}, "version": "2"}, "Bad Name": {"label": "x"}},
        plugin_enabled=lambda name: name == "stats",
    )
    assert out["protocol_version"] == 1
    assert [m["id"] for m in out["manifests"]] == ["stats"]
    stats = out["manifests"][0]
    assert stats["source"] == "plugin" and stats["enabled"] is True
    assert stats["panel"] == "dashboard-plugins/stats/index.html"
    assert stats["nav"] == {"label": "Stats"}
    assert stats["capabilities"] == ["settings", "storage", "toast", "session"]


def test_manifests_endpoint_shape(base_url):
    status, body, headers = _get(base_url, "/api/extensions/manifests")
    assert status == 200
    assert headers.get("Cache-Control") == "no-store"
    payload = json.loads(body)
    assert payload["protocol_version"] == 1
    assert isinstance(payload["manifests"], list)
    for m in payload["manifests"]:
        assert set(m) >= {"id", "name", "source", "enabled", "panel", "nav", "capabilities", "settings_schema", "theme", "tts", "sidecar", "legacy_injection", "warnings"}


def test_null_origin_api_requests_are_refused_before_auth(base_url):
    status, body, _ = _get(base_url, "/api/settings", headers={"Origin": "null"})
    assert status == 403
    assert b"Sandboxed" in body
    status, _, _ = _get(base_url, "/api/settings", headers={"Origin": base_url})
    assert status == 200


def test_disabled_plugin_panel_is_not_found(base_url):
    status, _, _ = _get(base_url, "/dashboard-plugins/not-a-plugin/index.html")
    assert status == 404
