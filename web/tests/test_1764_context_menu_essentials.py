"""Regression tests for issue #1764 — three context-menu essentials.

The issue asked for a much larger surface, but per Nathan's curation we
ship only three high-leverage pieces in this PR:

1. **Copy file path** in the workspace tree right-click menu — resolves
   the absolute on-disk path on the server (so the user gets the full
   path, not the relative tree-rooted one) and writes it to the
   clipboard.

2. **Rename** in the session three-dot menu — Cygnus reported double-click
   rename being timing-sensitive (first click opens the chat before the
   second click arrives). Putting Rename in the menu eliminates the
   timing entirely.

3. **Reveal-failed toast includes the resolved path** — the existing
   handler returned bare "File not found" (404) and the frontend toast
   surfaced only `err.message`, dropping the path entirely. This makes
   it impossible for users to tell *which* file the system expected
   (e.g. a stale session row pointing at a deleted file). Now the
   server includes the resolved server-side path in the message.

These tests pin the source-level wiring — they do not exercise the live
HTTP endpoints (those are covered by integration tests where they exist
in the wider suite).
"""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent.parent
ROUTES = ROOT / "api" / "routes.py"
UI = ROOT / "static" / "ui.js"
SESSIONS = ROOT / "static" / "sessions.js"
I18N = ROOT / "static" / "i18n.js"


# ════════════════════════════════════════════════════════════════════
#  Item A — Copy file path in workspace tree right-click menu
# ════════════════════════════════════════════════════════════════════


