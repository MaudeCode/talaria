"""``commands.*`` and ``plugins.*`` (ported from api/commands.py, api/plugin_providers.py)."""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import json
import logging
import os
import pathlib
import secrets
import threading
import time
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
# Commands ``commands.exec`` runs through the Agent's registry executor (``hermes_cli.slash_exec``), so the reply is the
# Agent's own; an Agent whose registry lacks one neither lists nor runs it.
_REGISTRY_EXECUTED = frozenset({"autoprune"})
_ALLOWED = frozenset(_RUNTIME_COMMANDS) | _REGISTRY_EXECUTED
_RELOAD_MCP_LOCK = threading.Lock()
_RELOAD_SKILLS_LOCK = threading.Lock()
_CODEX_RUNTIME_LOCK = threading.Lock()
_MCP_DISCOVERED_HOMES: set[str] = set()
_MCP_DISCOVERED_LOCK = threading.Lock()
_PLUGIN_UPDATE_CONSENTS: dict[str, dict] = {}
_PLUGIN_UPDATE_CONSENT_LOCK = threading.Lock()


def _split_slash_command(command: str) -> tuple[str, str]:
    """The command name as typed (lowercase, no slash) and its raw arguments."""
    raw = str(command or "").strip()
    if not raw:
        raise InvalidParams("command is required")
    text = raw[1:] if raw.startswith("/") else raw
    parts = text.split(maxsplit=1)
    base = (parts[0] if parts else "").strip().lower()
    if not base:
        raise InvalidParams("command is required")
    return base, parts[1] if len(parts) > 1 else ""


def parse_slash_command(command: str) -> tuple[str, str]:
    base, args = _split_slash_command(command)
    return _ALIASES.get(base, base), args


def _expand_plan(args: str, **_turn) -> str:
    from agent.plan_prompt import build_plan_prompt

    return build_plan_prompt(args)


def _expand_learn(args: str, **_turn) -> str:
    from agent.learn_prompt import build_learn_prompt

    return build_learn_prompt(args)


def _expand_init(args: str, *, workspace: str, **_turn) -> str:
    from hermes_cli.init_command import build_init_prompt_for_cwd

    # The Agent falls back to the process cwd for a missing directory; the sidecar's is never the user's project.
    if not workspace or not os.path.isdir(workspace):
        raise InvalidParams("workspace is not a directory")
    return build_init_prompt_for_cwd(cwd=workspace, extra=args)


def _expand_initiate_setup(_args: str, *, enabled_toolsets, **_turn) -> str:
    from agent.initiate_setup_prompt import build_initiate_setup_prompt
    from hermes_cli.setup_profile import primary_profile
    from hermes_constants import get_hermes_home
    from model_tools import get_tool_definitions

    from .chat import _turn_toolsets
    from .toolsets import disabled_toolsets

    # The gateway's ``_hm_cmd_initiate_setup``: the tools this turn's agent gets, by name. MCP servers connect first, as
    # chat start connects them before its agent snapshots tools; a failure leaves them out, as it does for the turn.
    try:
        discover_profile_mcp_tools()
    except Exception:  # noqa: BLE001
        log.warning("MCP discovery failed", exc_info=True)
    tools = get_tool_definitions(enabled_toolsets=_turn_toolsets(enabled_toolsets), disabled_toolsets=disabled_toolsets(),
                                 quiet_mode=True, skip_tool_search_assembly=True)
    return build_initiate_setup_prompt("webui", [tool["function"]["name"] for tool in tools], primary_profile(get_hermes_home()))


# The Agent built-ins every surface answers by rewriting the turn to a builder's prompt (the gateway's
# ``_hm_rewrite_turn_to_prompt``), with the Agent module each expander needs. ``None``: no expander yet, so no client
# offers it (``/blueprint`` seeds a turn only after its own slot parsing and job wiring).
_PROMPT_BUILTINS: dict[str, tuple[Any, str] | None] = {
    "plan": (_expand_plan, "agent.plan_prompt"),
    "learn": (_expand_learn, "agent.learn_prompt"),
    "init": (_expand_init, "hermes_cli.init_command"),
    "initiate-setup": (_expand_initiate_setup, "agent.initiate_setup_prompt"),
    "blueprint": None,
}


