"""Board and event polls against a disposable board database and stand-in Agent boundaries, with every statement traced."""

import sqlite3
from contextlib import closing
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
        "CREATE TABLE tasks (id TEXT, status TEXT, claim_lock TEXT, worker_pid INTEGER, worker_started_at INTEGER, assignee TEXT);"
        "CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, run_id INTEGER, kind TEXT, payload TEXT, created_at INTEGER);"
        "INSERT INTO tasks VALUES ('live', 'running', 'here:1', 1, 7, 'alpha'), ('reused', 'running', 'here:2', 2, 8, 'beta'), ('idle', 'ready', NULL, NULL, NULL, NULL);"
        "INSERT INTO task_events (task_id, kind, created_at) VALUES ('live', 'claimed', 1);"
    )
    statements = []
    conn.set_trace_callback(statements.append)
    kb = SimpleNamespace(
        list_tasks=lambda c, *, include_archived, **_: [
            Task(r["id"], r["status"], r["claim_lock"], r["worker_pid"], r["assignee"])
            for r in c.execute("SELECT * FROM tasks ORDER BY id") if include_archived or r["status"] != "archived"
        ],
        # Liveness is the worker's PID plus its start fingerprint, so a reused PID is not the worker.
        _claim_is_live=lambda claim: claim["worker_started_at"] == 7,
        task_age=lambda task: 0,
        _to_epoch=lambda value: value,
    )
    monkeypatch.setattr(kanban, "_kb", lambda: kb)
    monkeypatch.setattr(kanban, "_board", lambda params: None)
    monkeypatch.setattr(kanban, "_conn", lambda board=None: conn)
    monkeypatch.setattr(kanban, "_workflow", lambda: kanban._Workflow((("ready", "Ready"), ("running", "Running")), {}))
    return conn, statements


def test_an_up_to_date_event_poll_reads_no_tasks(board) -> None:
    kanban.events_payload({"since": 1})
    assert [s for s in board[1] if "FROM tasks" in s] == []


def test_an_up_to_date_board_read_with_live_claims_reads_only_running_rows(board, monkeypatch) -> None:
    monkeypatch.setattr(kanban._kb(), "_claim_is_live", lambda claim: True)
    assert kanban.board_payload({"since": 1}) == {"changed": False, "latest_event_id": 1, "read_only": False}
    assert [s for s in board[1] if "FROM tasks" in s] == ["SELECT * FROM tasks WHERE status = 'running'"]


def test_an_up_to_date_board_read_with_a_dead_claim_returns_the_board(board) -> None:
    # A worker that dies writes no event, yet its card's actions change with its liveness.
    result = kanban.board_payload({"since": 1})
    assert result["changed"] is True
    live = {t["id"]: t["claim_live"] for c in result["columns"] for t in c["tasks"]}
    assert live["reused"] is False


def test_a_board_read_judges_each_running_claim_on_its_loaded_row(board) -> None:
    columns = kanban.board_payload({})["columns"]
    live = {t["id"]: t["claim_live"] for c in columns for t in c["tasks"]}
    assert live == {"idle": False, "live": True, "reused": False}
    assert [s for s in board[1] if "FROM tasks WHERE id" in s] == []


def test_board_lists_only_visible_tasks(board) -> None:
    columns = kanban.board_payload({"allowed_assignees": ["alpha"]})["columns"]
    assert {task["id"]: task["read_only"] for column in columns for task in column["tasks"]} == {"live": False, "idle": True}


def test_reassignment_invalidates_scoped_readers_without_disclosing_task_data(board) -> None:
    conn, _ = board
    conn.execute(
        "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) VALUES ('reused', 2, 'assigned', ?, 10)",
        ('{"assignee":"beta"}',),
    )
    result = kanban.events_payload({"since": 1, "allowed_assignees": ["alpha"]})
    assert result["events"] == [
        {"id": 2, "task_id": None, "run_id": None, "kind": "invalidate", "payload": None, "created_at": None},
    ]


def test_scoped_sql_write_guard_is_connection_local_and_checks_the_current_row(tmp_path) -> None:
    database = tmp_path / "board.db"
    with closing(sqlite3.connect(database, isolation_level=None)) as scoped, closing(sqlite3.connect(database, isolation_level=None)) as owner:
        scoped.executescript(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, assignee TEXT, title TEXT);"
            "CREATE TABLE task_links (parent_id TEXT, child_id TEXT);"
            "CREATE TABLE task_comments (task_id TEXT);"
            "INSERT INTO tasks VALUES ('task', 'alpha', 'Original');"
        )
        kanban._guard_task_writes(scoped, {"allowed_assignees": ["alpha"]}, ("task",))
        scoped.execute("UPDATE tasks SET title = 'Allowed' WHERE id = 'task'")
        owner.execute("UPDATE tasks SET assignee = 'beta' WHERE id = 'task'")
        with pytest.raises(sqlite3.IntegrityError, match="outside the allowed assignee scope"):
            scoped.execute("UPDATE tasks SET title = 'Denied' WHERE id = 'task'")
        assert owner.execute("SELECT title FROM tasks WHERE id = 'task'").fetchone() == ("Allowed",)


def test_scoped_board_links_include_authorized_tasks_outside_display_filter(board) -> None:
    conn, _ = board
    conn.executescript(
        "CREATE TABLE task_links (parent_id TEXT, child_id TEXT);"
        "INSERT INTO tasks VALUES ('archived', 'archived', NULL, NULL, NULL, 'alpha');"
        "INSERT INTO task_links VALUES ('archived', 'live'), ('reused', 'live');"
    )
    columns = kanban.board_payload({"allowed_assignees": ["alpha"]})["columns"]
    live = next(task for column in columns for task in column["tasks"] if task["id"] == "live")
    assert live["link_counts"] == {"parents": 1, "children": 0}
