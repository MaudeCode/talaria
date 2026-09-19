from __future__ import annotations

import json
import pathlib
import re
import shutil
import subprocess
import urllib.error
import urllib.request
import urllib.parse

import pytest

from api.routes import _project_os_workspace_read
from tests._pytest_port import BASE


ROOT = pathlib.Path(__file__).resolve().parents[1]
UI_JS = ROOT / "static" / "ui.js"
WORKSPACE_JS = ROOT / "static" / "workspace.js"
NODE = shutil.which("node")


def _get_json(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return json.loads(response.read())


def _get_bytes(path: str) -> bytes:
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return response.read()


def _browser_headers() -> dict[str, str]:
    parsed = urllib.parse.urlparse(BASE)
    return {"Origin": f"{parsed.scheme}://{parsed.netloc}"}


def _referer_only_headers() -> dict[str, str]:
    parsed = urllib.parse.urlparse(BASE)
    return {"Referer": f"{parsed.scheme}://{parsed.netloc}/workspace"}


def _post_json(path: str, body: dict | None = None, headers: dict[str, str] | None = None) -> tuple[dict, int]:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read()), response.status
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read()), exc.code


def _make_session(workspace: pathlib.Path) -> str:
    _post_json("/api/workspaces/add", {"path": str(workspace)})
    payload, status = _post_json("/api/session/new", {"workspace": str(workspace)})
    assert status == 200, payload
    return payload["session"]["session_id"]


def _read_workspace_js() -> str:
    return WORKSPACE_JS.read_text(encoding="utf-8")


def _workspace_escape_helper_block() -> str:
    src = _read_workspace_js()
    start = src.find("function _escapeGrantStore(){")
    assert start >= 0, "escape grant helper block start not found in static/workspace.js"
    end = src.find("let _workspacePanelActiveTab = 'files';", start)
    assert end >= 0, "escape grant helper block end not found in static/workspace.js"
    return src[start:end]


def _run_node(js: str) -> dict:
    assert NODE is not None, "node not on PATH"
    completed = subprocess.run(
        [NODE, "-e", js],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout)


