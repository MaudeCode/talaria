"""``worktree.*``: Hermes Agent git worktree creation (``hermes_cli.worktree_ops._setup_worktree``)."""

from __future__ import annotations

import io
import logging
import subprocess
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.worktree")


# Repository config can name a program for a filter driver its .gitattributes selects; the checkout runs it.
_REPO_FILTER_KEYS = r"^filter\..*\.(smudge|clean|process)$"


def _refuse_unneutralized_repo_filters(repo_root: str) -> None:
    """Agents before v0.21.6 check out with the repository's filter programs live; refuse a repo that configures one.

    Only global and system config are the user's own; any other scope (local, worktree, an include from either) is
    the repository's. Unreadable config fails closed, matching the Agent's own refusal from v0.21.6.
    """
    try:
        from hermes_cli._subprocess_compat import noninteractive_repo_git_env  # noqa: F401 - v0.21.6+ neutralizes them
        return
    except ImportError:
        pass
    probe = subprocess.run(["git", "-C", repo_root, "config", "--includes", "--show-scope", "-z", "--get-regexp", _REPO_FILTER_KEYS],
                           text=True, capture_output=True, timeout=5, check=False, stdin=subprocess.DEVNULL)
    # -z --show-scope answers "<scope>\0<key>\n<value>\0" per match.
    scopes = set(probe.stdout.split("\0")[::2]) - {""}
    if probe.returncode not in (0, 1) or scopes - {"global", "system"}:
        raise RpcError("This repository configures git filter programs; update Hermes Agent to v0.21.6 or later to create a worktree here",
                       condition="worktree_unsafe_repo")


def create(repo_root: str) -> dict:
    root = Path(repo_root).expanduser()
    if not root.is_dir():
        raise RpcError("Workspace path does not exist or is not a directory", condition="not_a_repo")
    probe = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(root), text=True, capture_output=True, timeout=5, check=False)
    if probe.returncode != 0 or not probe.stdout.strip():
        raise RpcError("Workspace is not inside a git repository", condition="not_a_repo")
    repo = str(Path(probe.stdout.strip()).resolve())
    _refuse_unneutralized_repo_filters(repo)
    from hermes_cli.worktree_ops import _setup_worktree

    output = io.StringIO()
    with redirect_stdout(output), redirect_stderr(output):
        info = _setup_worktree(repo)
    emitted = output.getvalue().strip()
    if emitted:
        log.debug("Hermes Agent worktree helper output: %s", emitted)
    if not info or not info.get("path") or not info.get("branch"):
        raise RpcError("Hermes Agent failed to create a git worktree", condition="worktree_failed")
    return {
        "path": str(Path(info["path"]).expanduser().resolve()),
        "branch": str(info["branch"]),
        "repo_root": str(Path(info.get("repo_root") or probe.stdout.strip()).expanduser().resolve()),
        "base": str(info["base"]) if info.get("base") else None,
    }


def register(registry) -> None:
    @registry.method("worktree.create")
    def create_(ctx: CallContext, params: dict) -> dict:
        repo_root = params.get("repo_root")
        if not isinstance(repo_root, str) or not repo_root.strip():
            raise InvalidParams("repo_root is required")
        with scoped_home(profile_home_param(params)):
            return create(repo_root)
