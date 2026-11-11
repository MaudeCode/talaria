"""Board and event polls against a disposable board database and stand-in Agent boundaries, with every statement traced."""

import sqlite3
from dataclasses import dataclass
from types import SimpleNamespace

import pytest

from talaria_sidecar.methods import kanban


@dataclass
class Task:  # the Agent's Task carries no worker_started_at
    id: str
    status: str
    claim_lock: str | None
    worker_pid: int | None
    assignee: str | None = None
    tenant: str | None = None


@pytest.fixture
def board(monkeypatch):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        "CREATE TABLE tasks (id TEXT, status TEXT, claim_lock TEXT, worker_pid INTEGER, worker_started_at INTEGER);"
        "CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, run_id INTEGER, kind TEXT, payload TEXT, created_at INTEGER);"
        "INSERT INTO tasks VALUES ('live', 'running', 'here:1', 1, 7), ('reused', 'running', 'here:2', 2, 8), ('idle', 'ready', NULL, NULL, NULL);"
        "INSERT INTO task_events (task_id, kind, created_at) VALUES ('live', 'claimed', 1);"
    )
    statements = []
    conn.set_trace_callback(statements.append)
    kb = SimpleNamespace(
        list_tasks=lambda c, **_: [Task(r["id"], r["status"], r["claim_lock"], r["worker_pid"]) for r in c.execute("SELECT * FROM tasks ORDER BY id")],
        # Liveness is the worker's PID plus its start fingerprint, so a reused PID is not the worker.
        _claim_is_live=lambda claim: claim["worker_started_at"] == 7,
        task_age=lambda task: 0,
        _to_epoch=lambda value: value,
    )
    monkeypatch.setattr(kanban, "_kb", lambda: kb)
    monkeypatch.setattr(kanban, "_board", lambda params: None)
    monkeypatch.setattr(kanban, "_conn", lambda board=None: conn)
    monkeypatch.setattr(kanban, "_workflow", lambda: kanban._Workflow((("ready", "Ready"), ("running", "Running")), None))
    return statements


@pytest.mark.parametrize("method", [kanban.board_payload, kanban.events_payload])
def test_an_up_to_date_poll_reads_no_tasks(board, method) -> None:
    method({"since": 1})
    assert [s for s in board if "FROM tasks" in s] == []


def test_a_board_read_judges_each_running_claim_on_its_loaded_row(board) -> None:
    columns = kanban.board_payload({})["columns"]
    live = {t["id"]: t["claim_live"] for c in columns for t in c["tasks"]}
    assert live == {"idle": False, "live": True, "reused": False}
    assert [s for s in board if "FROM tasks WHERE id" in s] == []
