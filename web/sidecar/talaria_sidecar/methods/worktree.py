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


def _setup_worktree_fn():
    try:
        from hermes_cli.worktree_ops import _setup_worktree

        return _setup_worktree
    except Exception:  # noqa: BLE001 - older Agents keep the helper in cli.py
        pass
    try:
        import importlib.util

        import hermes_cli

        spec = importlib.util.spec_from_file_location("hermes_cli_worktree", str(Path(hermes_cli.__file__).resolve().parent.parent / "cli.py"))
        if spec is None or spec.loader is None:
            raise RuntimeError("cli.py not found")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module._setup_worktree
    except Exception as exc:  # noqa: BLE001
        raise RpcError("Hermes Agent worktree helper is unavailable", condition="worktree_unavailable") from exc


def create(repo_root: str) -> dict:
    root = Path(repo_root).expanduser()
    if not root.is_dir():
        raise RpcError("Workspace path does not exist or is not a directory", condition="not_a_repo")
    probe = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(root), text=True, capture_output=True, timeout=5, check=False)
    if probe.returncode != 0 or not probe.stdout.strip():
        raise RpcError("Workspace is not inside a git repository", condition="not_a_repo")
    setup = _setup_worktree_fn()
    output = io.StringIO()
    with redirect_stdout(output), redirect_stderr(output):
        info = setup(str(Path(probe.stdout.strip()).resolve()))
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
