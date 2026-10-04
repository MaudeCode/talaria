"""``config.*`` and ``models.reasoning_efforts``: a profile's ``config.yaml`` and the
Agent's per-model reasoning capability.

The TypeScript server owns every config.yaml *policy* (which keys mean what);
the sidecar only parses and serialises YAML with the Agent's own parser so the
Node side needs no YAML dependency. Writes are atomic and keep the file's mode.
"""

from __future__ import annotations

import importlib
import logging
import os
import tempfile
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.config")


def yaml_parser():
    """The Agent's YAML module: ``hermes_yaml`` on Agents that ship it, PyYAML on released Agents."""
    failures = []
    for name in ("hermes_yaml", "yaml"):
        try:
            return importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{name}: {exc}")
    raise RpcError(f"No YAML parser available ({'; '.join(failures)})", condition="yaml_unavailable")


def config_path_param(params: dict) -> Path:
    """The server-resolved config file (``HERMES_CONFIG_PATH`` aware); defaults to ``<profile_home>/config.yaml``."""
    raw = params.get("config_path")
    if raw is None:
        return profile_home_param(params) / "config.yaml"
    if not isinstance(raw, str) or not raw.strip():
        raise InvalidParams("config_path must be a non-empty string")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise InvalidParams("config_path must be absolute")
    return path


def read_config(path: Path) -> dict:
    if not path.exists():
        return {"path": str(path), "exists": False, "config": {}}
    try:
        data = yaml_parser().safe_load(path.read_text(encoding="utf-8"))
    except RpcError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"config.yaml is not valid YAML: {exc}", condition="config_invalid") from exc
    if data is not None and not isinstance(data, dict):
        raise RpcError("config.yaml must contain a mapping", condition="config_invalid")
    return {"path": str(path), "exists": True, "config": data if data is not None else {}}


def _write_target(path: Path) -> Path:
    """Where the bytes land: a symlinked config.yaml (operator-managed file) is updated through its referent."""
    if not path.is_symlink():
        return path
    target = path.resolve()
    if target.is_dir():
        raise RpcError(f"{path} links to a directory", condition="config_invalid")
    return target


def write_config(path: Path, config: dict) -> dict:
    if not isinstance(config, dict):
        raise InvalidParams("config must be an object")
    target = _write_target(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    text = yaml_parser().safe_dump(config, sort_keys=False, allow_unicode=True)
    mode = None
    try:
        mode = target.stat().st_mode & 0o777
    except FileNotFoundError:
        pass
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".config_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        # A link retargeted while the temp file was being written would otherwise send the write to the wrong file.
        if _write_target(path) != target:
            raise RpcError(f"{path} was retargeted while config.yaml was being written; retry", condition="config_changed")
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return {"ok": True, "path": str(path)}


def reasoning_efforts(model: str, provider: str) -> dict:
    """Levels the Agent would offer for ``model`` on ``provider`` (``hermes_cli.main_provider_setup``)."""
    efforts: list[str] | None = None
    supports_reasoning: bool | None = None
    try:
        from hermes_cli.main_provider_setup import _main_model_reasoning_efforts

        efforts = _main_model_reasoning_efforts(model, provider)
    except Exception:  # noqa: BLE001
        log.debug("_main_model_reasoning_efforts(%r, %r) failed", model, provider, exc_info=True)
    try:
        from agent.models_dev import get_model_capabilities

        meta = get_model_capabilities(provider, model)
        if meta is not None:
            supports_reasoning = bool(getattr(meta, "supports_reasoning", False))
    except Exception:  # noqa: BLE001
        pass
    return {"efforts": [str(e) for e in (efforts or [])], "supports_reasoning": supports_reasoning}


def register(registry) -> None:
    @registry.method("config.get", requires_agent=False)
    def get(ctx: CallContext, params: dict) -> dict:
        return read_config(config_path_param(params))

    @registry.method("config.set", requires_agent=False)
    def set_(ctx: CallContext, params: dict) -> dict:
        return write_config(config_path_param(params), params.get("config"))

    @registry.method("models.reasoning_efforts")
    def efforts(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return reasoning_efforts(str(params.get("model") or ""), str(params.get("provider") or ""))
