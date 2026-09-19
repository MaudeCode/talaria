"""Focused regression coverage for workspace sorting and birthtime metadata."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from api import workspace as workspace_api


ROOT = Path(__file__).resolve().parents[1]
def test_list_dir_emits_birthtime_ns(tmp_path):
    (tmp_path / "file.txt").write_text("x", encoding="utf-8")
    (tmp_path / "folder").mkdir()
    entries = workspace_api.list_dir(tmp_path, ".")
    assert {entry["type"] for entry in entries} == {"file", "dir"}
    assert all("birthtime_ns" in entry for entry in entries)
    assert all(isinstance(entry["birthtime_ns"], (int, type(None))) for entry in entries)
    assert {entry["workspace_sort_rank"] for entry in entries} == {1, 2}


def test_list_dir_emits_server_partition_rank_for_special_entries(tmp_path, monkeypatch):
    if not hasattr(os, "mkfifo"):
        pytest.skip("FIFO creation is unavailable on this platform")
    try:
        os.mkfifo(tmp_path / "fifo")
        (tmp_path / "directory").mkdir()
        (tmp_path / "file.txt").write_text("x", encoding="utf-8")
        link_target = tmp_path / "file.txt"
        (tmp_path / "link").symlink_to(link_target)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"special entry creation unavailable: {exc}")

    modes = [False]
    if workspace_api._DIR_FD_OK:
        modes.append(True)
    for use_dir_fd in modes:
        monkeypatch.setattr(workspace_api, "_DIR_FD_OK", use_dir_fd)
        entries = {entry["name"]: entry for entry in workspace_api.list_dir(tmp_path, ".")}
        assert entries["link"]["workspace_sort_rank"] == 0
        assert entries["directory"]["workspace_sort_rank"] == 1
        assert entries["fifo"]["workspace_sort_rank"] == 1
        assert entries["file.txt"]["workspace_sort_rank"] == 2


def test_birthtime_ns_platform_matrix(monkeypatch):
    birthtime_ns = getattr(workspace_api, "_birthtime_ns", None)
    assert birthtime_ns is not None, "_birthtime_ns helper is missing"
    class Stat:
        pass

    modern = Stat()
    modern.st_birthtime_ns = 123
    assert birthtime_ns(modern) == 123
    mac = Stat()
    mac.st_birthtime = 1.5
    assert birthtime_ns(mac) == 1_500_000_000
    windows = Stat()
    windows.st_ctime_ns = 456
    monkeypatch.setattr("api.workspace.sys.platform", "win32")
    assert birthtime_ns(windows) == 456
    linux = Stat()
    monkeypatch.setattr("api.workspace.sys.platform", "linux")
    assert birthtime_ns(linux) is None


def test_escape_symlink_birthtime_is_link_local(tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    link = workspace / "escape.txt"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlink unavailable: {exc}")
    entry = next(item for item in workspace_api.list_dir(workspace, ".") if item["name"] == "escape.txt")
    assert entry["target_outside_workspace"] is True
    assert entry["workspace_sort_rank"] == 0
    birthtime_ns = getattr(workspace_api, "_birthtime_ns", None)
    assert birthtime_ns is not None, "_birthtime_ns helper is missing"
    assert entry["birthtime_ns"] == birthtime_ns(link.lstat())
    assert "target" not in entry and "size" not in entry


def test_dir_signature_unchanged_by_birthtime(tmp_path):
    (tmp_path / "same.txt").write_text("same", encoding="utf-8")
    entries = workspace_api.list_dir(tmp_path, ".")
    expected = hashlib.sha256(
        json.dumps(
            [
                {
                    "name": entry.get("name"),
                    "path": entry.get("path"),
                    "type": entry.get("type"),
                    "is_dir": entry.get("is_dir"),
                    "size": entry.get("size"),
                    "mtime_ns": entry.get("mtime_ns"),
                    "target": entry.get("target"),
                    "target_outside_workspace": entry.get("target_outside_workspace"),
                }
                for entry in entries
            ],
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    assert workspace_api.dir_signature(tmp_path, ".", entries) == expected
