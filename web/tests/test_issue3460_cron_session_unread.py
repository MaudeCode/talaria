"""Regression coverage for #3460 cron session unread badges."""

from __future__ import annotations

import io
import json
import shutil
import sqlite3
import subprocess
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest


REPO = Path(__file__).resolve().parents[1]
SESSIONS_JS_PATH = REPO / "static" / "sessions.js"
PANELS_JS_PATH = REPO / "static" / "panels.js"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="node not on PATH")


class _JSONHandler:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.response_headers = []
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.response_headers.append((key, value))

    def end_headers(self):
        pass


def _payload(handler):
    return json.loads(handler.wfile.getvalue().decode("utf-8"))


def _run_node(script: str) -> dict:
    assert NODE is not None
    result = subprocess.run(
        [NODE, "-e", script],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return json.loads(result.stdout)


def test_cron_recent_returns_latest_session_id_for_job(monkeypatch, tmp_path):
    import api.routes as routes

    db_path = tmp_path / "state.db"
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT,
                started_at REAL
            )
            """
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES (?, ?, ?)",
            ("cron_job3460_20260610_060000", "cron", 100.0),
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES (?, ?, ?)",
            ("cron_job3460_20260610_070000", "cron", 200.0),
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES (?, ?, ?)",
            ("telegram_job3460_20260610_080000", "telegram", 300.0),
        )

    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")
    cron_jobs.list_jobs = lambda include_disabled=True: [
        {
            "id": "job3460",
            "name": "Morning Briefing",
            "last_run_at": 250,
            "last_status": "success",
        }
    ]
    monkeypatch.setattr(routes, "_active_state_db_path", lambda: db_path)
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    handler = _JSONHandler()
    routes._handle_cron_recent(handler, SimpleNamespace(query="since=0"))

    body = _payload(handler)
    assert handler.status == 200
    assert body["completions"][0]["job_id"] == "job3460"
    assert body["completions"][0]["session_id"] == "cron_job3460_20260610_070000"
    assert body["completions"][0].get("message_count") is None


def test_cron_recent_falls_back_to_id_order_when_started_at_missing(monkeypatch, tmp_path):
    import api.routes as routes

    db_path = tmp_path / "state.db"
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO sessions(id, source) VALUES (?, ?)",
            ("cron_job3460_20260610_060000", "cron"),
        )
        conn.execute(
            "INSERT INTO sessions(id, source) VALUES (?, ?)",
            ("cron_job3460_20260610_070000", "cron"),
        )

    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")
    cron_jobs.list_jobs = lambda include_disabled=True: [
        {
            "id": "job3460",
            "name": "Morning Briefing",
            "last_run_at": 250,
            "last_status": "success",
        }
    ]
    monkeypatch.setattr(routes, "_active_state_db_path", lambda: db_path)
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    handler = _JSONHandler()
    routes._handle_cron_recent(handler, SimpleNamespace(query="since=0"))

    body = _payload(handler)
    assert handler.status == 200
    assert body["completions"][0]["session_id"] == "cron_job3460_20260610_070000"


def test_cron_recent_escapes_like_wildcards_in_job_id(monkeypatch, tmp_path):
    import api.routes as routes

    db_path = tmp_path / "state.db"
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT,
                started_at REAL,
                message_count INTEGER
            )
            """
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at, message_count) VALUES (?, ?, ?, ?)",
            ("cron_job_3460%_20260610_090000", "cron", 300.0, 11),
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at, message_count) VALUES (?, ?, ?, ?)",
            ("cron_jobA3460x_20260610_100000", "cron", 400.0, 99),
        )

    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")
    cron_jobs.list_jobs = lambda include_disabled=True: [
        {
            "id": "job_3460%",
            "name": "Wildcard Job",
            "last_run_at": 500,
            "last_status": "success",
        }
    ]
    monkeypatch.setattr(routes, "_active_state_db_path", lambda: db_path)
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    handler = _JSONHandler()
    routes._handle_cron_recent(handler, SimpleNamespace(query="since=0"))

    body = _payload(handler)
    assert handler.status == 200
    assert body["completions"][0]["session_id"] == "cron_job_3460%_20260610_090000"
    assert body["completions"][0]["message_count"] == 11


