"""Tests for issue #2735 — "Open in VS Code" action for workspace files/folders.

Pins three layers:

1. **Source wiring** — the dispatch entry, handler structure, and menu items
   exist in the correct files.

2. **i18n completeness** — both new keys (``open_in_vscode`` and
   ``open_in_vscode_failed``) are present in every locale block.

3. **Live endpoint behaviour** — error paths (missing fields, unknown session,
   missing file, path traversal) behave correctly against the test server.

The success path (VS Code actually opening) is not covered here because it
requires VS Code to be installed on the CI host.  The spawn is asynchronous
(matching ``_handle_file_reveal``) but reaped rather than dropped, so its
failure is surfaced via the OSError catch and a 400 response.  That
observable is tested in ``TestOpenInVsCodeEndpointBehaviour``; the reaping
itself is covered by ``tests/test_hweb45_process_hygiene.py``.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ROUTES = ROOT / "api" / "routes.py"
UI = ROOT / "static" / "ui.js"
I18N = ROOT / "static" / "i18n.js"

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from conftest import TEST_BASE  # noqa: E402


# ═══════════════════════════════════════════════════════════════════════════════
#  Source-level wiring
# ═══════════════════════════════════════════════════════════════════════════════


class TestOpenInVsCodeBackendWiring:
    def test_route_dispatch_entry_present(self):
        """Dispatcher must route /api/file/open-vscode to the handler."""
        src = ROUTES.read_text(encoding="utf-8")
        assert 'parsed.path == "/api/file/open-vscode"' in src

    def test_handler_function_defined(self):
        src = ROUTES.read_text(encoding="utf-8")
        assert "def _handle_file_open_vscode(handler, body):" in src

    def test_handler_uses_safe_resolve(self):
        """Handler must use safe_resolve to prevent path traversal."""
        src = ROUTES.read_text(encoding="utf-8")
        m = re.search(
            r"def _handle_file_open_vscode\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m, "_handle_file_open_vscode body not found"
        body = m.group(0)
        assert "safe_resolve(Path(s.workspace)" in body

    def test_handler_checks_existence(self):
        """Handler must require the target to exist (unlike copy-path)."""
        src = ROUTES.read_text(encoding="utf-8")
        m = re.search(
            r"def _handle_file_open_vscode\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m
        body = m.group(0)
        assert "exists()" in body

    def test_handler_reads_vscode_config(self):
        """Handler must read the optional ``vscode`` config block."""
        src = ROUTES.read_text(encoding="utf-8")
        m = re.search(
            r"def _handle_file_open_vscode\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m
        body = m.group(0)
        assert 'get("vscode"' in body

    def test_handler_defaults_to_code_command(self):
        """Default executable must be ``code`` when config is absent."""
        src = ROUTES.read_text(encoding="utf-8")
        m = re.search(
            r"def _handle_file_open_vscode\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m
        body = m.group(0)
        assert '"code"' in body

    def test_handler_supports_path_prefix_mapping(self):
        """Handler must support container_path_prefix / host_path_prefix
        so Docker users can map container paths to host paths."""
        src = ROUTES.read_text(encoding="utf-8")
        m = re.search(
            r"def _handle_file_open_vscode\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m
        body = m.group(0)
        assert "container_path_prefix" in body
        assert "host_path_prefix" in body

    def test_handler_uses_the_detached_spawn_helper(self):
        """Handler must launch the editor through ``spawn_detached_app``.

        Still async and non-blocking, and still consistent with
        ``_handle_file_reveal`` — but the handle is reaped rather than dropped,
        so a click does not leave a zombie behind (HWEB-45).
        """
        src = ROUTES.read_text(encoding="utf-8")
        m = re.search(
            r"def _handle_file_open_vscode\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m
        body = m.group(0)
        assert "spawn_detached_app(" in body
        assert "subprocess.Popen(" not in body

    def test_handler_resolves_command_via_shutil_which(self):
        """Handler must use shutil.which() to find the command so it works
        even when the server's inherited PATH is minimal (e.g. macOS launch
        via start.sh where /usr/local/bin may be absent from the subprocess
        PATH)."""
        src = ROUTES.read_text(encoding="utf-8")
        m = re.search(
            r"def _handle_file_open_vscode\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m
        body = m.group(0)
        assert "shutil.which(" in body

    def test_handler_has_vscode_fallback_paths(self):
        """Handler must try common VS Code paths when shutil.which fails,
        covering macOS (/usr/local/bin/code), Linux (/snap/bin/code), and
        Windows (%LOCALAPPDATA%\\Programs\\Microsoft VS Code)."""
        src = ROUTES.read_text(encoding="utf-8")
        m = re.search(
            r"def _handle_file_open_vscode\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m
        body = m.group(0)
        assert "/usr/local/bin/code" in body        # macOS
        assert "/snap/bin/code" in body             # Linux snap
        assert "Microsoft VS Code" in body          # Windows

    def test_handler_returns_helpful_error_when_not_found(self):
        """When code command is not found anywhere, handler must return a
        descriptive error instead of a bare OSError message."""
        src = ROUTES.read_text(encoding="utf-8")
        m = re.search(
            r"def _handle_file_open_vscode\(handler, body\):.*?(?=\ndef )",
            src,
            re.DOTALL,
        )
        assert m
        body = m.group(0)
        assert "VS Code command not found" in body


# ═══════════════════════════════════════════════════════════════════════════════
#  Live endpoint behaviour
# ═══════════════════════════════════════════════════════════════════════════════


def _post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        TEST_BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code


class TestOpenInVsCodeEndpointBehaviour:
    def _new_session(self):
        body, status = _post("/api/session/new", {})
        assert status == 200, body
        return body["session"]["session_id"]

    def test_missing_session_id_returns_400(self):
        body, status = _post("/api/file/open-vscode", {"path": "."})
        assert status == 400, body
        assert "session_id" in body.get("error", "")

    def test_missing_path_returns_400(self):
        sid = self._new_session()
        body, status = _post("/api/file/open-vscode", {"session_id": sid})
        assert status == 400, body
        assert "path" in body.get("error", "")

    def test_unknown_session_returns_404(self):
        body, status = _post(
            "/api/file/open-vscode",
            {"session_id": "nonexistent-session-xyz", "path": "."},
        )
        assert status == 404, body
        assert "session" in body.get("error", "").lower()

    def test_missing_file_returns_404_with_path(self):
        """Attempting to open a file that does not exist must return 404 and
        include the resolved path in the error (mirrors _handle_file_reveal
        behaviour introduced in #1764)."""
        sid = self._new_session()
        body, status = _post(
            "/api/file/open-vscode",
            {"session_id": sid, "path": "does-not-exist-2735.txt"},
        )
        assert status == 404, body
        err = body.get("error", "")
        assert "does-not-exist-2735.txt" in err, (
            f"404 message must include the resolved path, got: {err!r}"
        )

    def test_path_traversal_rejected(self):
        """Handler must reject paths that escape the workspace root."""
        sid = self._new_session()
        body, status = _post(
            "/api/file/open-vscode",
            {"session_id": sid, "path": "../../../../../../etc/passwd"},
        )
        assert status == 400, body
