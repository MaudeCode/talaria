"""``commands.*`` and ``plugins.*`` (ported from api/commands.py, api/plugin_providers.py)."""

from __future__ import annotations

import logging
import threading
from typing import Any

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.commands")

_NEVER_EXPOSE = frozenset({"sethome", "restart", "update", "commands"})
_ALIASES = {"reload_mcp": "reload-mcp", "reload_skills": "reload-skills", "codex_runtime": "codex-runtime"}
_ALLOWED = frozenset({"reload-mcp", "reload-skills", "codex-runtime", "credits"})
_RELOAD_MCP_LOCK = threading.Lock()
_RELOAD_SKILLS_LOCK = threading.Lock()
_CODEX_RUNTIME_LOCK = threading.Lock()


def parse_slash_command(command: str) -> tuple[str, str]:
    raw = str(command or "").strip()
    if not raw:
        raise InvalidParams("command is required")
    text = raw[1:] if raw.startswith("/") else raw
    parts = text.split(maxsplit=1)
    base = (parts[0] if parts else "").strip().lower()
    if not base:
        raise InvalidParams("command is required")
    return _ALIASES.get(base, base), parts[1] if len(parts) > 1 else ""


def list_commands() -> list[dict[str, Any]]:
    try:
        from hermes_cli.commands import COMMAND_REGISTRY
    except ImportError:
        log.warning("hermes_cli.commands not importable; commands.registry returns []")
        return []
    out: list[dict[str, Any]] = []
    for cmd in COMMAND_REGISTRY:
        if cmd.gateway_only or cmd.name in _NEVER_EXPOSE:
            continue
        out.append({
            "name": cmd.name, "description": cmd.description, "category": cmd.category, "aliases": list(cmd.aliases),
            "args_hint": cmd.args_hint, "subcommands": list(cmd.subcommands), "cli_only": bool(cmd.cli_only), "gateway_only": bool(cmd.gateway_only),
        })
    try:
        from hermes_cli.plugins import get_plugin_commands

        existing = {c["name"] for c in out}
        for name, info in (get_plugin_commands() or {}).items():
            if name in existing or name in _NEVER_EXPOSE:
                continue
            out.append({"name": name, "description": str(info.get("description", "Plugin command")), "category": "Plugin", "aliases": [],
                        "args_hint": str(info.get("args_hint", "")), "subcommands": [], "cli_only": False, "gateway_only": False})
    except Exception:  # noqa: BLE001 - plugin registry is optional
        log.debug("plugin command listing failed", exc_info=True)
    return out


def _reload_mcp() -> str:
    with _RELOAD_MCP_LOCK:
        try:
            from tools.mcp_tool import _lock, _servers, discover_mcp_tools, shutdown_mcp_servers
        except Exception as exc:  # noqa: BLE001
            raise RpcError("MCP runtime unavailable", condition="mcp_unavailable") from exc
        try:
            with _lock:
                old = set(_servers.keys())
            shutdown_mcp_servers()
            tools = discover_mcp_tools()
            with _lock:
                connected = set(_servers.keys())
        except Exception as exc:  # noqa: BLE001
            log.warning("Failed to reload MCP servers", exc_info=True)
            raise RpcError("Failed to reload MCP servers", condition="mcp_reload_failed") from exc
    added, removed, reconnected = connected - old, old - connected, connected & old
    lines = ["Reloaded MCP servers from configuration."]
    if reconnected:
        lines.append(f"Reconnected: {', '.join(sorted(reconnected))}")
    if added:
        lines.append(f"Added: {', '.join(sorted(added))}")
    if removed:
        lines.append(f"Removed: {', '.join(sorted(removed))}")
    lines.append(f"{len(tools or [])} tool(s) available across {len(connected)} server(s)" if connected else "No MCP servers connected")
    if not reconnected and not added and not removed:
        lines.append("Tooling state was already current")
    return "\n".join(lines)


def _reload_skills() -> str:
    with _RELOAD_SKILLS_LOCK:
        try:
            from agent.skill_commands import reload_skills
        except Exception as exc:  # noqa: BLE001
            raise RpcError("Skills runtime unavailable", condition="skills_unavailable") from exc
        try:
            result = reload_skills() or {}
        except Exception as exc:  # noqa: BLE001
            raise RpcError("Failed to reload skills", condition="skills_reload_failed") from exc

    def names(items) -> list[str]:
        out = []
        for item in items or []:
            name = str(item.get("name", "")).strip() if isinstance(item, dict) else str(item).strip()
            if name:
                out.append(name)
        return out

    added, removed = names(result.get("added", [])), names(result.get("removed", []))
    lines = ["Reloaded skills from disk.", f"Added: {len(added)}", f"Removed: {len(removed)}",
             f"Unchanged: {len(list(result.get('unchanged') or []))}", f"Total skills: {int(result.get('total', 0) or 0)}"]
    if added:
        lines.append(f"Added skills: {', '.join(sorted(added))}")
    if removed:
        lines.append(f"Removed skills: {', '.join(sorted(removed))}")
    return "\n".join(lines)


def _codex_runtime(arg_string: str) -> str:
    try:
        from hermes_cli.codex_runtime_switch import apply, parse_args
        from hermes_cli.config import load_config, save_config
    except Exception as exc:  # noqa: BLE001
        raise RpcError("Codex runtime switch unavailable", condition="codex_runtime_unavailable") from exc
    new_value, errors = parse_args(arg_string)
    if errors:
        return "\n".join(str(error) for error in errors)
    with _CODEX_RUNTIME_LOCK:
        try:
            status = apply(load_config(), new_value, persist_callback=save_config)
        except Exception as exc:  # noqa: BLE001
            raise RpcError("Failed to update Codex runtime", condition="codex_runtime_failed") from exc
    return str(getattr(status, "message", "") or "(no output)")


