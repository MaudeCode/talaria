"""TAL-574: ``state_db.sync_title`` writes a manual rename with ``user`` provenance, so it replaces an earlier generated
(``llm``) title in the Agent's state.db. Real sidecar, pinned Agent."""

from __future__ import annotations

import sqlite3
from contextlib import closing

from conftest import SidecarProcess, assert_matches, requires_agent
from test_handoff_methods import _seed

pytestmark = requires_agent


def _title(home, session_id: str) -> tuple:
    with closing(sqlite3.connect(home / "state.db")) as db:
        return db.execute("SELECT title, title_source FROM sessions WHERE id = ?", (session_id,)).fetchone()


def test_a_manual_rename_replaces_a_generated_title(hermes_home) -> None:
    _seed(hermes_home, "webui-1")
    params = {"profile_home": str(hermes_home), "session_id": "webui-1"}
    proc = SidecarProcess(hermes_home)
    try:
        assert proc.result("state_db.sync_title", {**params, "title": "Generated title"}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Generated title", "llm")
        result = proc.result("state_db.sync_title", {**params, "title": "Renamed", "manual": True})
        assert_matches("state_db.sync_title", result)
        assert result == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Renamed", "user")
        # A later generated title never overwrites the user's name.
        assert proc.result("state_db.sync_title", {**params, "title": "Generated again"}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Renamed", "user")
    finally:
        proc.close()
