"""``checkpoints.*``: a workspace's filesystem checkpoints through the Agent's own ``CheckpointManager`` (TAL-913).

The Agent keeps every project's checkpoints as refs in one shared git store under the profile home; listing, diffing and
restoring go through its manager so the store layout, the nested-repository refusal and the pre-rollback snapshot stay
the Agent's.
"""

from __future__ import annotations

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext


def checkpoint_kwargs() -> dict:
    """The profile's ``checkpoints`` config as ``AIAgent`` kwargs, resolved as the Agent's gateway does
    (``gateway/run.py::_checkpoint_agent_kwargs``): the legacy ``checkpoints: true`` form, else the section over
    ``DEFAULT_CONFIG``. Only a real ``true`` turns them on, so a quoted ``"false"`` stays off."""
    from hermes_cli.config import DEFAULT_CONFIG, load_config

    section = (load_config() or {}).get("checkpoints", {})
    if isinstance(section, bool):
        section = {"enabled": section}
    elif not isinstance(section, dict):
        section = {}
    defaults = DEFAULT_CONFIG["checkpoints"]
    return {
        "checkpoints_enabled": section.get("enabled", defaults["enabled"]) is True,
        "checkpoint_max_snapshots": section.get("max_snapshots", defaults["max_snapshots"]),
        "checkpoint_max_total_size_mb": section.get("max_total_size_mb", defaults["max_total_size_mb"]),
        "checkpoint_max_file_size_mb": section.get("max_file_size_mb", defaults["max_file_size_mb"]),
    }


def _manager():
    from tools.checkpoint_manager import CheckpointManager

    kwargs = checkpoint_kwargs()
    return CheckpointManager(enabled=kwargs["checkpoints_enabled"], max_snapshots=kwargs["checkpoint_max_snapshots"],
                             max_total_size_mb=kwargs["checkpoint_max_total_size_mb"], max_file_size_mb=kwargs["checkpoint_max_file_size_mb"])


def _param(params: dict, name: str) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value.strip():
        raise InvalidParams(f"{name} is required")
    return value


def _agent_result(result: dict) -> dict:
    """The Agent answers a refusal (unknown checkpoint, uncaptured nested repository, failed checkout) as ``success: False``."""
    if not result.get("success"):
        raise RpcError(str(result.get("error") or "checkpoint operation failed"), condition="checkpoint_failed")
    return result


def _paths(result: dict, key: str) -> list[str]:
    return [str(f) for f in result.get(key) or []]


def _owned(manager, workspace: str, checkpoint: str) -> str:
    """The full hash of ``checkpoint`` among ``workspace``'s own checkpoints. The store is shared by every project and the
    Agent's diff and restore accept any commit in it, so another workspace's hash would check that tree out here."""
    matches = [c["hash"] for c in manager.list_checkpoints(workspace) if c.get("hash") and str(c["hash"]).startswith(checkpoint.lower())]
    if len(matches) != 1:
        raise RpcError(f"Checkpoint '{checkpoint}' is not a checkpoint of this workspace", condition="checkpoint_failed")
    return matches[0]


def register(registry) -> None:
    @registry.method("checkpoints.list")
    def list_(ctx: CallContext, params: dict) -> dict:
        workspace = _param(params, "workspace")
        with scoped_home(profile_home_param(params)):
            from tools.checkpoint_manager import _store_path

            return {"checkpoints": _manager().list_checkpoints(workspace), "store": str(_store_path())}

    @registry.method("checkpoints.diff")
    def diff(ctx: CallContext, params: dict) -> dict:
        workspace, checkpoint = _param(params, "workspace"), _param(params, "checkpoint")
        with scoped_home(profile_home_param(params)):
            manager = _manager()
            result = _agent_result(manager.diff(workspace, _owned(manager, workspace, checkpoint)))
        return {"stat": str(result.get("stat") or ""), "diff": str(result.get("diff") or "")}

    @registry.method("checkpoints.restore")
    def restore(ctx: CallContext, params: dict) -> dict:
        """Safe by default, as the Agent's own ``rollback.restore`` (TAL-1260): only files whose content is still what the
        Agent last wrote are reverted, and the hand-edited ones it kept are reported. ``all`` restores every file. Without an
        agent-write ledger the Agent falls back to a full restore and ``restored_files`` is null."""
        workspace, checkpoint = _param(params, "workspace"), _param(params, "checkpoint")
        with scoped_home(profile_home_param(params)):
            manager = _manager()
            result = _agent_result(manager.restore(workspace, _owned(manager, workspace, checkpoint), safe=params.get("all") is not True))
        return {"restored_to": str(result.get("restored_to") or ""), "reason": str(result.get("reason") or ""),
                "restored_files": _paths(result, "restored_files") if isinstance(result.get("restored_files"), list) else None,
                "kept_user_edits": _paths(result, "skipped_user_edits"), "skipped_oversize": _paths(result, "skipped_oversize"),
                "failed_deletes": _paths(result, "failed_deletes")}
