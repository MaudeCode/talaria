"""Profile-scoped, bounded SQL reads use disposable board databases and fake Agent boundaries."""
import sqlite3
from types import SimpleNamespace

import pytest

from talaria_sidecar.methods import kanban


def test_inspection_reads_only_live_profile_boards_and_bounds_sql(tmp_path, monkeypatch):
    opened = []
    paths = {}
    for slug in ("default", "ops", "hidden"):
        path = tmp_path / f"{slug}.db"
        paths[slug] = path
        with sqlite3.connect(path) as conn:
            conn.executescript("CREATE TABLE tasks (id TEXT, title TEXT, status TEXT, current_run_id INTEGER); CREATE TABLE task_runs (id INTEGER, started_at INTEGER); CREATE TABLE task_links (parent_id TEXT, child_id TEXT);")
            conn.execute("INSERT INTO tasks VALUES ('same', ?, 'running', 1)", (slug,))
            conn.execute("INSERT INTO task_runs VALUES (1, 100)")
    kb = SimpleNamespace(
        list_boards=lambda **_: [{"slug": s, "archived": s == "hidden"} for s in paths],
        kanban_db_path=lambda slug: opened.append(slug) or paths[slug],
    )
    monkeypatch.setattr(kanban, "_kb", lambda: kb)
    monkeypatch.setattr(kanban, "_board", lambda p: p.get("board"))
    monkeypatch.setattr(kanban, "_normalize_existing_slug", lambda slug: slug)
    monkeypatch.setattr(kanban, "_task_dict", lambda row, _: row)
    view = kanban.inspection_payload({})
    assert [n["key"] for n in view["nodes"]] == ["default/same", "ops/same"]
    assert [n["task"]["current_run_started_at"] for n in view["nodes"]] == [100, 100]
    assert opened == ["default", "ops"]
    with pytest.raises(kanban.NotFound):
        kanban.inspection_payload({"board": "hidden"})
    with sqlite3.connect(paths["default"]) as conn:
        conn.executemany("INSERT INTO tasks VALUES (?, 'bulk', 'todo', NULL)", [(str(i),) for i in range(600)])
        conn.executemany("INSERT INTO task_links VALUES ('1', '2')", [() for _ in range(2100)])
    view = kanban.inspection_payload({})
    assert len(view["nodes"]) == 500
    assert len(view["edges"]) == 2000
    assert view["truncated"] is True
    # A different profile supplies a different board inventory, with no retained graph or SQL handles.
    paths.clear()
    assert kanban.inspection_payload({})["nodes"] == []
