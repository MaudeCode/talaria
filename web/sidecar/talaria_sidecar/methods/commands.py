"""``commands.*`` and ``plugins.*`` (ported from api/commands.py, api/plugin_providers.py)."""

from __future__ import annotations

import logging
import threading
from typing import Any

from ..errors import InvalidParams, RpcError
from ..home import _is_named_profile, profile_home_param, scoped_home
from ..rpc import CallContext
from .providers import plugin_providers

log = logging.getLogger("talaria_sidecar.commands")

_NEVER_EXPOSE = frozenset({"sethome", "restart", "update", "commands"})
_ALIASES = {"reload_mcp": "reload-mcp", "reload_skills": "reload-skills", "codex_runtime": "codex-runtime"}
# The commands ``commands.exec`` runs, with the catalog row the sidecar lists when the Agent registry lacks one.
_RUNTIME_COMMANDS = {
    "reload-mcp": ("Reload MCP servers from config", "Tools & Skills", ""),
    "reload-skills": ("Re-scan skills from disk", "Tools & Skills", ""),
    "codex-runtime": ("Toggle codex app-server runtime for OpenAI/Codex models", "Configuration", "[auto|codex_app_server]"),
    "credits": ("Show your Nous credits", "Info", ""),
}
_ALLOWED = frozenset(_RUNTIME_COMMANDS)
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
            "exec": cmd.name in _ALLOWED,
        })
    listed = {c["name"] for c in out}
    for name, (description, category, args_hint) in _RUNTIME_COMMANDS.items():
        if name not in listed:
            out.append({"name": name, "description": description, "category": category, "aliases": [a for a, n in _ALIASES.items() if n == name],
                        "args_hint": args_hint, "subcommands": [], "cli_only": False, "gateway_only": False, "exec": True})
    try:
        from hermes_cli.plugins import get_plugin_commands

        existing = {c["name"] for c in out}
        for name, info in (get_plugin_commands() or {}).items():
            if name in existing or name in _NEVER_EXPOSE:
                continue
            out.append({"name": name, "description": str(info.get("description", "Plugin command")), "category": "Plugin", "aliases": [],
                        "args_hint": str(info.get("args_hint", "")), "subcommands": [], "cli_only": False, "gateway_only": False, "exec": True})
    except Exception:  # noqa: BLE001 - plugin registry is optional
        log.debug("plugin command listing failed", exc_info=True)
    return out


def retire_unscoped_launch_mcp_servers() -> set[str]:
    """Close the launch profile's connections opened before multiplexing started; returns their server names.

    Until the first named-profile call, the launch profile's connections and tools are unscoped (process-wide). Once
    multiplexing is active, a scoped shutdown never selects them and scoped discovery opens duplicates beside them, so
    the launch profile's own calls close them first and its scope reconnects them from the current config."""
    from agent.secret_scope import is_multiplex_active
    from hermes_constants import get_hermes_home
    from tools.mcp_tool import _lock, _servers
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    from tools.mcp_tool_scope import _key_name, _key_scope

    if not is_multiplex_active() or _is_named_profile(get_hermes_home()):
        return set()
    with _lock:
        names = {_key_name(key) for key in _servers if _key_scope(key) is None}
    if names:
        shutdown_mcp_servers(scope=None, names=names)
    return names


