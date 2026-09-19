"""Regression tests for stale empty sessions after a WebUI restart.

When a saved session ID returns 404 (e.g. the session was deleted from another
browser, or a state DB rotation removed it), the prior behavior was to show
\"Session not available in web UI.\" and stick there forever — the saved
localStorage entry never got cleared, so every reload reproduced the broken
state.

These tests lock in:
  1. ``api()`` attaches HTTP context (``.status``, ``.statusText``, ``.body``)
     to thrown errors so callers can branch on status without re-parsing text.
  2. ``loadSession()`` clears the stale ``hermes-webui-session`` key on a 404
     and strips the ``/session/<id>`` URL, then rethrows only at boot time so
     boot can fall through to the empty state (#2798, #2782).
  3. The server 404s a deleted *WebUI* session on ``GET /api/session`` instead
     of synthesising a read-only CLI stub, so ``GET`` and the ``POST`` write
     paths agree on whether a session exists and the client can self-heal
     (#2782). A genuine CLI-origin session still returns 200 after its sidecar
     is gone.
"""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlparse
import re


REPO = Path(__file__).parent.parent
# ── Server: GET /api/session 404s a deleted WebUI session (#2782) ──


def _invoke_api_session_keyerror(*, index_json, cli_messages):
    """Drive GET /api/session with get_session() raising KeyError (the deleted-
    session fallthrough) and a patched _index.json. Returns the captured status.
    """
    import api.routes as routes

    captured = {}

    def fake_j(_handler, data, status=200, extra_headers=None):
        captured["data"] = data
        captured["status"] = status
        return data

    def fake_bad(_handler, msg, status=400):
        captured["data"] = {"error": msg}
        captured["status"] = status
        return {"error": msg}

    class _FakeIndexFile:
        def exists(self):
            return index_json is not None

        def read_text(self, encoding="utf-8"):
            return index_json

        def read_bytes(self):
            # The index reader now parses raw bytes (json.loads decodes UTF-8 in
            # one pass); model that so this fake matches the real Path interface.
            return None if index_json is None else index_json.encode("utf-8")

    parsed = urlparse("/api/session?session_id=gone_001&messages=0&resolve_model=0")
    with patch("api.routes.get_session", side_effect=KeyError("gone_001")), \
         patch("api.routes.SESSION_INDEX_FILE", _FakeIndexFile()), \
         patch("api.routes._lookup_cli_session_metadata", return_value={}), \
         patch("api.routes.get_cli_session_messages", return_value=cli_messages), \
         patch("api.routes.j", side_effect=fake_j), \
         patch("api.routes.bad", side_effect=fake_bad):
        routes.handle_get(SimpleNamespace(), parsed)
    return captured


def test_get_session_404s_deleted_webui_session():
    """A WebUI session in _index.json (no/webui source) whose sidecar is gone
    must 404 on GET, not synthesise a read-only CLI stub, so the client can
    self-heal and POST/GET agree (#2782)."""
    index = '[{"session_id": "gone_001", "source_tag": null, "raw_source": null, "session_source": null}]'
    captured = _invoke_api_session_keyerror(
        index_json=index,
        cli_messages=[{"role": "user", "content": "hi", "timestamp": 1}],
    )
    assert captured["status"] == 404, (
        "a deleted WebUI session must return 404, not a 200 CLI stub"
    )


def test_get_session_404s_deleted_fork_session():
    """A forked WebUI session is stamped session_source='fork' (the /api/session/
    branch handler); its deleted sidecar must 404 too, not fall through to a 200
    CLI stub, since a fork is WebUI-origin and bricks identically (#2782)."""
    index = '[{"session_id": "gone_001", "source_tag": null, "raw_source": null, "session_source": "fork"}]'
    captured = _invoke_api_session_keyerror(
        index_json=index,
        cli_messages=[{"role": "user", "content": "hi", "timestamp": 1}],
    )
    assert captured["status"] == 404, (
        "a deleted fork (WebUI-origin) session must return 404, not a 200 CLI stub"
    )


def test_get_session_keeps_200_for_genuine_cli_session():
    """A genuine CLI-origin session (source_tag set to a non-webui value in the
    index) still returns the 200 CLI stub after its sidecar is gone (#2782)."""
    index = '[{"session_id": "gone_001", "source_tag": "claude-code", "raw_source": "claude-code", "session_source": "cli"}]'
    captured = _invoke_api_session_keyerror(
        index_json=index,
        cli_messages=[{"role": "user", "content": "hi", "timestamp": 1}],
    )
    assert captured["status"] == 200, (
        "a genuine CLI session must keep the 200 CLI-stub path"
    )
    assert captured["data"]["session"]["session_id"] == "gone_001"


def test_get_session_keeps_200_when_id_absent_from_index():
    """An id absent from _index.json was never a WebUI session, so the existing
    CLI-store 200 path is preserved (no false-positive 404)."""
    captured = _invoke_api_session_keyerror(
        index_json='[{"session_id": "other_999", "source_tag": null}]',
        cli_messages=[{"role": "user", "content": "hi", "timestamp": 1}],
    )
    assert captured["status"] == 200, (
        "an id not in the index must keep the CLI-store 200 path"
    )


def test_get_session_keeps_200_for_legacy_cli_row_with_blank_source():
    """Regression (#3501 review, Codex CORE catch): a legacy CLI/imported session
    can be present in _index.json with is_cli_session:true but BLANK source fields
    (source_tag/raw_source/session_source all null). The earlier
    `source_tag or raw_source or session_source or ""` collapse defaulted blank to
    WebUI and would WRONGLY 404 it. Per-field classification must treat a blank-
    source row marked is_cli_session (or read_only) as a genuine CLI session and
    keep the 200 stub."""
    index = (
        '[{"session_id": "gone_001", "source_tag": null, "raw_source": null, '
        '"session_source": null, "is_cli_session": true}]'
    )
    captured = _invoke_api_session_keyerror(
        index_json=index,
        cli_messages=[{"role": "user", "content": "hi", "timestamp": 1}],
    )
    assert captured["status"] == 200, (
        "a legacy CLI row (is_cli_session:true, blank source) must keep the 200 "
        "CLI-stub path, not be 404'd as a deleted WebUI session"
    )


def test_get_session_keeps_200_for_read_only_row_with_blank_source():
    """A read-only imported session with blank source fields is also CLI-origin
    and must keep the 200 stub (companion to the is_cli_session case)."""
    index = (
        '[{"session_id": "gone_001", "source_tag": null, "raw_source": null, '
        '"session_source": null, "read_only": true}]'
    )
    captured = _invoke_api_session_keyerror(
        index_json=index,
        cli_messages=[{"role": "user", "content": "hi", "timestamp": 1}],
    )
    assert captured["status"] == 200, (
        "a read-only imported row (blank source) must keep the 200 CLI-stub path"
    )
