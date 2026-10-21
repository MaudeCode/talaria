"""TAL-881: ``worktree.create`` never runs the target repository's own git filter programs. Agents from v0.21.6
neutralize them in the checkout; older supported Agents get a refusal instead. TAL-1254: ``worktree.retain`` keeps a
Talaria worktree's lock live for the Agent's own sweep after a restart. Real sidecar, disposable repos."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import time

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent

pytestmark = requires_agent


def _git(*args: str, cwd: pathlib.Path) -> None:
    env = {"PATH": "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
    subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)


def _repo(path: pathlib.Path) -> pathlib.Path:
    path.mkdir()
    _git("init", "--quiet", "-b", "main", cwd=path)
    (path / "notes.txt").write_text("hello\n")
    return path.resolve()


def _agent_neutralizes_repo_filters(home: pathlib.Path) -> bool:
    probe = "from hermes_cli._subprocess_compat import noninteractive_repo_git_env"
    return subprocess.run([AGENT_PYTHON, "-c", probe], env=isolated_env(home, PYTHONPATH=str(AGENT_DIR)), capture_output=True, timeout=60).returncode == 0


@pytest.mark.parametrize("source", ["repo config", "include on the new branch"])
def test_a_repository_filter_program_never_runs(handshaken: SidecarProcess, hermes_home: pathlib.Path, source: str) -> None:
    repo = _repo(hermes_home.parent / "filtered")
    (repo / ".gitattributes").write_text("* filter=evil\n")
    _git("add", ".", cwd=repo)
    _git("commit", "--quiet", "-m", "init", cwd=repo)
    marker = hermes_home.parent / "marker"
    # An onbranch include stays inert in the source checkout and applies only once the hermes/ branch is checked out.
    target = hermes_home.parent / "evil.cfg" if source != "repo config" else None
    if target:
        _git("config", "includeIf.onbranch:hermes/**.path", str(target), cwd=repo)
    for kind in ("smudge", "clean"):
        _git("config", *(["--file", str(target)] if target else []), f"filter.evil.{kind}", f"sh -c 'echo {kind} >> {marker}; cat'", cwd=repo)

    message, _ = handshaken.call("worktree.create", {"profile_home": str(hermes_home), "repo_root": str(repo)})

    assert not marker.exists(), f"repository filter ran: {marker.read_text().split()}"
    if _agent_neutralizes_repo_filters(hermes_home):
        assert pathlib.Path(message["result"]["path"]).is_dir(), message
    else:
        assert message["error"]["data"]["condition"] == "worktree_unsafe_repo", message


def test_a_clean_repository_gets_a_worktree(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    repo = _repo(hermes_home.parent / "clean")
    _git("add", ".", cwd=repo)
    _git("commit", "--quiet", "-m", "init", cwd=repo)

    result = handshaken.result("worktree.create", {"profile_home": str(hermes_home), "repo_root": str(repo)})

    path = pathlib.Path(result["path"])
    assert (path / "notes.txt").read_text() == "hello\n"
    assert result["repo_root"] == str(repo) and result["branch"].startswith("hermes/")


def _lock_reason(tree: pathlib.Path) -> str | None:
    admin = tree / tree.joinpath(".git").read_text().split("gitdir:", 1)[1].strip()
    locked = admin.resolve() / "locked"
    return locked.read_text().strip() if locked.exists() else None


def _abandoned(handshaken: SidecarProcess, hermes_home: pathlib.Path, repo: pathlib.Path) -> pathlib.Path:
    """A Talaria worktree with uncommitted work, idle for two days, whose lock names a sidecar that has since exited."""
    tree = pathlib.Path(handshaken.result("worktree.create", {"profile_home": str(hermes_home), "repo_root": str(repo)})["path"])
    (tree / "draft.txt").write_text("unsaved work\n")
    exited = subprocess.Popen(["true"])
    exited.wait()
    _git("worktree", "unlock", str(tree), cwd=repo)
    _git("worktree", "lock", "--reason", f"hermes pid={exited.pid}", str(tree), cwd=repo)
    admin = (tree / tree.joinpath(".git").read_text().split("gitdir:", 1)[1].strip()).resolve()
    old = time.time() - 48 * 3600
    for path in (tree / "draft.txt", admin / "HEAD", admin / "logs" / "HEAD", tree):
        os.utime(path, (old, old))
    return tree


_SWEEP = """
import json, sys
try:
    from hermes_cli import worktree_sweep
except ImportError:
    print("null"); raise SystemExit
settings = worktree_sweep.sweep_settings()
plan = worktree_sweep.plan_sweep(sys.argv[1], 24, settings)
worktree_sweep.execute_plan(sys.argv[1], plan, settings)
print(json.dumps({d.name: d.action for d in plan}))
"""


def test_a_retained_worktree_survives_the_agents_sweep_after_a_restart(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    repo = _repo(hermes_home.parent / "project")
    _git("add", ".", cwd=repo)
    _git("commit", "--quiet", "-m", "init", cwd=repo)
    kept, control = _abandoned(handshaken, hermes_home, repo), _abandoned(handshaken, hermes_home, repo)

    handshaken.call("worktree.retain", {"paths": [str(kept)]})
    swept = subprocess.run([AGENT_PYTHON, "-c", _SWEEP, str(repo)], env=isolated_env(hermes_home, PYTHONPATH=str(AGENT_DIR)),
                           capture_output=True, text=True, timeout=120, check=True)
    plan = json.loads(swept.stdout.strip().splitlines()[-1])

    assert (kept / "draft.txt").exists(), f"retained worktree was swept: {plan}"
    assert _lock_reason(kept) == f"hermes pid={handshaken.proc.pid}"
    if plan is not None:  # v0.22.3 added the sweep; earlier releases never remove a dirty tree
        assert plan == {kept.name: "skip-live-lock", control.name: "archive-remove"}, plan
        assert not control.exists()