def test_cron_recent_does_not_cross_match_shared_job_prefixes(monkeypatch, tmp_path):
    import api.routes as routes

    db_path = tmp_path / "state.db"
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT,
                started_at REAL,
                message_count INTEGER
            )
            """
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at, message_count) VALUES (?, ?, ?, ?)",
            ("cron_backup_20260610_090000", "cron", 100.0, 4),
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at, message_count) VALUES (?, ?, ?, ?)",
            ("cron_backup_full_20260610_100000", "cron", 200.0, 8),
        )

    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")
    cron_jobs.list_jobs = lambda include_disabled=True: [
        {
            "id": "backup",
            "name": "Backup",
            "last_run_at": 150,
            "last_status": "success",
        },
        {
            "id": "backup_full",
            "name": "Backup Full",
            "last_run_at": 250,
            "last_status": "success",
        },
    ]
    monkeypatch.setattr(routes, "_active_state_db_path", lambda: db_path)
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    handler = _JSONHandler()
    routes._handle_cron_recent(handler, SimpleNamespace(query="since=0"))

    body = _payload(handler)
    assert handler.status == 200
    by_id = {item["job_id"]: item for item in body["completions"]}
    assert by_id["backup"]["session_id"] == "cron_backup_20260610_090000"
    assert by_id["backup"]["message_count"] == 4
    assert by_id["backup_full"]["session_id"] == "cron_backup_full_20260610_100000"
    assert by_id["backup_full"]["message_count"] == 8


def test_cron_recent_does_not_steal_older_long_prefix_history_for_short_job(
    monkeypatch, tmp_path
):
    import api.routes as routes

    db_path = tmp_path / "state.db"
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT,
                started_at REAL,
                message_count INTEGER
            )
            """
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at, message_count) VALUES (?, ?, ?, ?)",
            ("cron_backup_full_20260610_110000", "cron", 300.0, 12),
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at, message_count) VALUES (?, ?, ?, ?)",
            ("cron_backup_full_20260610_100000", "cron", 200.0, 8),
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at, message_count) VALUES (?, ?, ?, ?)",
            ("cron_backup_20260610_090000", "cron", 100.0, 4),
        )

    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")
    cron_jobs.list_jobs = lambda include_disabled=True: [
        {
            "id": "backup",
            "name": "Backup",
            "last_run_at": 150,
            "last_status": "success",
        },
        {
            "id": "backup_full",
            "name": "Backup Full",
            "last_run_at": 50,
            "last_status": "success",
        },
    ]
    monkeypatch.setattr(routes, "_active_state_db_path", lambda: db_path)
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    handler = _JSONHandler()
    routes._handle_cron_recent(handler, SimpleNamespace(query="since=0"))

    body = _payload(handler)
    assert handler.status == 200
    assert body["completions"][0]["job_id"] == "backup"
    assert body["completions"][0]["session_id"] == "cron_backup_20260610_090000"
    assert body["completions"][0]["message_count"] == 4


def test_cron_recent_does_not_cross_match_newer_long_prefix_session_when_only_short_job_completed(
    monkeypatch, tmp_path
):
    import api.routes as routes

    db_path = tmp_path / "state.db"
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT,
                started_at REAL,
                message_count INTEGER
            )
            """
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at, message_count) VALUES (?, ?, ?, ?)",
            ("cron_backup_full_20260610_110000", "cron", 300.0, 12),
        )
        conn.execute(
            "INSERT INTO sessions(id, source, started_at, message_count) VALUES (?, ?, ?, ?)",
            ("cron_backup_20260610_090000", "cron", 100.0, 4),
        )

    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")
    cron_jobs.list_jobs = lambda include_disabled=True: [
        {
            "id": "backup",
            "name": "Backup",
            "last_run_at": 250,
            "last_status": "success",
        },
        {
            "id": "backup_full",
            "name": "Backup Full",
            "last_run_at": 150,
            "last_status": "success",
        },
    ]
    monkeypatch.setattr(routes, "_active_state_db_path", lambda: db_path)
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    handler = _JSONHandler()
    routes._handle_cron_recent(handler, SimpleNamespace(query="since=200"))

    body = _payload(handler)
    assert handler.status == 200
    assert body["completions"] == [
        {
            "job_id": "backup",
            "name": "Backup",
            "status": "success",
            "completed_at": 250.0,
            "toast_notifications": True,
            "session_id": "cron_backup_20260610_090000",
            "message_count": 4,
        }
    ]
