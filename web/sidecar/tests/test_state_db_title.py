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
        # An explicit regeneration is user-requested, so it replaces the manual name.
        assert proc.result("state_db.sync_title", {**params, "title": "Regenerated", "manual": True}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Regenerated", "user")
    finally:
        proc.close()


def test_a_local_summary_title_is_derived_so_a_later_model_title_replaces_it(hermes_home) -> None:
    """TAL-2588: the server's local fallback summary syncs with ``derived`` provenance, below the ``llm`` rank, so the
    model title a later refresh produces still lands. The collision retry keeps the same provenance."""
    _seed(hermes_home, "webui-1")
    _seed(hermes_home, "webui-2")
    proc = SidecarProcess(hermes_home)
    try:
        assert proc.result("state_db.sync_title", {"profile_home": str(hermes_home), "session_id": "webui-2", "title": "Fix the build"}) == {"ok": True}
        params = {"profile_home": str(hermes_home), "session_id": "webui-1"}
        result = proc.result("state_db.sync_title", {**params, "title": "Fix the build", "title_source": "derived"})
        assert_matches("state_db.sync_title", result)
        assert _title(hermes_home, "webui-1") == ("Fix the build #2", "derived")
        assert proc.result("state_db.sync_title", {**params, "title": "Repair the CI pipeline", "title_source": "llm"}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Repair the CI pipeline", "llm")
        # A summary never takes back a model title.
        assert proc.result("state_db.sync_title", {**params, "title": "Fix the build again", "title_source": "derived"}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Repair the CI pipeline", "llm")
    finally:
        proc.close()


def test_a_usage_title_is_a_manual_name_so_a_turn_sends_none_for_an_automatic_title(hermes_home) -> None:
    """TAL-2626: ``state_db.sync_usage`` writes a supplied title with ``user`` provenance, which no automatic title
    replaces, so the server sends one only for a manual name. A usage sync without a title leaves the row to the
    automatic title's own ``derived`` and ``llm`` ranks."""
    _seed(hermes_home, "webui-1")
    params = {"profile_home": str(hermes_home), "session_id": "webui-1"}
    usage = {**params, "input_tokens": 3, "output_tokens": 2, "message_count": 2}
    proc = SidecarProcess(hermes_home)
    try:
        assert proc.result("state_db.sync_usage", usage) == {"ok": True}
        assert proc.result("state_db.sync_title", {**params, "title": "fix docker volume permissions", "title_source": "derived"}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("fix docker volume permissions", "derived")
        assert proc.result("state_db.sync_usage", usage) == {"ok": True}
        assert proc.result("state_db.sync_title", {**params, "title": "Docker volume permissions", "title_source": "llm"}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Docker volume permissions", "llm")
        assert proc.result("state_db.sync_usage", {**usage, "title": "Volume fix"}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Volume fix", "user")
        assert proc.result("state_db.sync_title", {**params, "title": "Docker volumes", "title_source": "llm"}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Volume fix", "user")
    finally:
        proc.close()


def test_a_title_refresh_replaces_an_automatic_title_and_never_a_user_name(hermes_home) -> None:
    """TAL-2631: an adaptive refresh is an ``llm`` title over an earlier ``llm`` one, which the Agent's automatic write
    refuses, so it syncs with ``replace_automatic``: that replaces an ``llm`` or ``derived`` title at ``llm`` provenance,
    keeps the collision retry, and leaves a user's name."""
    _seed(hermes_home, "webui-1")
    _seed(hermes_home, "webui-2")
    one = {"profile_home": str(hermes_home), "session_id": "webui-1"}
    two = {"profile_home": str(hermes_home), "session_id": "webui-2"}
    proc = SidecarProcess(hermes_home)
    try:
        assert proc.result("state_db.sync_title", {**one, "title": "Docker volume permissions", "title_source": "llm"}) == {"ok": True}
        assert proc.result("state_db.sync_title", {**one, "title": "Docker volumes", "title_source": "llm"}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Docker volume permissions", "llm")
        result = proc.result("state_db.sync_title", {**one, "title": "Docker volumes", "title_source": "llm", "replace_automatic": True})
        assert_matches("state_db.sync_title", result)
        assert _title(hermes_home, "webui-1") == ("Docker volumes", "llm")
        assert proc.result("state_db.sync_title", {**two, "title": "fix docker volumes", "title_source": "derived"}) == {"ok": True}
        assert proc.result("state_db.sync_title", {**two, "title": "Docker volumes", "title_source": "llm", "replace_automatic": True}) == {"ok": True}
        assert _title(hermes_home, "webui-2") == ("Docker volumes #2", "llm")
        assert proc.result("state_db.sync_title", {**one, "title": "Volume fix", "manual": True}) == {"ok": True}
        assert proc.result("state_db.sync_title", {**one, "title": "Docker mounts", "title_source": "llm", "replace_automatic": True}) == {"ok": True}
        assert _title(hermes_home, "webui-1") == ("Volume fix", "user")
    finally:
        proc.close()