def _prompt_expander(name: str):
    """The expander for a prompt built-in this Agent ships the builder for; None when it has none."""
    entry = _PROMPT_BUILTINS.get(name)
    if entry is None:
        return None
    try:
        found = importlib.util.find_spec(entry[1]) is not None
    except (ImportError, ValueError):
        found = False
    return entry[0] if found else None


def _prompt_mode(name: str) -> str | None:
    if name not in _PROMPT_BUILTINS:
        return None
    return "expand" if _prompt_expander(name) else "unsupported"


def expand_prompt(command: str, workspace: str, enabled_toolsets, session_id: str = "") -> dict[str, Any]:
    """``/<prompt built-in> [args]`` as the turn text the Agent's own builder writes. ``name`` is the built-in's (None
    when the command is not one) and ``message`` None when this Agent has no builder for it."""
    try:
        name, args = parse_slash_command(command)
        from hermes_cli.commands import resolve_command
    except (InvalidParams, ImportError):
        return {"name": None, "message": None}
    cmd = resolve_command(name)
    if cmd is None or cmd.name not in _PROMPT_BUILTINS:
        return {"name": None, "message": None}
    # TAL-1279: as the CLI does, before it expands or refuses the built-in.
    _fire_pre_command(command, session_id, cmd.name, workspace)
    expander = _prompt_expander(cmd.name)
    if expander is None:
        return {"name": cmd.name, "message": None}
    try:
        message = str(expander(args, workspace=workspace, enabled_toolsets=enabled_toolsets) or "").strip()
    except InvalidParams:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to expand /%s", cmd.name, exc_info=True)
        raise RpcError(f"Couldn't start /{cmd.name}", condition="prompt_expand_failed") from exc
    if not message:
        raise RpcError(f"Couldn't start /{cmd.name}", condition="prompt_expand_failed")
    return {"name": cmd.name, "message": message}


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
            "exec": cmd.name in _ALLOWED, "prompt": _prompt_mode(cmd.name),
        })
    listed = {c["name"] for c in out}
    for name, (description, category, args_hint) in _RUNTIME_COMMANDS.items():
        if name not in listed:
            out.append({"name": name, "description": description, "category": category, "aliases": [a for a, n in _ALIASES.items() if n == name],
                        "args_hint": args_hint, "subcommands": [], "cli_only": False, "gateway_only": False, "exec": True, "prompt": None})
    try:
        from hermes_cli.plugins import get_plugin_commands

        existing = {c["name"] for c in out}
        for name, info in (get_plugin_commands() or {}).items():
            if name in existing or name in _NEVER_EXPOSE:
                continue
            out.append({"name": name, "description": str(info.get("description", "Plugin command")), "category": "Plugin", "aliases": [],
                        "args_hint": str(info.get("args_hint", "")), "subcommands": [], "cli_only": False, "gateway_only": False, "exec": True, "prompt": None})
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


def discover_profile_mcp_tools() -> list[str]:
    """Connect this profile's configured servers, retiring pre-multiplex launch connections first."""
    from hermes_constants import get_hermes_home
    from tools.mcp_tool_discovery import discover_mcp_tools

    retire_unscoped_launch_mcp_servers()
    tools = discover_mcp_tools()
    with _MCP_DISCOVERED_LOCK:
        _MCP_DISCOVERED_HOMES.add(os.path.realpath(get_hermes_home()))
    return tools


def profile_mcp_tools_discovered(home) -> bool:
    """A completed discovery, including an empty registry, establishes this process's profile baseline."""
    with _MCP_DISCOVERED_LOCK:
        return os.path.realpath(home) in _MCP_DISCOVERED_HOMES


def forget_profile_mcp_tools(home) -> None:
    """A successfully deleted profile must start cold if its path is recreated."""
    with _MCP_DISCOVERED_LOCK:
        _MCP_DISCOVERED_HOMES.discard(os.path.realpath(home))


def _reload_mcp() -> str:
    with _RELOAD_MCP_LOCK:
        try:
            from agent.secret_scope import is_multiplex_active
            from hermes_constants import get_hermes_home
            from tools.mcp_tool import _lock, _mcp_tool_server_names, _server_visible_in_scope, _servers
            from tools.mcp_tool_agent import reprobe_tool_availability
            from tools.mcp_tool_lifecycle import shutdown_mcp_servers
            from tools.mcp_tool_scope import _key_name
            from tools.registry import registry

            from .chat import refresh_profile_agents_mcp_tools
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
            # As the gateway does: drop the cached tool availability verdicts, then hand the profile's open chats the
            # rediscovered tools.
            reprobe_tool_availability()
            tools = discover_profile_mcp_tools() or []
            refresh_profile_agents_mcp_tools(get_hermes_home())
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


