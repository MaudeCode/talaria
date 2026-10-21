"""TAL-1254: ``worktree.retain`` relocks a Talaria worktree for the running sidecar under the Agent's ``hermes pid=``
lock contract, leaves every other lock as it was, and reports a tree git no longer has as missing. Plain git only."""

from __future__ import annotations

import os
import pathlib
import subprocess

from talaria_sidecar.methods.worktree import _admin_dir, _take_lock, retain_all

_ENV = {"PATH": "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}


def _git(*args: str, cwd: pathlib.Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, env=_ENV, check=True, capture_output=True, text=True).stdout


def _lock_reason(repo: pathlib.Path, tree: pathlib.Path) -> str | None:
    for block in _git("worktree", "list", "--porcelain", cwd=repo).split("\n\n"):
        lines = block.splitlines()
        if lines and lines[0] == f"worktree {tree}":
            return next((line.removeprefix("locked").strip() for line in lines if line.startswith("locked")), None)
    raise AssertionError(f"{tree} is not a worktree of {repo}")


def test_retain_relocks_only_hermes_pid_locks_and_reports_missing_trees(tmp_path: pathlib.Path) -> None:
    repo = (tmp_path / "repo").resolve()
    repo.mkdir()
    _git("init", "--quiet", "-b", "main", cwd=repo)
    _git("commit", "--quiet", "--allow-empty", "-m", "init", cwd=repo)
    exited = subprocess.Popen(["true"])
    exited.wait()
    locks = {"unlocked": None, "exited": f"hermes pid={exited.pid}", "running": f"hermes pid={os.getppid()}", "impossible": "hermes pid=99999999999999999999",
             "user": "on my external drive", "bare": "", "removed": None, "deleted": None}
    trees = {}
    for name, reason in locks.items():
        trees[name] = repo / ".worktrees" / name
        _git("worktree", "add", "--quiet", "-b", name, str(trees[name]), cwd=repo)
        if reason is not None:
            _git("worktree", "lock", *(["--reason", reason] if reason else []), str(trees[name]), cwd=repo)
    _git("worktree", "remove", str(trees["removed"]), cwd=repo)
    subprocess.run(["rm", "-rf", str(trees["deleted"])], check=True)

    results = retain_all([str(path) for path in trees.values()])

    # A live other owner is left alone and left out, so the server retries until this sidecar holds the lock.
    assert results == {str(trees["unlocked"]): "retained", str(trees["exited"]): "retained", str(trees["impossible"]): "retained",
                       str(trees["user"]): "foreign_lock", str(trees["bare"]): "foreign_lock",
                       str(trees["removed"]): "missing", str(trees["deleted"]): "missing"}
    ours = f"hermes pid={os.getpid()}"
    assert {name: _lock_reason(repo, trees[name]) for name in ("unlocked", "exited", "impossible", "running", "user", "bare")} == {
        "unlocked": ours, "exited": ours, "impossible": ours, "running": locks["running"], "user": locks["user"], "bare": ""}


def test_a_lock_replaced_after_it_was_read_is_kept(tmp_path: pathlib.Path) -> None:
    repo = (tmp_path / "repo").resolve()
    repo.mkdir()
    _git("init", "--quiet", "-b", "main", cwd=repo)
    _git("commit", "--quiet", "--allow-empty", "-m", "init", cwd=repo)
    tree = repo / ".worktrees" / "tree"
    _git("worktree", "add", "--quiet", "-b", "tree", str(tree), cwd=repo)
    _git("worktree", "lock", "--reason", "on my external drive", str(tree), cwd=repo)
    admin = _admin_dir(tree)
    assert admin is not None

    assert not _take_lock(admin, "hermes pid=1")
    assert _lock_reason(repo, tree) == "on my external drive"
    assert [p.name for p in admin.iterdir() if p.name.startswith("locked.")] == []
