"""TAL-1821: ``state_db.request_prompt_refresh`` records the Agent's profile-wide refresh epoch, so every continuing
session rebuilds its stored system prompt on its next turn. Real sidecar, each supported Agent."""

from __future__ import annotations

import pathlib
import sqlite3
from contextlib import closing

from conftest import AGENT_DIR, SidecarProcess, assert_matches, requires_agent
from test_handoff_methods import _seed

pytestmark = requires_agent


def _epoch(home) -> int | None:
    with closing(sqlite3.connect(home / "state.db")) as db:
        return db.execute("SELECT MAX(CAST(value AS INTEGER)) FROM state_meta WHERE key LIKE 'prompt_refresh.%'").fetchone()[0]


def test_each_request_advances_the_epoch_on_an_agent_that_has_it(hermes_home) -> None:
    params = {"profile_home": str(hermes_home)}
    proc = SidecarProcess(hermes_home)
    try:
        # No state.db means no session to refresh, and asking does not create one.
        assert proc.result("state_db.request_prompt_refresh", params) == {"ok": False}
        assert not (hermes_home / "state.db").exists()
        _seed(hermes_home, "webui-1")
        result = proc.result("state_db.request_prompt_refresh", params)
        assert_matches("state_db.request_prompt_refresh", result)
        if not (pathlib.Path(AGENT_DIR) / "hermes_state_prompt_refresh.py").exists():  # before v0.22.6
            assert result == {"ok": False}
            assert _epoch(hermes_home) is None
            return
        assert result == {"ok": True}
        assert _epoch(hermes_home) == 1
        assert proc.result("state_db.request_prompt_refresh", params) == {"ok": True}
        assert _epoch(hermes_home) == 2
    finally:
        proc.close()