def _fire_pre_command(command: str, session_id: str, canonical: str | None = None, workspace: str = "") -> None:
    """The Agent's observer-only ``pre_command`` hook, which every local surface fires before a recognised command runs.
    A chat's observers run under that chat's session and workspace, as its plugin commands and turns do."""
    from hermes_cli.plugins import fire_pre_command_hook

    from .chat import _turn_identity

    typed, arg = _split_slash_command(command)
    with _turn_identity(session_id, workspace) if session_id else contextlib.nullcontext():
        fire_pre_command_hook(surface="webui", command=canonical or _ALIASES.get(typed, typed), alias_used=typed, args_raw=arg,
                              session_key=session_id or None, platform="webui")


def _registry_executor(name: str):
    """The Agent registry's shared executor for ``name``; None when this Agent has none."""
    try:
        from hermes_cli.commands import resolve_command
        from hermes_cli.slash_exec import resolve_executor
    except ImportError:
        return None
    cmd = resolve_command(name)
    return resolve_executor(cmd) if cmd is not None else None


def execute_agent_command(command: str, session_id: str = "", workspace: str = "") -> str | None:
    """Run one of the allowlisted agent-side runtime commands; None when not one."""
    canonical, arg_string = parse_slash_command(command)
    if canonical not in _ALLOWED:
        return None
    executor = _registry_executor(canonical) if canonical in _REGISTRY_EXECUTED else None
    if canonical in _REGISTRY_EXECUTED and executor is None:
        return None
    _fire_pre_command(command, session_id, workspace=workspace)
    if executor is not None:
        from hermes_cli.slash_exec import CommandContext

        return str(executor(CommandContext(surface="webui", args=arg_string)).text or "(no output)")
    if canonical == "reload-mcp":
        return _reload_mcp()
    if canonical == "reload-skills":
        return _reload_skills()
    if canonical == "codex-runtime":
        return _codex_runtime(arg_string)
    return _credits()


def _invoke_plugin_handler(handler, arg: str, session_id: str):
    """``handler(arg)`` plus the session context it declares, as every Agent surface calls it (v0.22.3+)."""
    try:
        from hermes_cli.plugin_command_dispatch import invoke_plugin_command
    except ImportError:  # Delete this fallback once v0.22.3 is the oldest supported Agent.
        return handler(arg)
    return invoke_plugin_command(handler, arg, source=None, session_id=session_id, session_key=session_id, platform="webui")


def execute_plugin_command(command: str, session_id: str = "") -> str | None:
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
    _fire_pre_command(command, session_id)
    try:
        return str(resolve_plugin_command_result(_invoke_plugin_handler(handler, arg, session_id)) or "(no output)")
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
    """``build_bundle_invocation_message`` for a bundle read by ``_profile_bundles`` (that one looks it up in the shared cache),
    skipping the skills disabled for Web chat (``skills.platform_disabled.webui``)."""
    from agent.skill_commands import _disabled_skill_names, _load_skill_blocks, _load_skill_payload, _scaffold_header

    name = info["name"]
    loaded, missing, disabled, blocks = _load_skill_blocks(
        [(skill or "").strip() for skill in info["skills"]], _load_skill_payload, lambda _skill: f'[Loaded as part of the "{name}" skill bundle.]',
        None, disabled_names=_disabled_skill_names("webui"))
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


def _plugin_update_modules():
    try:
        from hermes_cli import plugins_cmd, plugins_transaction
        from hermes_cli.plugins_cadence import cached_git_updates
    except ImportError:
        return None
    return plugins_cmd, plugins_transaction, cached_git_updates


