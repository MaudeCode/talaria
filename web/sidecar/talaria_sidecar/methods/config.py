"""``config.*`` and ``models.reasoning_efforts``: a profile's ``config.yaml`` and the
Agent's per-model reasoning capability.

The TypeScript server owns every config.yaml *policy* (which keys mean what);
the sidecar only parses and serialises YAML with the Agent's PyYAML so the Node
side needs no YAML dependency. Writes are atomic and keep the file's mode.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.config")


def _yaml():
    try:
        import yaml
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"PyYAML unavailable: {exc}", condition="yaml_unavailable") from exc
    return yaml


def read_config(home: Path) -> dict:
    path = home / "config.yaml"
    if not path.exists():
        return {"path": str(path), "exists": False, "config": {}}
    try:
        data = _yaml().safe_load(path.read_text(encoding="utf-8"))
    except RpcError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"config.yaml is not valid YAML: {exc}", condition="config_invalid") from exc
    return {"path": str(path), "exists": True, "config": data if isinstance(data, dict) else {}}


def write_config(home: Path, config: dict) -> dict:
    if not isinstance(config, dict):
        raise InvalidParams("config must be an object")
    path = home / "config.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    text = _yaml().safe_dump(config, sort_keys=False, allow_unicode=True)
    mode = None
    try:
        mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        pass
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".config_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
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
    @registry.method("config.get", requires_agent=True)
    def get(ctx: CallContext, params: dict) -> dict:
        return read_config(profile_home_param(params))

    @registry.method("config.set", requires_agent=True)
    def set_(ctx: CallContext, params: dict) -> dict:
        return write_config(profile_home_param(params), params.get("config"))

    @registry.method("models.reasoning_efforts")
    def efforts(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return reasoning_efforts(str(params.get("model") or ""), str(params.get("provider") or ""))
