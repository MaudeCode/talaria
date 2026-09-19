from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def test_session_new_route_accepts_worktree_flag_and_uses_worktree_info():
    src = read("api/routes.py")
    assert "create_worktree_for_workspace" in src
    assert 'body.get("worktree")' in src or "body.get('worktree')" in src
    assert "worktree_info=" in src
