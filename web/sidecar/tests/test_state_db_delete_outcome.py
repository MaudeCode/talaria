"""TAL-2673: without a state.db there is no Agent row to retire, so ``state_db.delete_cli_session`` reports the delete
committed and the server goes on to remove Talaria's copy; a pending cleanup manifest it cannot check stays ``ok`` false.
In-process, no Agent imports."""

from __future__ import annotations

from talaria_sidecar.methods import state_db


def test_a_missing_state_db_is_a_committed_delete_with_nothing_removed(tmp_path) -> None:
    assert state_db.delete_cli_session(tmp_path, "cli-a") == {"ok": True, "committed": True, "deleted_ids": []}
    (tmp_path / "sessions").mkdir()
    (tmp_path / "sessions" / ".cleanup_manifest_pending.json").write_text('["cli-gone"]', encoding="utf-8")
    assert state_db.delete_cli_session(tmp_path, "cli-a") == {"ok": False, "committed": True, "deleted_ids": []}