def update_plugin(key: str, accept_caution: bool, consent_token: str | None = None) -> dict:
    """The Agent owns Git staging, scan consent and publication, under the caller's profile scope."""
    if not key or not isinstance(accept_caution, bool) or (consent_token is not None and not isinstance(consent_token, str)):
        raise InvalidParams("plugins.update requires a key and boolean accept_caution")
    modules = _plugin_update_modules()
    if modules is None:
        raise RpcError("This Hermes Agent cannot update plugins from Web", condition="plugin_update_unsupported")
    pc, transaction, _cached = modules
    found = pc._find_plugin_entry(key)
    if found is None or not found[4]:
        raise RpcError(f"plugin {key!r} not found", condition="plugin_not_found")
    from hermes_constants import get_hermes_home
    target = pathlib.Path(str(found[4])).resolve()
    # Only profile-owned installs, never bundled, project or entrypoint plugins.
    if target.parent != (get_hermes_home() / "plugins").resolve():
        raise InvalidParams("Only profile-installed Git plugins can be updated")
    from pm.store import tree_digest
    from tools.plugin_guard import format_scan_report

    def installed_identity():
        return (str(get_hermes_home().resolve()), str(target.resolve()), found[5], tree_digest(target),
                json.dumps(pc._read_install_metadata().get(target.name, {}), sort_keys=True))

    identity = installed_identity()
    with _PLUGIN_UPDATE_CONSENT_LOCK:
        now = time.monotonic()
        for token, receipt in list(_PLUGIN_UPDATE_CONSENTS.items()):
            if receipt["expires"] <= now:
                _PLUGIN_UPDATE_CONSENTS.pop(token)
        consent = _PLUGIN_UPDATE_CONSENTS.pop(consent_token, None) if accept_caution and consent_token else None
    if accept_caution and consent_token and (consent is None or consent["identity"] != identity):
        raise RpcError("Plugin update confirmation expired or the installation changed; update again to review its scan",
                       condition="plugin_update_consent_changed")

    revision = ""
    consent_changed = False
    changed_message = "The plugin installation or revision changed; update again to review its scan"

    # The Agent staging hook exposes the candidate commit before its scan and publication gates.
    def capture_revision(staged):
        nonlocal revision, consent_changed
        if not staged.resolve().is_relative_to(target.parent) or installed_identity() != identity:
            consent_changed = True
            raise pc.PluginOperationError(changed_message)
        revision = pc._git_head_revision(staged, pc._resolve_git_executable())
        if consent and consent["revision"] != revision:
            consent_changed = True
            raise pc.PluginOperationError(changed_message)
        return []

    def scan_binding(scan):
        payload = json.dumps([format_scan_report(scan), getattr(scan, "scan_provenance", {}),
                              [vars(finding) for finding in getattr(scan, "findings", [])]], sort_keys=True)
        return hashlib.sha256(payload.encode()).hexdigest()

    def accept_scan(scan):
        nonlocal consent_changed
        if installed_identity() != identity:
            consent_changed = True
            return False
        return consent is not None and consent["revision"] == revision and consent["scan"] == scan_binding(scan)

    try:
        # A blanket force would bypass the callback: only the exact scanned identity can accept caution.
        transaction.update_plugin(target, force=False, scan_decision_cb=accept_scan, carry_user_files=capture_revision)
    except pc.PluginScanBlocked as exc:
        if consent_changed:
            raise RpcError(changed_message, condition="plugin_update_consent_changed") from exc
        scan = exc.scan_result
        verdict = getattr(scan, "verdict", "dangerous")
        result = {"key": found[5], "status": "needs_consent" if verdict == "caution" else "blocked",
                  "verdict": verdict, "findings": str(exc)}
        if verdict == "caution":
            token = secrets.token_urlsafe(32)
            with _PLUGIN_UPDATE_CONSENT_LOCK:
                if len(_PLUGIN_UPDATE_CONSENTS) >= 64:
                    _PLUGIN_UPDATE_CONSENTS.pop(next(iter(_PLUGIN_UPDATE_CONSENTS)))
                _PLUGIN_UPDATE_CONSENTS[token] = {"identity": identity, "revision": revision, "scan": scan_binding(scan),
                                                 "expires": time.monotonic() + 300}
            result["consent_token"] = token
        return result
    except pc.PluginOperationError as exc:
        raise RpcError(str(exc), condition="plugin_update_consent_changed" if consent_changed else "plugin_update_refused") from exc
    from hermes_cli.plugins import discover_plugins
    discover_plugins(force=True)
    return {"key": found[5], "status": "updated"}


