"""``config.*`` and ``models.reasoning_efforts``: a profile's ``config.yaml`` and ``.env``,
and the Agent's per-model reasoning capability.

The TypeScript server owns every config.yaml *policy* (which keys mean what);
the sidecar only parses and serialises YAML with the Agent's own parser so the
Node side needs no YAML dependency. Writes are atomic and keep the file's mode.
``.env`` edits use the Agent's own line helpers under the ``<.env>.lock`` the
gateway, CLI and plugins also take, so concurrent writers never drop a key.
"""

from __future__ import annotations

import contextlib
import importlib
import logging
import os
import re
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
    try:
        replace = getattr(importlib.import_module("hermes_cli.config"), "atomic_config_replace", None)
    except Exception:  # noqa: BLE001
        # Operator config must remain writable even when Agent imports are broken.
        replace = None
    mode = None
    try:
        mode = target.stat().st_mode & 0o777
    except FileNotFoundError:
        pass
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".config_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            if replace is not None:
                # Stage the original document so the Agent retains comments; check the real link before committing.
                try:
                    handle.write(target.read_text(encoding="utf-8"))
                except FileNotFoundError:
                    pass
            else:
                parser = yaml_parser()
                handle.write(parser.safe_dump(config, sort_keys=False, allow_unicode=True,
                                              width=getattr(parser, "ROUNDTRIP_YAML_WIDTH", 2**31 - 1)))
            handle.flush()
            os.fsync(handle.fileno())
        if replace is not None:
            replace(Path(tmp), config)
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


_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _env_refusal(agent_config, key: str, action: str) -> str | None:
    """The Agent's ``.env`` write-lock refusal (package-managed install or administrator-managed key)."""
    refusal = getattr(agent_config, "env_write_refusal", None)
    if refusal is not None:
        return refusal(key, action)
    # Agent 0.21.5 only reports the refusal on stderr.
    return f"Cannot {action} {key}: this Hermes installation manages it" if agent_config._env_write_blocked(key, action) else None


def _env_lock(agent_config, path: Path):
    """The Agent's ``<.env>.lock`` (Agent 0.21.6+); older Agents have none to share."""
    lock = getattr(agent_config, "_env_write_lock", None)
    return lock(path) if lock is not None else contextlib.nullcontext()


def env_write(home: Path, updates) -> dict:
    """Upsert ``updates`` into ``home``'s ``.env`` (``None`` removes a key) with the Agent's own line helpers, under
    the lock its ``save_env_value`` / ``remove_env_value`` take, in one atomic replace.

    Unlike those two, nothing is published into ``os.environ``: other threads (a gateway spawn snapshotting the
    environment) must never see another profile's key, and ``runtime.env`` alone owns this process's environment.
    Values are trimmed and an empty one is skipped; a line break is refused rather than stripped. Every key is
    checked against the Agent's refusals before the write, and the file ends 0600.
    """
    if not isinstance(updates, dict) or not all(isinstance(k, str) and _ENV_NAME.match(k) and (v is None or isinstance(v, str)) for k, v in updates.items()):
        raise InvalidParams("updates must map variable names to strings or null")
    changes: dict[str, str | None] = {}
    for key, value in updates.items():
        if value is not None:
            value = value.strip()
            if not value:
                continue
            if "\n" in value or "\r" in value:
                raise InvalidParams("API key must not contain newline characters.")
        changes[key] = value
    from hermes_cli import config as agent_config

    with scoped_home(home):
        for key, value in changes.items():
            refusal = _env_refusal(agent_config, key, "remove" if value is None else "set")
            if refusal:
                raise RpcError(refusal, condition="env_write_refused")
        try:
            agent_config.ensure_hermes_home()
            path = agent_config.get_env_path()
            with _env_lock(agent_config, path):
                existed = path.exists()
                lines = agent_config._read_env_lines(path) if existed else []
                before = list(lines)
                for key, value in changes.items():
                    defines = agent_config._env_line_defines_key
                    if value is None:
                        lines = [line for line in lines if not defines(line, key)]
                        continue
                    agent_config.validate_env_var_name_for_write(key)
                    entry = f"{key}={agent_config._quote_env_value(agent_config._check_non_ascii_credential(key, value))}\n"
                    at = next((i for i, line in enumerate(lines) if defines(line, key)), None)
                    if at is not None:
                        lines[at] = entry
                    else:
                        if lines and not lines[-1].endswith("\n"):
                            lines[-1] += "\n"
                        lines.append(entry)
                if lines != before:
                    agent_config._write_env_lines(path, lines, preserve_mode=existed)
        except TimeoutError as exc:
            raise RpcError(str(exc), condition="env_locked") from exc
        except ValueError as exc:
            raise RpcError(str(exc), condition="env_write_refused") from exc
        agent_config.invalidate_env_cache()
        if path.exists():
            os.chmod(path, 0o600)
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

    @registry.method("config.env_write")
    def env_write_(ctx: CallContext, params: dict) -> dict:
        return env_write(profile_home_param(params), params.get("updates"))

    @registry.method("models.reasoning_efforts")
    def efforts(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return reasoning_efforts(str(params.get("model") or ""), str(params.get("provider") or ""))
