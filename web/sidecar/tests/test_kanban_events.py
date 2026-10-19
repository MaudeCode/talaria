"""Foreign ``task_events.created_at`` text (TAL-990): raw SQL writers can leave ISO timestamps the contract rejects."""

from __future__ import annotations

import contextlib
import pathlib
import sqlite3
from datetime import datetime, timezone

from conftest import SidecarProcess, requires_agent


@requires_agent
def test_events_coerce_text_created_at_and_advance_past_unparseable_rows(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    home = str(hermes_home)
    task_id = handshaken.result("kanban.create_task", {"profile_home": home, "task": {"title": "foreign rows"}})["task"]["id"]
    since = handshaken.result("kanban.events", {"profile_home": home})["cursor"]
    (db,) = hermes_home.rglob("kanban.db")
    with contextlib.closing(sqlite3.connect(db)) as conn, conn:
        conn.executemany(
            "INSERT INTO task_events (task_id, kind, created_at) VALUES (?, 'commented', ?)",
            [(task_id, "2026-05-10T15:00:00Z"), (task_id, "not a time")],
        )

    result = handshaken.result("kanban.events", {"profile_home": home, "since": since})

    iso, garbage = result["events"]
    assert iso["created_at"] == int(datetime(2026, 5, 10, 15, tzinfo=timezone.utc).timestamp())
    assert garbage["created_at"] is None
    assert result["cursor"] == garbage["id"]