def plugin_visibility(selected_providers: dict) -> dict:
    """Sanitized plugin/hook rows for Settings (Python ``_plugin_visibility_payload``); no paths or callbacks."""
    try:
        from hermes_cli.plugins import get_plugin_manager

        manager = get_plugin_manager()
        manager.discover_and_load(force=False)
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"plugin manager unavailable: {exc}", condition="plugins_unavailable") from exc
    modules = _plugin_update_modules()
    updates = None
    if modules:
        from hermes_cli.plugins_provenance import read_sidecar_rows
        from hermes_constants import get_hermes_home
        updates = modules[2](read_sidecar_rows(get_hermes_home() / "plugins"))
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
        if updates is not None:
            installed = pathlib.Path(str(getattr(manifest, "path", "") or "")).resolve()
            owned = installed.parent == (get_hermes_home() / "plugins").resolve() and (installed / ".git").is_dir()
            revision = updates.get(installed.name) if owned else None
            row["update_available"] = bool(revision)
            if revision:
                row["latest_revision"] = revision
        rows.append(row)
    return {"plugins": rows, "supported_hooks": list(PLUGIN_VISIBILITY_HOOKS)}


def isolation_survey(base_home: pathlib.Path) -> list[dict]:
    """Each profile's ``plugins.isolation`` and installed third-party plugin count, read from disk without loading a plugin."""
    from hermes_cli.plugin_isolation import isolation_mode
    from hermes_cli.plugins_cmd import _scan_level

    from .profiles import _yaml_load, named_profile_homes

    rows = []
    for name, home in [("default", base_home), *named_profile_homes(base_home)]:
        seen: dict = {}
        _scan_level(home / "plugins", "user", set(), "", 0, seen)
        rows.append({"name": name, "isolation": isolation_mode(_yaml_load(home / "config.yaml") or {}), "third_party_plugins": len(seen)})
    return rows


def _plugin_settings_modules():
    """The Agent's manifest ``config_schema`` reader/writer (v0.21.6+) and its plugin resolver; ``None`` on older Agents."""
    try:
        import hermes_cli.plugins_cmd as plugins_cmd
        import hermes_cli.plugins_settings as plugins_settings
    except ImportError:
        return None
    return plugins_cmd, plugins_settings


def plugin_settings() -> dict:
    """Every discovered plugin whose manifest declares settings, with its fields (secrets as ``env`` + ``has_value`` only)."""
    modules = _plugin_settings_modules()
    if modules is None:
        return {"supported": False, "plugins": []}
    plugins_cmd, plugins_settings = modules
    rows = []
    for _name, _version, _desc, _source, plugin_dir, key in plugins_cmd._discover_all_plugins():
        fields = plugins_settings.plugin_settings_fields(key, pathlib.Path(str(plugin_dir)) if plugin_dir else None)
        if fields:
            rows.append({"key": key, "fields": fields})
    return {"supported": True, "plugins": rows}


def _apply_plugin_mcp_settings(plugins_cmd, plugin_dir, key: str) -> str:
    """Reconcile package-owned launch inputs on the RPC worker, preserving the request's profile scope."""
    try:
        if not plugin_dir or not plugins_cmd._is_portable_plugin_dir(plugin_dir):
            return "applied"
        from hermes_cli.agent_plugins import load_agent_plugin
        from hermes_cli.plugins_manifest import portable_mcp_server_name

        package = load_agent_plugin(plugin_dir, plugin_dir)
        if any(d.scope == "mcp" or d.scope.startswith("mcp:") for d in package.diagnostics):
            return "unknown"
        names = {portable_mcp_server_name(key, server) for server in package.mcp_servers}
        if not names:
            return "applied"
        from hermes_cli.config import load_config_readonly
        from hermes_cli.plugins import get_plugin_manager

        manager = get_plugin_manager()
        manager.discover_and_load(force=False)
        owners = getattr(manager, "_portable_mcp_server_plugins", None)
        if owners is None:
            return "restart_required"
        native = (load_config_readonly() or {}).get("mcp_servers") or {}
        names = {name for name in names if owners.get(name) == key and name not in native}
        if not names:
            return "applied"
        from tools import mcp_tool_discovery as discovery

        reconnect = getattr(discovery, "restart_mcp_servers_with_new_inputs", None)
        if reconnect is None:
            return "restart_required"
        # Also exclude the explicit Reload MCP path. The native helper serializes settings-driven reconnects.
        with _RELOAD_MCP_LOCK:
            restarted = reconnect(names)
            if restarted:
                from hermes_constants import get_hermes_home

                from .chat import refresh_profile_agents_mcp_tools

                refresh_profile_agents_mcp_tools(get_hermes_home())
            statuses = {row["name"]: row["status"] for row in discovery.get_mcp_status() if row["name"] in names}
            if any(status == "failed" for status in statuses.values()):
                return "restart_required"
            if any(status == "connecting" for status in statuses.values()) or any(name not in statuses for name in names):
                return "unknown"
        return "applied"
    except ImportError:
        return "restart_required"
    except Exception:  # noqa: BLE001
        # Persistence already succeeded. Neither expose launch inputs in an exception nor retry an uncertain reconnect.
        return "unknown"


