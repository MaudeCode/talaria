"""Board columns follow the Agent's workflow (TAL-796): ``scheduled`` and ``review`` tasks get their own columns."""

from __future__ import annotations

import pathlib
import sqlite3
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent


@requires_agent
def test_repeated_board_reads_skip_schema_and_open_one_connection_per_switcher_board(hermes_home: pathlib.Path) -> None:
    # The Agent owns initialization caching, so a fake cannot prove the native SQL boundary.
    probe = r'''
import sqlite3, sys
sys.path.insert(0, sys.argv[1])
from talaria_sidecar.methods import kanban

statements, opens = [], []
connect = sqlite3.connect
def traced_connect(*args, **kwargs):
    conn = connect(*args, **kwargs)
    opens.append(str(args[0]))
    conn.set_trace_callback(statements.append)
    return conn
sqlite3.connect = traced_connect

def schema_statements():
    return [s for s in statements if s.lstrip().upper().startswith(("CREATE TABLE", "CREATE INDEX", "ALTER TABLE"))]

# The actual task-list RPC is kanban.board. A fresh default board must still initialize itself.
kanban.METHODS["kanban.board"]({})
assert schema_statements(), "cold board did not initialize its schema"
kanban.create_board_payload({"board_spec": {"slug": "work"}})
for board, title in (("default", "Personal"), ("work", "Release")):
    kanban.create_task_payload({"board": board, "task": {"title": title}})

statements.clear()
opens.clear()
for board in ("default", "work"):
    result = kanban.METHODS["kanban.board"]({"board": board})
    assert sum(len(c["tasks"]) for c in result["columns"]) == 1, result
ddl = schema_statements()
print(f"warm task lists: {len(opens)} connections, {len(ddl)} schema statements", flush=True)
assert not ddl, f"warm task-list RPC reran schema migration: {ddl}"
assert len(opens) == 2, opens

statements.clear()
opens.clear()
result = kanban.METHODS["kanban.boards"]({})
boards = result["boards"]
# The switcher shows every total. Metadata listing opens no DB; each board's counts need one.
assert {b["slug"]: b["total"] for b in boards} == {"default": 1, "work": 1}, result
assert all(sum(b["counts"].values()) == b["total"] for b in boards), result
assert len(opens) == len(boards) == 2, opens
assert not schema_statements(), schema_statements()
print(f"switcher: {len(opens)} connections for {len(boards)} boards, 0 schema statements", flush=True)
'''
    result = subprocess.run(
        [AGENT_PYTHON, "-c", probe, str(AGENT_DIR)],
        env=isolated_env(hermes_home), capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@requires_agent
def test_scheduled_and_review_tasks_have_columns_and_leave_through_the_agent_verbs(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    home = {"profile_home": str(hermes_home)}
    ids = {name: handshaken.result("kanban.create_task", {**home, "task": {"title": name}})["task"]["id"] for name in ("plain", "parked", "handed", "approved")}
    db = next(b for b in handshaken.result("kanban.boards", home)["boards"] if b["slug"] == "default")["db_path"]
    with sqlite3.connect(db) as conn:  # the dispatcher's schedule and the implementer's review handoff
        for name, status in (("plain", "ready"), ("parked", "scheduled"), ("handed", "review"), ("approved", "review")):
            conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (status, ids[name]))

    board = handshaken.result("kanban.board", home)
    names = [c["name"] for c in board["columns"]]
    assert names == ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"]
    assert {c["name"]: c["label"] for c in board["columns"]}["review"] == "Review"
    shown = {c["name"]: [t["id"] for t in c["tasks"]] for c in board["columns"]}
    assert (shown["ready"], shown["scheduled"], sorted(shown["review"])) == ([ids["plain"]], [ids["parked"]], sorted([ids["handed"], ids["approved"]]))
    # Each task names the Agent's manual moves from its status, which the server's narrower policy is layered on;
    # an Agent before 0.21.6 publishes no move table.
    review = next(t for c in board["columns"] for t in c["tasks"] if t["id"] == ids["handed"])
    has_workflow = (pathlib.Path(AGENT_DIR) / "hermes_cli" / "kanban_workflow.py").exists()
    assert review["agent_move_targets"] == (["done", "ready", "todo", "triage"] if has_workflow else None)
    assert handshaken.result("kanban.config", home)["columns"] == names

    # A reopened review lands in ready whatever the target, so a move to todo is refused rather than misreported.
    message, _ = handshaken.call("kanban.patch_task", {**home, "task_id": ids["handed"], "patch": {"status": "todo"}})
    assert message.get("error", {}).get("data", {}).get("condition") == "conflict", message
    # Leaving scheduled is the Agent's unblock, leaving review its reopen; both re-gate on parents and land in ready.
    for name in ("parked", "handed"):
        task = handshaken.result("kanban.patch_task", {**home, "task_id": ids[name], "patch": {"status": "ready"}})["task"]
        assert task["status"] == "ready", (name, task)
    # Complete approves a review without stored evidence.
    task = handshaken.result("kanban.patch_task", {**home, "task_id": ids["approved"], "patch": {"status": "done"}})["task"]
    assert task["status"] == "done", task
    # Scheduled needs a wake time and review a reviewer, so a bare status write cannot reach either.
    for status in ("scheduled", "review"):
        message, _ = handshaken.call("kanban.patch_task", {**home, "task_id": ids["plain"], "patch": {"status": status}})
        assert message.get("error", {}).get("code") == -32602, (status, message)
    # Creating a task in either is refused before the insert, so no stray task is left behind.
    total = sum(len(c["tasks"]) for c in handshaken.result("kanban.board", home)["columns"])
    for status in ("scheduled", "review", "running"):
        message, _ = handshaken.call("kanban.create_task", {**home, "task": {"title": status, "status": status}})
        assert message.get("error", {}).get("code") == -32602, (status, message)
    assert sum(len(c["tasks"]) for c in handshaken.result("kanban.board", home)["columns"]) == total
