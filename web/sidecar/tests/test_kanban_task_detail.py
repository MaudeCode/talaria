"""Task detail names its linked tasks and its current run's start (TAL-809)."""

from __future__ import annotations

import pathlib
import sqlite3

from conftest import SidecarProcess, requires_agent


@requires_agent
def test_task_detail_names_each_linked_task(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    home = {"profile_home": str(hermes_home)}
    parent = handshaken.result("kanban.create_task", {**home, "task": {"title": "Plan the release"}})["task"]["id"]
    child = handshaken.result("kanban.create_task", {**home, "task": {"title": "Write the notes", "parents": [parent]}})["task"]["id"]

    detail = handshaken.result("kanban.task", {**home, "task_id": parent})
    assert detail["links"] == {"parents": [], "children": [child]}
    child_status = handshaken.result("kanban.task", {**home, "task_id": child})["task"]["status"]
    assert detail.get("link_tasks") == [{"id": child, "title": "Write the notes", "status": child_status}]
    assert handshaken.result("kanban.task", {**home, "task_id": child})["link_tasks"] == [{"id": parent, "title": "Plan the release", "status": detail["task"]["status"]}]


@requires_agent
def test_a_retried_tasks_run_clock_counts_from_its_newest_run(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    home = {"profile_home": str(hermes_home)}
    parent = handshaken.result("kanban.create_task", {**home, "task": {"title": "Plan the release"}})["task"]["id"]
    assert handshaken.result("kanban.task", {**home, "task_id": parent})["task"].get("current_run_started_at") is None  # never run

    # A retry: the first run crashed, the dispatcher started a second one, so the clock counts from the newest run.
    db = next(b for b in handshaken.result("kanban.boards", home)["boards"] if b["slug"] == "default")["db_path"]
    with sqlite3.connect(db) as conn:
        conn.execute("INSERT INTO task_runs (task_id, status, started_at, ended_at, outcome) VALUES (?, 'crashed', 1000, 1100, 'crashed')", (parent,))
        newest = conn.execute("INSERT INTO task_runs (task_id, status, started_at) VALUES (?, 'running', 2000)", (parent,)).lastrowid
        conn.execute("UPDATE tasks SET status = 'running', started_at = 1000, current_run_id = ? WHERE id = ?", (newest, parent))
    task = handshaken.result("kanban.task", {**home, "task_id": parent})["task"]
    assert (task["started_at"], task.get("current_run_started_at")) == (1000, 2000)