def _credits() -> str:
    try:
        from agent.account_usage import build_credits_view
    except Exception:  # noqa: BLE001
        return "Couldn't fetch credits right now."
    try:
        view = build_credits_view(markdown=True)
    except Exception:  # noqa: BLE001
        log.warning("Failed to build /credits view", exc_info=True)
        return "Couldn't fetch credits right now."
    if not getattr(view, "logged_in", False):
        return "Not logged into Nous. Run `hermes auth login nous` in Hermes CLI, then try /credits again."
    lines = ["💳 **Nous credits**"]
    for line in tuple(getattr(view, "balance_lines", ()) or ()):
        if not str(line).lstrip().startswith("📈"):
            lines.append(str(line))
    identity = str(getattr(view, "identity_line", "") or "").strip()
    if identity:
        lines.extend(["", identity])
    topup = str(getattr(view, "topup_url", "") or "").strip()
    if topup:
        lines.extend(["", f"Top up: {topup}", "Complete your top-up in the browser; credits will appear in /credits shortly."])
    return "\n".join(lines)


def execute_agent_command(command: str) -> str | None:
    """Run one of the allowlisted agent-side runtime commands; None when not one."""
    canonical, arg_string = parse_slash_command(command)
    if canonical not in _ALLOWED:
        return None
    if canonical == "reload-mcp":
        return _reload_mcp()
    if canonical == "reload-skills":
        return _reload_skills()
    if canonical == "codex-runtime":
        return _codex_runtime(arg_string)
    return _credits()


def execute_plugin_command(command: str) -> str | None:
    """Run a plugin-registered slash command; None when no plugin owns it."""
    base, arg = parse_slash_command(command)
    try:
        from hermes_cli.plugins import get_plugin_command_handler, resolve_plugin_command_result
    except ImportError as exc:
        raise RpcError("plugin command runtime unavailable", condition="plugins_unavailable") from exc
    try:
        handler = get_plugin_command_handler(base)
    except Exception as exc:  # noqa: BLE001
        raise RpcError("plugin command lookup failed", condition="plugins_unavailable") from exc
    if not handler:
        return None
    try:
        return str(resolve_plugin_command_result(handler(arg)) or "(no output)")
    except Exception as exc:  # noqa: BLE001 - user-facing text, never a transport error
        log.warning("Plugin command %r execution failed", base, exc_info=True)
        return f"Plugin command error: {type(exc).__name__}"


def resolve_moa_config(preset: str | None) -> dict:
    try:
        from hermes_cli.moa_config import moa_usage, normalize_moa_config
    except ImportError as exc:
        raise RpcError("MoA runtime unavailable (hermes-agent not installed or too old)", condition="moa_unavailable") from exc
    try:
        from hermes_cli.moa_config import resolve_moa_preset
    except ImportError:
        resolve_moa_preset = None
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        raw = cfg.get("moa") if isinstance(cfg, dict) else {}
        moa_cfg = normalize_moa_config(raw)
    except Exception:  # noqa: BLE001
        raw, moa_cfg = {}, normalize_moa_config({})
    name = str(preset or moa_cfg.get("default_preset") or "default").strip()
    if name not in (moa_cfg.get("presets") or {}):
        name = str(moa_cfg.get("default_preset") or "default")
    selected: dict = {}
    if resolve_moa_preset is not None:
        try:
            selected = resolve_moa_preset(raw, name)
            if not isinstance(selected, dict):
                selected = {}
        except Exception:  # noqa: BLE001
            selected, name = {}, str(moa_cfg.get("default_preset") or "default")
    resolved = dict(moa_cfg)
    resolved.update(selected)
    resolved["preset"] = name
    resolved["usage"] = moa_usage()
    return resolved


def plugin_provider_profiles() -> list[dict]:
    """Model-provider plugins registered with the Agent's provider registry."""
    try:
        from providers import list_providers
    except Exception:  # noqa: BLE001
        return []
    out = []
    try:
        for profile in list_providers():
            name = str(getattr(profile, "name", "") or "").strip().lower()
            if not name:
                continue
            env_vars = [str(v) for v in (getattr(profile, "env_vars", ()) or ())]
            api_key_env = next((v for v in env_vars if not v.upper().endswith(("_BASE_URL", "_URL", "_FOLDER_ID"))), None)
            out.append({"name": name, "display_name": str(getattr(profile, "display_name", "") or name).strip(), "env_vars": env_vars, "api_key_env": api_key_env})
    except Exception:  # noqa: BLE001
        log.debug("Failed to enumerate model-provider plugins", exc_info=True)
        return []
    return out


def register(registry) -> None:
    @registry.method("commands.registry")
    def registry_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"commands": list_commands()}

    @registry.method("commands.exec")
    def exec_(ctx: CallContext, params: dict) -> dict:
        command = str(params.get("command") or "")
        with scoped_home(profile_home_param(params)):
            output = execute_agent_command(command)
            source = "agent"
            if output is None:
                output = execute_plugin_command(command)
                source = "plugin"
        if output is None:
            raise RpcError(f"unknown command {parse_slash_command(command)[0]!r}", condition="command_not_found")
        return {"output": output, "source": source}

    @registry.method("commands.moa_preset")
    def moa(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"moa": resolve_moa_config(params.get("preset"))}

    @registry.method("plugins.providers")
    def providers(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"providers": plugin_provider_profiles()}
