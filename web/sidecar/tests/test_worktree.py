"""TAL-881: ``worktree.create`` never runs the target repository's own git filter programs. Agents from v0.21.6
neutralize them in the checkout; older supported Agents get a refusal instead. Real sidecar, disposable repos."""

from __future__ import annotations

import pathlib
import subprocess

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


def test_a_repository_filter_program_never_runs(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    repo = _repo(hermes_home.parent / "filtered")
    (repo / ".gitattributes").write_text("* filter=evil\n")
    _git("add", ".", cwd=repo)
    _git("commit", "--quiet", "-m", "init", cwd=repo)
    marker = hermes_home.parent / "marker"
    for kind in ("smudge", "clean"):
        _git("config", f"filter.evil.{kind}", f"sh -c 'echo {kind} >> {marker}; cat'", cwd=repo)

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