def _reload_mcp() -> str:
    with _RELOAD_MCP_LOCK:
        try:
            from agent.secret_scope import is_multiplex_active
            from tools.mcp_tool import _lock, _mcp_tool_server_names, _server_visible_in_scope, _servers
            from tools.mcp_tool_discovery import discover_mcp_tools
            from tools.mcp_tool_lifecycle import shutdown_mcp_servers
            from tools.mcp_tool_scope import _key_name
            from tools.registry import registry
        except Exception as exc:  # noqa: BLE001
            raise RpcError("MCP runtime unavailable", condition="mcp_unavailable") from exc
        # Like the gateway's ``_execute_mcp_reload``: under multiplexing only this profile's connections go down and
        # come back. The bare shutdown is the process-wide wildcard, which would drop every other profile's servers.
        scope = registry.current_scope_key() if is_multiplex_active() else None

        def server_names() -> set[str]:
            with _lock:
                return {_key_name(key) for key in _servers if _server_visible_in_scope(key, scope)}

        try:
            old = server_names() | retire_unscoped_launch_mcp_servers()
            shutdown_mcp_servers(scope=scope)
            tools = discover_mcp_tools() or []
            connected = server_names()
            if scope is not None:
                with _lock:
                    tools = [name for name in tools if _mcp_tool_server_names.get(name) in connected]
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
    lines.append(f"{len(tools)} tool(s) available across {len(connected)} server(s)" if connected else "No MCP servers connected")
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


def _profile_bundles(skill_bundles) -> dict[str, dict[str, Any]]:
    """The scoped profile's bundles keyed ``/slug``, read from disk the way ``scan_bundles`` reads them.

    ``scan_bundles``/``get_skill_bundles`` publish one profile's bundles in a process-wide cache keyed only by mtime,
    which cron jobs in other profiles read concurrently, so the sidecar never fills it."""
    out: dict[str, dict[str, Any]] = {}
    for path in skill_bundles._iter_bundle_files():
        info = skill_bundles._load_bundle_file(path)
        if info:
            out.setdefault(f"/{info['slug']}", info)
    return out


def list_command_bundles() -> list[dict[str, Any]]:
    """The profile's skill bundles as slash-command rows; [] when the bundle runtime is missing or fails."""
    try:
        import agent.skill_bundles as skill_bundles
    except ImportError:
        return []
    try:
        bundles = sorted(_profile_bundles(skill_bundles).values(), key=lambda b: b["slug"])
    except Exception:  # noqa: BLE001
        log.warning("Failed to list skill bundles", exc_info=True)
        return []
    return [{"name": str(b["slug"]).strip().lower(), "description": str(b.get("description") or "").strip() or "Skill bundle",
             "skill_count": len(b.get("skills") or []), "source": "bundle"} for b in bundles if str(b.get("slug") or "").strip()]


def _bundle_invocation(info: dict[str, Any], instruction: str) -> tuple[str, list[str], list[str]] | None:
    """``build_bundle_invocation_message`` for a bundle read by ``_profile_bundles`` (that one looks it up in the shared cache)."""
    from agent.skill_commands import _disabled_skill_names, _load_skill_blocks, _load_skill_payload, _scaffold_header

    name = info["name"]
    loaded, missing, disabled, blocks = _load_skill_blocks(
        [(skill or "").strip() for skill in info["skills"]], _load_skill_payload, lambda _skill: f'[Loaded as part of the "{name}" skill bundle.]',
        None, disabled_names=_disabled_skill_names(None))
    if not blocks:
        return None
    header = _scaffold_header(f'"{name}" skill bundle', loaded, lead_lines=[f"Bundle: {name}"], missing=missing, disabled=disabled,
                              extra_instruction=info.get("instruction") or "", user_instruction=instruction)
    return "\n\n".join([header, *blocks]), loaded, missing


