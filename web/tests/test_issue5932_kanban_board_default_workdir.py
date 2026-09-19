"""Regression coverage for Kanban board default workdir plumbing."""

import importlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
class _Boards:
    def __init__(self):
        self.boards = {"default": {"slug": "default", "name": "Default", "default_workdir": "/old"}}

    def _normalize_board_slug(self, slug):
        return str(slug).strip()

    def board_exists(self, slug):
        return slug in self.boards

    def create_board(self, slug, **kwargs):
        self.boards.setdefault(slug, {"slug": slug, "name": slug, "archived": False})
        self.boards[slug].update({key: value for key, value in kwargs.items() if value is not None})
        return dict(self.boards[slug])

    def write_board_metadata(self, slug, **kwargs):
        self.boards[slug].update({key: value for key, value in kwargs.items() if value is not None})
        return dict(self.boards[slug])

    def get_current_board(self):
        return "default"

    def set_current_board(self, slug):
        return None


def _bridge(monkeypatch):
    bridge = importlib.import_module("api.kanban_bridge")
    boards = _Boards()
    monkeypatch.setattr(bridge, "_kb", lambda: boards)
    return bridge, boards


def test_board_payload_validates_default_workdir_and_preserves_omission(monkeypatch):
    bridge, boards = _bridge(monkeypatch)
    resolved = Path("/trusted/project")
    calls = []
    monkeypatch.setattr(bridge, "resolve_trusted_workspace", lambda value: calls.append(value) or resolved)

    created = bridge._create_board_payload({"slug": "project", "default_workdir": "  /saved/project  "})
    assert created["board"]["default_workdir"] == str(resolved)
    assert calls == ["/saved/project"]

    bridge._update_board_payload("project", {"name": "Project"})
    assert boards.boards["project"]["default_workdir"] == str(resolved)
    bridge._update_board_payload("project", {"default_workdir": ""})
    assert boards.boards["project"]["default_workdir"] == ""
    assert calls == ["/saved/project"]

    monkeypatch.setattr(bridge, "resolve_trusted_workspace", lambda value: (_ for _ in ()).throw(ValueError("untrusted")))
    try:
        bridge._update_board_payload("project", {"default_workdir": "/outside"})
    except ValueError as exc:
        assert "untrusted" in str(exc)
    else:
        raise AssertionError("untrusted workdir must be rejected")
