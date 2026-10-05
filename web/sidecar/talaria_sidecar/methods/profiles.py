"""``profiles.*``: Hermes profile inventory and lifecycle (ported from api/profiles.py).

The server owns the active-profile cookie, ``active_profile`` file reads,
isolated-profile mode, and profile-home resolution. The sidecar owns what
needs Agent code: the profile rows (model/provider/gateway/skill counts),
create/seed/delete through ``hermes_cli.profiles``, and the runtime env.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param
from ..rpc import CallContext
from .config import yaml_parser

log = logging.getLogger("talaria_sidecar.profiles")
_PROFILE_ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
_PROFILE_DIRS = ("skills", "memories", "sessions", "logs", "cron")
_CLONE_CONFIG_FILES = ("config.yaml", ".env", "SOUL.md")
_TERMINAL_ENV = {
    "backend": "TERMINAL_ENV", "env_type": "TERMINAL_ENV", "cwd": "TERMINAL_CWD", "timeout": "TERMINAL_TIMEOUT", "lifetime_seconds": "TERMINAL_LIFETIME_SECONDS",
    "modal_mode": "TERMINAL_MODAL_MODE", "docker_image": "TERMINAL_DOCKER_IMAGE", "docker_forward_env": "TERMINAL_DOCKER_FORWARD_ENV", "docker_env": "TERMINAL_DOCKER_ENV",
    "docker_mount_cwd_to_workspace": "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE", "singularity_image": "TERMINAL_SINGULARITY_IMAGE", "modal_image": "TERMINAL_MODAL_IMAGE",
    "daytona_image": "TERMINAL_DAYTONA_IMAGE", "container_cpu": "TERMINAL_CONTAINER_CPU", "container_memory": "TERMINAL_CONTAINER_MEMORY", "container_disk": "TERMINAL_CONTAINER_DISK",
    "container_persistent": "TERMINAL_CONTAINER_PERSISTENT", "docker_volumes": "TERMINAL_DOCKER_VOLUMES", "persistent_shell": "TERMINAL_PERSISTENT_SHELL", "ssh_host": "TERMINAL_SSH_HOST",
    "ssh_user": "TERMINAL_SSH_USER", "ssh_port": "TERMINAL_SSH_PORT", "ssh_key": "TERMINAL_SSH_KEY", "ssh_persistent": "TERMINAL_SSH_PERSISTENT", "local_persistent": "TERMINAL_LOCAL_PERSISTENT",
}


def _yaml_load(path: Path):
    """A YAML mapping, or None when the file is absent or malformed; a missing parser raises ``yaml_unavailable``."""
    if not path.exists():
        return None
    parser = yaml_parser()
    try:
        data = parser.safe_load(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) else None


def disabled_skill_names(profile_dir: Path) -> set[str]:
    cfg = _yaml_load(profile_dir / "config.yaml") or {}
    skills = cfg.get("skills") if isinstance(cfg.get("skills"), dict) else {}
    platform = (skills.get("platform_disabled") or {}).get("webui") if isinstance(skills.get("platform_disabled"), dict) else None
    value = platform if platform is not None else skills.get("disabled")
    try:
        from agent.skill_utils import parse_config_string_list

        names = parse_config_string_list(value) if isinstance(value, str) else value
    except Exception:  # noqa: BLE001
        names = [value] if isinstance(value, str) else value
    if names is None:
        return set()
    if isinstance(names, str):
        names = [names]
    return {str(v).strip() for v in names if str(v).strip()}


def skills_stats(profile_dir: Path) -> tuple[int, int]:
    """(enabled, compatible) counts parsed from every SKILL.md under the profile."""
    skills_dir = profile_dir / "skills"
    if not skills_dir.is_dir():
        return (0, 0)
    disabled = disabled_skill_names(profile_dir)
    from agent.skill_utils import iter_skill_index_files, parse_frontmatter, skill_matches_platform

    seen: set[str] = set()
    enabled = compatible = 0
    for skill_md in iter_skill_index_files(skills_dir, "SKILL.md"):
        try:
            frontmatter, _ = parse_frontmatter(skill_md.read_text(encoding="utf-8")[:4000])
            if not skill_matches_platform(frontmatter):
                continue
            name = frontmatter.get("name", skill_md.parent.name)[:64]
            if name in seen:
                continue
            seen.add(name)
            compatible += 1
            if name not in disabled:
                enabled += 1
        except Exception:  # noqa: BLE001
            continue
    return enabled, compatible


def _visible(profile_dir: Path) -> bool:
    data = _yaml_load(profile_dir / "profile.yaml")
    return not (isinstance(data, dict) and data.get("visible") is False)


def _row(home: Path, name: str, is_default: bool) -> dict:
    from hermes_cli.profiles import _check_gateway_running, _read_config_model

    try:
        model, provider = _read_config_model(home)
    except Exception:  # noqa: BLE001
        model, provider = None, None
    try:
        gateway_running = bool(_check_gateway_running(home))
    except Exception:  # noqa: BLE001
        gateway_running = False
    enabled, total = skills_stats(home)
    return {
        "name": name, "path": str(home), "is_default": is_default, "gateway_running": gateway_running, "model": model, "provider": provider,
        "has_env": (home / ".env").exists(), "visible": _visible(home), "skill_count": enabled, "enabled_skills": enabled, "total_skills": total,
    }


def list_profiles(base_home: Path) -> list[dict]:
    """Profile rows for the base Hermes home: the root profile plus ``profiles/*``."""
    from hermes_cli.profiles import _PROFILE_ID_RE as UPSTREAM_ID_RE

    rows = []
    if base_home.is_dir():
        rows.append(_row(base_home, "default", True))
    profiles_root = base_home / "profiles"
    if profiles_root.is_dir():
        for entry in sorted(profiles_root.iterdir()):
            if entry.is_dir() and UPSTREAM_ID_RE.match(entry.name):
                rows.append(_row(entry, entry.name, False))
    return rows


def validate_name(name: str) -> None:
    if name == "default":
        raise InvalidParams("Cannot create a profile named 'default' -- it is the built-in profile.")
    if not _PROFILE_ID_RE.fullmatch(name or ""):
        raise InvalidParams(f"Invalid profile name {name!r}. Must match [a-z0-9][a-z0-9_-]{{0,63}}")


def create_profile(base_home: Path, name: str, *, clone_from: str | None, clone_config: bool) -> Path:
    validate_name(name)
    if clone_from is not None and clone_from != "default":
        validate_name(clone_from)
    from .. import home as _home

    with _home.scoped_home(base_home):
        try:
            from hermes_cli.profiles import create_profile as upstream_create

            upstream_create(name, clone_from=clone_from, clone_config=clone_config, clone_all=False, no_alias=True)
        except ImportError:
            profile_dir = base_home / "profiles" / name
            if profile_dir.exists():
                raise RpcError(f"Profile '{name}' already exists.", condition="conflict")
            profile_dir.mkdir(parents=True, exist_ok=False)
            for sub in _PROFILE_DIRS:
                (profile_dir / sub).mkdir(parents=True, exist_ok=True)
            if clone_config and clone_from:
                source = base_home if clone_from == "default" else base_home / "profiles" / clone_from
                if source.is_dir():
                    for filename in _CLONE_CONFIG_FILES:
                        if (source / filename).exists():
                            shutil.copy2(source / filename, profile_dir / filename)
        except FileExistsError as exc:
            raise RpcError(str(exc), condition="conflict") from exc
        except ValueError as exc:
            raise InvalidParams(str(exc)) from exc
        profile_dir = base_home / "profiles" / name
        profile_dir.mkdir(parents=True, exist_ok=True)
        if clone_from is None:
            try:
                from hermes_cli.profiles import seed_profile_skills

                seed_profile_skills(profile_dir, quiet=True)
            except ImportError:
                log.debug("seed_profile_skills unavailable")
            except Exception:  # noqa: BLE001
                log.warning("Bundled skills could not be seeded for profile %s", name, exc_info=True)
    return profile_dir


def delete_profile(base_home: Path, name: str) -> None:
    if name == "default":
        raise InvalidParams("Cannot delete the default profile.")
    validate_name(name)
    from .. import home as _home

    with _home.scoped_home(base_home):
        try:
            from hermes_cli.profiles import delete_profile as upstream_delete

            upstream_delete(name, yes=True)
        except ImportError:
            profile_dir = (base_home / "profiles" / name).resolve()
            profile_dir.relative_to((base_home / "profiles").resolve())
            if not profile_dir.is_dir():
                raise RpcError(f"Profile '{name}' does not exist.", condition="not_found")
            shutil.rmtree(str(profile_dir))
        except FileNotFoundError as exc:
            raise RpcError(str(exc), condition="not_found") from exc
        except ValueError as exc:
            raise InvalidParams(str(exc)) from exc


def runtime_env(home: Path, protected_keys: set[str]) -> dict[str, str]:
    """Env vars an agent turn for this profile home needs (terminal config + .env)."""
    env: dict[str, str] = {}
    cfg = _yaml_load(home / "config.yaml") or {}
    terminal = cfg.get("terminal") if isinstance(cfg.get("terminal"), dict) else {}
    for key, env_key in _TERMINAL_ENV.items():
        if key in terminal and terminal[key] is not None:
            value = terminal[key]
            env[env_key] = ("true" if value else "false") if isinstance(value, bool) else json.dumps(value) if isinstance(value, (list, dict)) else str(value)
    env_path = home / ".env"
    if env_path.exists():
        try:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    if k and v and k not in protected_keys:
                        env[k] = v
        except Exception:  # noqa: BLE001
            log.debug("Failed to read runtime env from %s", env_path)
    return env


def register(registry) -> None:
    @registry.method("profiles.list")
    def list_(ctx: CallContext, params: dict) -> dict:
        return {"profiles": list_profiles(profile_home_param(params, "base_home"))}

    @registry.method("profiles.create")
    def create(ctx: CallContext, params: dict) -> dict:
        base = profile_home_param(params, "base_home")
        name = str(params.get("name") or "").strip()
        path = create_profile(base, name, clone_from=params.get("clone_from"), clone_config=bool(params.get("clone_config", False)))
        rows = list_profiles(base)
        row = next((r for r in rows if r["name"] == name), None) or _row(path, name, False)
        return {"profile": row}

    @registry.method("profiles.delete")
    def delete(ctx: CallContext, params: dict) -> dict:
        base_home, name = profile_home_param(params, "base_home"), str(params.get("name") or "").strip()
        validate_name(name)
        # Idle cached agents end their memory sessions while the profile's home still exists.
        from .chat import release_profile_agents

        release_profile_agents(base_home / "profiles" / name)
        delete_profile(base_home, name)
        return {"ok": True}

    @registry.method("profiles.runtime_env")
    def env(ctx: CallContext, params: dict) -> dict:
        protected = {str(k) for k in (params.get("protected_keys") or [])}
        return {"env": runtime_env(profile_home_param(params), protected)}

    @registry.method("profiles.skills_stats")
    def stats(ctx: CallContext, params: dict) -> dict:
        enabled, total = skills_stats(profile_home_param(params))
        return {"enabled": enabled, "total": total}
