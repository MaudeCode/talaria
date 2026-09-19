"""HWEB-100: the live Python handlers still satisfy the frontend contract fixtures.

``frontend/src/contracts/__fixtures__/live/*.json`` were captured from the
server and are parsed by the TypeScript schema tests. This test re-fetches
every captured GET endpoint from the live test server and asserts the
captured top-level keys are still present with the same JSON types, so a
backend change that drops or retypes a field the React client depends on
fails here before it fails in a browser.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent.parent / "frontend" / "src" / "contracts" / "__fixtures__" / "live"

# Endpoints whose payload depends on state created during capture (a session
# that no longer exists) or on POST bodies are compared by status only.
STATUS_ONLY = {"session", "session_metadata", "session_status", "session_usage", "background_status", "approval_pending", "clarify_pending", "share_read"}
SKIP = {"session_new", "session_rename", "session_delete", "draft_set", "goal_status", "share_create", "session_toolsets_bad", "upload_no_file"}
# Keys the server only includes when a multi-profile agent install is present (captured with one); the
# TypeScript schemas mark them optional.
OPTIONAL_KEYS = {"crons": {"active_profile", "all_profiles", "other_profile_count"}}


def _fixtures():
    if not FIXTURES.is_dir():
        return []
    return sorted(p for p in FIXTURES.glob("*.json") if p.stem not in SKIP)


def _jtype(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "str"
    if isinstance(v, list):
        return "list"
    if isinstance(v, dict):
        return "dict"
    return type(v).__name__


def _get(base_url: str, path: str):
    req = urllib.request.Request(base_url + path)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


@pytest.mark.parametrize("fixture", _fixtures(), ids=lambda p: p.stem)
def test_live_payload_matches_fixture_shape(base_url, fixture):
    spec = json.loads(fixture.read_text())
    if spec["method"] != "GET":
        pytest.skip("GET fixtures only")
    status, body = _get(base_url, spec["path"])
    if fixture.stem in STATUS_ONLY:
        assert status in (200, 404)
        return
    if status == 503 and spec["status"] == 200:
        pytest.skip(f"{spec['path']} is unavailable in this environment (503)")
    assert status == spec["status"], f"{spec['path']} returned {status}, fixture had {spec['status']}"
    if not isinstance(spec["body"], dict):
        return
    assert isinstance(body, dict)
    optional = OPTIONAL_KEYS.get(fixture.stem, set())
    missing = [k for k in spec["body"] if k not in body and k not in optional]
    assert not missing, f"{spec['path']} lost keys: {missing}"
    retyped = {k: (_jtype(spec['body'][k]), _jtype(body[k])) for k in spec["body"] if k in body and _jtype(spec["body"][k]) != _jtype(body[k]) and _jtype(spec["body"][k]) != "null" and _jtype(body[k]) != "null"}
    assert not retyped, f"{spec['path']} retyped keys: {retyped}"
