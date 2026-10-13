"""An archived Kanban board is gone (TAL-795): Agent 0.21.6 leaves an ``archived`` ``board.json`` tombstone at its slug."""

from __future__ import annotations

import pathlib

from conftest import SidecarProcess, requires_agent


@requires_agent
def test_an_archived_board_answers_not_found_and_its_slug_can_be_reused(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    home = str(hermes_home)
    handshaken.result("kanban.create_board", {"profile_home": home, "board_spec": {"slug": "proj", "name": "Proj"}})
    task_id = handshaken.result("kanban.create_task", {"profile_home": home, "board": "proj", "task": {"title": "on proj"}})["task"]["id"]
    handshaken.result("kanban.delete_board", {"profile_home": home, "slug": "proj"})

    for method, params in [
        ("kanban.normalize_board", {"board": "proj"}),
        ("kanban.board", {"board": "proj"}),
        ("kanban.events", {"board": "proj"}),
        ("kanban.task", {"board": "proj", "task_id": task_id}),
        ("kanban.create_task", {"board": "proj", "task": {"title": "late"}}),
        ("kanban.switch_board", {"slug": "proj"}),
        ("kanban.delete_board", {"slug": "proj"}),
    ]:
        message, _ = handshaken.call(method, {"profile_home": home, **params})
        assert message.get("error", {}).get("data", {}).get("condition") == "not_found", (method, message)

    handshaken.result("kanban.create_board", {"profile_home": home, "board_spec": {"slug": "proj", "name": "Proj again"}})
    assert handshaken.result("kanban.board", {"profile_home": home, "board": "proj"})["columns"]
    assert handshaken.result("kanban.switch_board", {"profile_home": home, "slug": "proj"})["current"] == "proj"
