from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def test_worktree_archive_delete_api_responses_are_explicit():
    src = read("api/routes.py")
    assert "def _worktree_retained_payload(session)" in src
    assert "def _worktree_retained_payload_for_session_id(sid: str)" in src
    assert '"worktree_retained": True' in src
    assert '"state_db_cleanup_failed": state_db_cleanup_failed' in src
    assert '"ok": True,' in src
    assert "**worktree_retained," in src
    assert '{"ok": True, "session": s.compact(), **_worktree_retained_payload(s)}' in src