def resolve_bundle_command(command: str) -> dict[str, Any]:
    """Expand ``/<bundle> [instruction]`` into the user message that loads the bundle's skills."""
    name, instruction = parse_slash_command(command)
    try:
        import agent.skill_bundles as skill_bundles
        from agent.skill_commands import resolve_slash_key
    except ImportError as exc:
        raise RpcError("Skill bundle runtime unavailable", condition="bundle_unavailable") from exc
    try:
        bundles = _profile_bundles(skill_bundles)
        key = resolve_slash_key(name, bundles)
        result = _bundle_invocation(bundles[key], instruction) if key else None
    except ValueError as exc:
        raise InvalidParams(str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to resolve skill bundle command", exc_info=True)
        raise RpcError("Skill bundle command unavailable", condition="bundle_unavailable") from exc
    if key is None:
        raise RpcError("Bundle command not found", condition="bundle_not_found")
    message, loaded, missing = result or ("", [], [])
    message = str(message or "").strip()
    if not message:
        raise RpcError("Bundle command returned no invocation text", condition="bundle_unavailable")
    return {"name": key.lstrip("/"), "source": "bundle", "message": message, "loaded_skills": [str(s) for s in loaded or []],
            "missing_skills": [str(s) for s in missing or []]}


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


PLUGIN_VISIBILITY_HOOKS = ("pre_tool_call", "post_tool_call", "pre_llm_call", "post_llm_call")


def _clean_text(value, limit: int = 240) -> str:
    if value is None:
        return ""
    text = " ".join(str(value).replace("\x00", "").split())
    return text[: limit - 1].rstrip() + "…" if len(text) > limit else text


def plugin_visibility(selected_providers: dict) -> dict:
    """Sanitized plugin/hook rows for Settings (Python ``_plugin_visibility_payload``); no paths or callbacks."""
    try:
        from hermes_cli.plugins import get_plugin_manager

        manager = get_plugin_manager()
        manager.discover_and_load(force=False)
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"plugin manager unavailable: {exc}", condition="plugins_unavailable") from exc
    rows = []
    for key, loaded in sorted((getattr(manager, "_plugins", {}) or {}).items(), key=lambda item: str(item[0])):
        manifest = getattr(loaded, "manifest", None)
        if manifest is None:
            continue
        plugin_key = _clean_text(getattr(manifest, "key", None) or key or getattr(manifest, "name", ""), 120)
        name = _clean_text(getattr(manifest, "name", "") or plugin_key, 120)
        kind = _clean_text(getattr(manifest, "kind", "") or "standalone", 40)
        enabled = bool(getattr(loaded, "enabled", False))
        raw_key = plugin_key.replace("\\", "/")
        category = raw_key.split("/", 1)[0].strip() if "/" in raw_key else ""
        if category in {".", ".."}:
            category = ""
        selected = str(selected_providers.get(category) or "").strip().lower() if category else ""
        slug = plugin_key.rsplit("/", 1)[-1].strip().lower()
        if kind == "exclusive":
            activation = "exclusive"
        elif kind == "model-provider" and enabled:
            activation = "provider"
        else:
            activation = "enabled" if enabled else "disabled"
        row = {
            "name": name, "key": plugin_key or name, "version": _clean_text(getattr(manifest, "version", ""), 80),
            "description": _clean_text(getattr(manifest, "description", ""), 280), "enabled": enabled, "kind": kind, "activation": activation,
            "hooks": sorted({str(h).strip() for h in list(getattr(manifest, "provides_hooks", []) or []) + list(getattr(loaded, "hooks_registered", []) or []) if str(h).strip() in PLUGIN_VISIBILITY_HOOKS}, key=PLUGIN_VISIBILITY_HOOKS.index),
        }
        if kind == "exclusive":
            if category:
                row["is_active_provider"] = bool(selected) and slug == selected
        else:
            row["is_active_provider"] = kind == "model-provider" and enabled
        rows.append(row)
    return {"plugins": rows, "supported_hooks": list(PLUGIN_VISIBILITY_HOOKS)}


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

    @registry.method("commands.bundles")
    def bundles(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"bundles": list_command_bundles()}

    @registry.method("commands.bundle_resolve")
    def bundle_resolve(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return resolve_bundle_command(str(params.get("command") or ""))

    @registry.method("commands.moa_preset")
    def moa(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"moa": resolve_moa_config(params.get("preset"))}

    @registry.method("plugins.providers")
    def providers(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"providers": plugin_providers()}

    @registry.method("plugins.list")
    def list_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return plugin_visibility(params.get("selected_providers") if isinstance(params.get("selected_providers"), dict) else {})