class TestCopyFilePathMenuItem:
    def test_endpoint_handler_present(self):
        """Server-side endpoint must exist and route through the dispatcher."""
        src = ROUTES.read_text(encoding="utf-8")
        assert 'parsed.path == "/api/file/path"' in src
        assert "def _handle_file_path(handler, body):" in src
        # Must use safe_resolve to prevent path traversal.
        # Find the handler body and check.
        m = re.search(
            r"def _handle_file_path\(handler, body\):\s*(?:\"\"\".*?\"\"\")?\s*(.*?)(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m, "_handle_file_path body not found"
        body = m.group(1)
        assert "safe_resolve(Path(s.workspace)" in body
        assert "session_id" in body  # require() check
        # Returns the absolute path as a string.
        assert 'j(handler, {"ok": True, "path": str(target)})' in body

    def test_endpoint_handler_does_not_require_existence(self):
        """Copy-path on a recently-deleted file is still useful (paste into
        terminal to investigate). The handler must not 404 on missing files.
        """
        src = ROUTES.read_text(encoding="utf-8")
        m = re.search(
            r"def _handle_file_path\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m
        body = m.group(0)
        # No exists() check — that's specifically what we want NOT to be
        # there. Distinguishing from _handle_file_reveal which does check.
        assert "exists()" not in body, (
            "Copy-path must not gate on exists() — copying a stale path is "
            "still useful for debugging deleted files."
        )


# ════════════════════════════════════════════════════════════════════
#  Item B — Rename in session three-dot menu
# ════════════════════════════════════════════════════════════════════


# ════════════════════════════════════════════════════════════════════
#  Item C — reveal-failed toast includes the resolved path
# ════════════════════════════════════════════════════════════════════


class TestRevealFailedTostIncludesPath:
    def test_handler_includes_target_in_404_message(self):
        """When `target.exists()` returns false, the 404 response body must
        include the resolved server-side path so the frontend toast can
        show users *which* file the system expected. Previously it was
        just "File not found" with no path — useless for diagnosing stale
        session rows.
        """
        src = ROUTES.read_text(encoding="utf-8")
        # Find _handle_file_reveal body.
        m = re.search(
            r"def _handle_file_reveal\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m, "_handle_file_reveal not found"
        body = m.group(0)
        # The bad() call for not-exists must include the path.
        assert 'f"File not found: {target}"' in body, (
            "Reveal handler must include the resolved path in the 404 message."
        )
        # And NOT the bare unhelpful message.
        # (We allow the substring 'File not found' because the new f-string
        # contains it as a prefix; pin via the f-string presence above.)
        assert 'bad(handler, "File not found", 404)' not in body, (
            "Old bare 'File not found' message must be removed."
        )

# ════════════════════════════════════════════════════════════════════
#  Behaviour tests — exercise the live HTTP endpoints against the
#  module-scoped test server (started by conftest.py at port 8788).
# ════════════════════════════════════════════════════════════════════


import json
import pathlib
import sys
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from conftest import TEST_BASE  # noqa: E402


def _post(path, body=None, headers=None):
    data = json.dumps(body or {}).encode()
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(TEST_BASE + path, data=data, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code


class TestFilePathEndpointBehaviour:
    """End-to-end exercise of the new /api/file/path endpoint against the
    live test server."""

    def _new_session(self):
        body, status = _post("/api/session/new", {})
        assert status == 200, body
        return body["session"]["session_id"]

    def test_returns_absolute_path_for_relative_input(self):
        """The endpoint must resolve a relative workspace-rooted path into
        the absolute on-disk path. This is the whole point — the frontend
        can't compute it because only the server knows the workspace root.
        """
        sid = self._new_session()
        body, status = _post("/api/file/path", {"session_id": sid, "path": "."})
        assert status == 200, body
        assert body.get("ok") is True
        assert Path(body.get("path", "")).is_absolute(), body

    def test_does_not_404_on_missing_file(self):
        """Copy-path on a stale-but-recently-deleted file must still
        succeed — that's specifically what makes the action useful for
        debugging."""
        sid = self._new_session()
        body, status = _post(
            "/api/file/path",
            {"session_id": sid, "path": "definitely-does-not-exist-xyz123.tmp"},
        )
        assert status == 200, body
        assert body.get("ok") is True
        # Even though the file doesn't exist, we get back a resolved path.
        assert "definitely-does-not-exist-xyz123.tmp" in body.get("path", "")

    def test_rejects_path_traversal(self):
        """The endpoint must use safe_resolve, which rejects paths that
        escape the workspace root."""
        sid = self._new_session()
        body, status = _post(
            "/api/file/path",
            {"session_id": sid, "path": "../../../../../../etc/passwd"},
        )
        assert status == 400, body  # safe_resolve raises ValueError → bad()
        # Error message must NOT include the attempted traversal target's
        # contents, just a generic safe-resolve message.
        assert "passwd" not in body.get("error", "").lower() or "outside" in body.get("error", "").lower()

    def test_missing_session_id_returns_400(self):
        body, status = _post("/api/file/path", {"path": "foo.txt"})
        assert status == 400, body
        assert "session_id" in body.get("error", "")

    def test_unknown_session_returns_404(self):
        body, status = _post(
            "/api/file/path", {"session_id": "fake-session-xyz", "path": "."}
        )
        assert status == 404, body
        assert "session" in body.get("error", "").lower()


class TestRevealHandlerErrorIncludesPath:
    """End-to-end check that the reveal endpoint's 404 includes the path."""

    def _new_session(self):
        body, status = _post("/api/session/new", {})
        assert status == 200, body
        return body["session"]["session_id"]

    def test_404_message_contains_resolved_path(self):
        """Reveal of a missing file must surface the resolved server-side
        path in the error, so the frontend toast can show users *which*
        file was missing — useful when a stale row points at a deleted
        file (#1764)."""
        sid = self._new_session()
        body, status = _post(
            "/api/file/reveal",
            {"session_id": sid, "path": "missing-xyz-1764.txt"},
        )
        assert status == 404, body
        err = body.get("error", "")
        # Must include the filename in the resolved path.
        assert "missing-xyz-1764.txt" in err, (
            f"Reveal 404 message must include the resolved path, got: {err!r}"
        )
        # Must keep the human-readable prefix.
        assert "File not found" in err