def save_plugin_settings(key: str, values: Any, secret_envs: Any = None) -> dict:
    """Write manifest-declared, non-secret settings through the Agent's locked writer; returns the refreshed fields.

    ``secret_envs`` (secret key -> ``.env`` name the caller wrote) must still match the manifest before anything is written.
    """
    if not key or not isinstance(values, dict) or not isinstance(secret_envs or {}, dict):
        raise InvalidParams("plugins.settings_save requires a 'key' and a 'values' mapping")
    modules = _plugin_settings_modules()
    if modules is None:
        raise RpcError("This Hermes Agent cannot edit plugin settings", condition="plugin_settings_unsupported")
    plugins_cmd, plugins_settings = modules
    found = plugins_cmd._find_plugin_entry(key)
    if found is None:
        raise RpcError(f"plugin {key!r} not found", condition="plugin_not_found")
    plugin_dir = pathlib.Path(str(found[4])) if found[4] else None
    current = {field["key"]: field for field in plugins_settings.plugin_settings_fields(found[5], plugin_dir)}
    for secret, env in (secret_envs or {}).items():
        field = current.get(str(secret))
        if field is None or field.get("type") != "secret" or field.get("env") != env:
            raise RpcError(f"{secret!r} is no longer stored in {env}", condition="plugin_settings_changed")
    try:
        written = plugins_settings.save_plugin_settings(found[5], plugin_dir, values)
    except PermissionError as exc:
        raise RpcError(str(exc), condition="plugin_settings_managed") from exc
    except ValueError as exc:
        raise InvalidParams(str(exc)) from exc
    fields = plugins_settings.plugin_settings_fields(found[5], plugin_dir)
    application = _apply_plugin_mcp_settings(plugins_cmd, plugin_dir, found[5])
    return {"key": found[5], "written": written, "fields": fields, "runtime_application": application}


def register(registry) -> None:
    @registry.method("commands.registry")
    def registry_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"commands": list_commands()}

    @registry.method("commands.exec")
    def exec_(ctx: CallContext, params: dict) -> dict:
        command = str(params.get("command") or "")
        session_id = str(params.get("session_id") or "").strip()
        workspace = str(params.get("workspace") or "")
        with scoped_home(profile_home_param(params)):
            output = execute_agent_command(command, session_id, workspace)
            source = "agent"
            if output is None:
                from .chat import _turn_identity

                # TAL-904: a chat's plugin command runs under that chat's session and workspace, as its turns do.
                with _turn_identity(session_id, workspace) if session_id else contextlib.nullcontext():
                    output = execute_plugin_command(command, session_id)
                source = "plugin"
        if output is None:
            raise RpcError(f"unknown command {parse_slash_command(command)[0]!r}", condition="command_not_found")
        return {"output": output, "source": source}

    @registry.method("commands.expand_prompt")
    def expand_prompt_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return expand_prompt(str(params.get("command") or ""), str(params.get("workspace") or ""), params.get("enabled_toolsets"),
                                 str(params.get("session_id") or "").strip())

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

    @registry.method("plugins.update")
    def update(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return update_plugin(str(params.get("key") or "").strip(), params.get("accept_caution", False), params.get("consent_token"))

    @registry.method("plugins.isolation")
    def isolation(ctx: CallContext, params: dict) -> dict:
        return {"profiles": isolation_survey(profile_home_param(params, "base_home"))}

    @registry.method("plugins.settings")
    def settings(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return plugin_settings()

    @registry.method("plugins.settings_save")
    def settings_save(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return save_plugin_settings(str(params.get("key") or "").strip(), params.get("values"), params.get("secret_envs"))
