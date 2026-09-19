"""Regression checks for configurable pinned session limits."""

import json
import pathlib
import urllib.error
import urllib.request

from tests._pytest_port import BASE

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PY = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return json.loads(response.read())


def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code


def restore_pin_limit(original_settings):
    limit = (original_settings or {}).get("pinned_sessions_limit")
    if isinstance(limit, int):
        post("/api/settings", {"pinned_sessions_limit": limit})


def make_session(created, title):
    payload = {
        "title": title,
        "messages": [{"role": "user", "content": "keep this conversation handy"}],
        "model": "test/pin-limit-setting",
    }
    d, status = post("/api/session/import", payload)
    assert status == 200
    sid = d["session"]["session_id"]
    created.append(sid)
    return sid


def test_settings_api_persists_integer_pin_limit_and_rejects_invalid_values():
    original_limit = get("/api/settings")
    try:
        d, status = post("/api/settings", {"pinned_sessions_limit": 5})
        assert status == 200
        assert d["pinned_sessions_limit"] == 5

        d, status = post("/api/settings", {"pinned_sessions_limit": "7"})
        assert status == 200
        assert d["pinned_sessions_limit"] == 7

        d, status = post("/api/settings", {"pinned_sessions_limit": 0})
        assert status == 200
        assert d["pinned_sessions_limit"] == 7

        d, status = post("/api/settings", {"pinned_sessions_limit": 100})
        assert status == 200
        assert d["pinned_sessions_limit"] == 7
    finally:
        restore_pin_limit(original_limit)


def test_session_pin_endpoint_uses_configured_limit():
    original_limit = get("/api/settings")
    created = []
    try:
        d, status = post("/api/settings", {"pinned_sessions_limit": 4})
        assert status == 200
        assert d["pinned_sessions_limit"] == 4

        pinned = [make_session(created, f"Configured pin cap {i}") for i in range(4)]
        for sid in pinned:
            d, status = post("/api/session/pin", {"session_id": sid, "pinned": True})
            assert status == 200
            assert d["session"]["pinned"] is True

        fifth = make_session(created, "Configured pin cap overflow")
        d, status = post("/api/session/pin", {"session_id": fifth, "pinned": True})
        assert status == 400
        assert "4 sessions" in d.get("error", "")
    finally:
        restore_pin_limit(original_limit)
        for sid in created:
            post("/api/session/delete", {"session_id": sid})