class TestIssue4582EscapeNavigationLive:
    def test_authorized_file_symlink_reads_and_raws_through_parent_anchor(self, tmp_path):
        workspace = tmp_path / "workspace"
        outside = tmp_path / "outside"
        workspace.mkdir()
        outside.mkdir()
        (outside / "note.txt").write_text("outside file", encoding="utf-8")
        (workspace / "escape-file.txt").symlink_to(outside / "note.txt")

        sid = _make_session(workspace)
        root_listing = _get_json(f"/api/list?session_id={sid}&path=.")
        escape_row = {entry["name"]: entry for entry in root_listing["entries"]}["escape-file.txt"]
        assert escape_row["target_outside_workspace"] is True

        denied, denied_status = _post_json(
            "/api/escape/authorize",
            {"session_id": sid, "path": "escape-file.txt"},
        )
        assert denied_status == 403, denied

        referer_only, referer_only_status = _post_json(
            "/api/escape/authorize",
            {"session_id": sid, "path": "escape-file.txt"},
            headers=_referer_only_headers(),
        )
        assert referer_only_status == 403, referer_only

        auth, status = _post_json(
            "/api/escape/authorize",
            {"session_id": sid, "path": "escape-file.txt"},
            headers=_browser_headers(),
        )
        assert status == 200, auth
        assert auth["path"] == "escape-file.txt"
        assert auth["is_dir"] is False
        assert auth["read_only"] is True

        text = _get_json(
            f"/api/escape/file/read?session_id={sid}&token={auth['token']}&path=escape-file.txt"
        )
        assert text["path"] == "escape-file.txt"
        assert text["content"] == "outside file"
        assert text["escape_read_only"] is True

        raw = _get_bytes(
            f"/api/escape/file/raw?session_id={sid}&token={auth['token']}&path=escape-file.txt"
        )
        assert raw == b"outside file"

        try:
            _get_json(
                f"/api/escape/list?session_id={sid}&token={auth['token']}&path=escape-file.txt"
            )
            assert False, "file escape grants should not list as directories"
        except urllib.error.HTTPError as exc:
            assert exc.code in (403, 404)

    def test_authorized_dir_list_read_and_raw_stay_virtualized(self, tmp_path):
        workspace = tmp_path / "workspace"
        outside = tmp_path / "outside"
        workspace.mkdir()
        outside.mkdir()
        (outside / "note.txt").write_text("outside note", encoding="utf-8")
        (workspace / "escape").symlink_to(outside)

        sid = _make_session(workspace)
        root_listing = _get_json(f"/api/list?session_id={sid}&path=.")
        escape_row = {entry["name"]: entry for entry in root_listing["entries"]}["escape"]
        assert escape_row["target_outside_workspace"] is True

        denied, denied_status = _post_json("/api/escape/authorize", {"session_id": sid, "path": "escape"})
        assert denied_status == 403, denied

        referer_only, referer_only_status = _post_json(
            "/api/escape/authorize",
            {"session_id": sid, "path": "escape"},
            headers=_referer_only_headers(),
        )
        assert referer_only_status == 403, referer_only

        auth, status = _post_json(
            "/api/escape/authorize",
            {"session_id": sid, "path": "escape"},
            headers=_browser_headers(),
        )
        assert status == 200, auth
        assert auth["path"] == "escape"
        assert auth["is_dir"] is True
        assert auth["read_only"] is True

        listed = _get_json(
            f"/api/escape/list?session_id={sid}&token={auth['token']}&path=escape"
        )
        entries = {entry["name"]: entry for entry in listed["entries"]}
        assert listed["path"] == "escape"
        assert listed["read_only"] is True
        assert entries["note.txt"]["path"] == "escape/note.txt"
        assert entries["note.txt"]["escape_read_only"] is True
        assert str(outside) not in json.dumps(listed)

        text = _get_json(
            f"/api/escape/file/read?session_id={sid}&token={auth['token']}&path=escape/note.txt"
        )
        assert text["path"] == "escape/note.txt"
        assert text["content"] == "outside note"
        assert text["escape_read_only"] is True

        raw = _get_bytes(
            f"/api/escape/file/raw?session_id={sid}&token={auth['token']}&path=escape/note.txt"
        )
        assert raw == b"outside note"
        assert _project_os_workspace_read(pathlib.Path(workspace), "escape/note.txt") is None

    def test_nested_escape_row_stays_display_only_and_non_browsable(self, tmp_path):
        workspace = tmp_path / "workspace"
        outside = tmp_path / "outside"
        second_outside = tmp_path / "second-outside"
        workspace.mkdir()
        outside.mkdir()
        second_outside.mkdir()
        (second_outside / "secret.txt").write_text("secret", encoding="utf-8")
        (outside / "nested-escape").symlink_to(second_outside)
        (outside / "nested-file-escape.txt").symlink_to(second_outside / "secret.txt")
        (workspace / "escape").symlink_to(outside)

        sid = _make_session(workspace)
        auth, status = _post_json(
            "/api/escape/authorize",
            {"session_id": sid, "path": "escape"},
            headers=_browser_headers(),
        )
        assert status == 200, auth

        nested_auth, nested_status = _post_json(
            "/api/escape/authorize",
            {"session_id": sid, "path": "escape/nested-escape"},
            headers=_browser_headers(),
        )
        assert nested_status in (403, 404), nested_auth

        listed = _get_json(
            f"/api/escape/list?session_id={sid}&token={auth['token']}&path=escape"
        )
        entries = {entry["name"]: entry for entry in listed["entries"]}
        nested = entries["nested-escape"]
        assert nested["target_outside_workspace"] is True
        assert nested["escape_read_only"] is True
        assert "target" not in nested

        try:
            _get_json(
                f"/api/escape/list?session_id={sid}&token={auth['token']}&path=escape/nested-escape"
            )
            assert False, "nested escape traversal should stay blocked"
        except urllib.error.HTTPError as exc:
            assert exc.code in (403, 404)

        try:
            _get_bytes(
                f"/api/escape/file/raw?session_id={sid}&token={auth['token']}&path=escape/nested-file-escape.txt"
            )
            assert False, "nested file escape raw read should stay blocked"
        except urllib.error.HTTPError as exc:
            assert exc.code in (403, 404)


pytestmark = pytest.mark.skipif(NODE is None, reason="node not on PATH")
