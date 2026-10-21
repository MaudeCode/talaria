"""``worktree.*``: Hermes Agent git worktree creation (``hermes_cli.worktree_ops._setup_worktree``) and lock retention."""

from __future__ import annotations

import io
import logging
import os
import re
import subprocess
import uuid
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.worktree")


# Repository config can name a program for a filter driver its .gitattributes selects; the checkout runs it. A
# conditional include (onbranch:, gitdir:) can hold one back until the new worktree's checkout, so it counts too.
_REPO_FILTER_KEYS = r"^(filter\..*\.(smudge|clean|process)|includeif\..*\.path)$"


def _refuse_unneutralized_repo_filters(repo_root: str) -> None:
    """Agents before v0.21.6 check out with the repository's filter programs live; refuse a repo that configures one.

    Only global and system config are the user's own; any other scope (local, worktree, an include from either) is
    the repository's. Unreadable config fails closed, matching the Agent's own refusal from v0.21.6, and so does any
    repository conditional include: this probe cannot evaluate it for the branch and gitdir the worktree will have.
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
        raise RpcError("This repository's git config can run filter programs; update Hermes Agent to v0.21.6 or later to create a worktree here",
                       condition="worktree_unsafe_repo")


# The Agent's own lock contract (``worktree_ops._worktree_lock_is_live``): its sweep keeps a tree whose ``hermes pid=`` owner runs.
_HERMES_PID_LOCK = re.compile(r"hermes pid=(\d+)(?: db=.+)?", re.DOTALL)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, OverflowError):  # gone, or a pid no process can have
        return False
    except OSError:
        return True  # exists, owned by someone else
    return True


# Only these say the tree or its registration is gone; any other read failure leaves the tree unconfirmed (raised).
_GONE = (FileNotFoundError, NotADirectoryError, IsADirectoryError)


def _admin_dir(tree: Path) -> Path | None:
    """The tree's ``<common-dir>/worktrees/<name>`` entry when git still registers it as a linked worktree."""
    try:
        link = (tree / ".git").read_text(encoding="utf-8-sig")
    except _GONE:
        return None
    if not link.startswith("gitdir:"):
        return None
    admin = (tree / link[len("gitdir:"):].strip()).resolve()
    try:
        registered = Path((admin / "gitdir").read_text(encoding="utf-8-sig").strip()).resolve()
    except _GONE:
        return None
    return admin if admin.parent.name == "worktrees" and registered == (tree / ".git").resolve() else None


def _take_lock(admin: Path, expected: str) -> bool:
    """Remove the tree's lock only while it still reads ``expected``: it is moved aside first, so a lock written since it
    was read is never deleted; anything else is put back unless a newer lock already holds the tree."""
    lock, aside = admin / "locked", admin / f"locked.talaria-{uuid.uuid4().hex}"
    try:
        os.rename(lock, aside)
    except FileNotFoundError:
        return True
    try:
        if aside.read_text(encoding="utf-8-sig", errors="replace").strip(" \t\n\v\f\r") == expected:
            return True
        try:
            os.link(aside, lock)
        except FileExistsError:
            pass
        return False
    finally:
        aside.unlink(missing_ok=True)


def retain(path: str) -> str:
    """Lock a Talaria worktree for this process, so the Agent's sweep reads its lock live (TAL-1254).

    ``missing`` when the tree is gone or git no longer registers it; ``foreign_lock`` when a lock that is not a ``hermes
    pid=`` lock (a user's own) holds it, which stays untouched. A ``hermes pid=`` lock of an exited process is replaced;
    one of a live other process (a reused pid, another instance) is left alone and raises, so the caller retries until
    this sidecar holds the lock.
    """
    tree = Path(path)
    admin = _admin_dir(tree)
    if admin is None:
        return "missing"
    ours = f"hermes pid={os.getpid()}"
    try:
        reason = (admin / "locked").read_text(encoding="utf-8-sig", errors="replace").strip(" \t\n\v\f\r")
    except FileNotFoundError:
        reason = None
    if reason == ours:
        return "retained"
    if reason is not None:
        lock = _HERMES_PID_LOCK.fullmatch(reason)
        if lock is None:
            return "foreign_lock"
        if int(lock.group(1)) != os.getpid() and _pid_alive(int(lock.group(1))):
            raise OSError(f"locked by running pid {lock.group(1)}")
        if not _take_lock(admin, reason):
            raise OSError("the lock changed while it was being replaced")
    # git refuses to lock a tree someone locked meanwhile, so that lock stays too.
    locked = subprocess.run(["git", "-C", str(tree), "worktree", "lock", "--reason", ours, str(tree)],
                            capture_output=True, timeout=10, check=False, stdin=subprocess.DEVNULL)
    if locked.returncode != 0:
        raise OSError(locked.stderr.decode(errors="replace").strip() or "git worktree lock failed")
    return "retained"


def retain_all(paths: list[str]) -> dict[str, str]:
    """``retain`` per path; a tree this sidecar cannot lock now is left out (unknown), never reported missing."""
    results = {}
    for path in dict.fromkeys(paths):
        try:
            results[path] = retain(path)
        except (OSError, subprocess.SubprocessError) as exc:
            log.warning("Could not retain worktree %s: %s", path, exc)
    return results


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
    path = str(Path(info["path"]).expanduser().resolve())
    retain_all([path])  # one owner for Talaria's lock text
    return {
        "path": path,
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

    @registry.method("worktree.retain")
    def retain_(ctx: CallContext, params: dict) -> dict:
        paths = params.get("paths")
        if not isinstance(paths, list) or not all(isinstance(p, str) and p for p in paths):
            raise InvalidParams("paths must be a list of worktree paths")
        return {"results": retain_all(paths)}
