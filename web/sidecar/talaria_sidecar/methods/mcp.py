"""``mcp.*``: the Agent's MCP registry (status, known tools, reconnect).

Config edits and health probes live in the server; this namespace only reads
``tools.mcp_tool`` and ``tools.registry`` state without spawning servers, and
renders the probe's url/headers with the Agent's own ``${VAR}`` rules.
"""

from __future__ import annotations

import hashlib
import json
import logging

from ..home import profile_home_param, scoped_home
from ..rpc import CallContext
from .commands import _reload_mcp

log = logging.getLogger("talaria_sidecar.mcp")


def status() -> list[dict]:
    try:
        from tools.mcp_tool_discovery import get_mcp_status

        statuses = get_mcp_status()
    except Exception:  # noqa: BLE001
        return []
    return [dict(entry) for entry in statuses if isinstance(entry, dict) and entry.get("name")] if isinstance(statuses, list) else []


def registry_tools() -> list[dict]:
    """Already-registered MCP tool schemas, without probing any server."""
    try:
        from tools.registry import registry
    except Exception:  # noqa: BLE001
        return []
    out = []
    try:
        names = registry.get_all_tool_names()
    except Exception:  # noqa: BLE001
        return []
    for tool_name in names:
        try:
            toolset = registry.get_toolset_for_tool(tool_name)
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(toolset, str) or not toolset.startswith("mcp-"):
            continue
        schema = registry.get_schema(tool_name) or {}
        out.append({"name": tool_name, "server": toolset[len("mcp-"):], "schema": schema if isinstance(schema, dict) else {}})
    return out


def probe_targets(servers: dict) -> list[dict]:
    """Each remote server's ``url`` and string ``headers`` rendered as the Agent renders them at connect
    (``${VAR}`` from this profile's secret scope). Unset references keep their placeholder; the values
    are credentials, so they go only to the server's health probe and never into a log or error."""
    try:
        from tools.mcp_tool_config import _interpolate_env_vars
    except ImportError:
        return []
    out = []
    for name, cfg in servers.items():
        if not isinstance(cfg, dict) or not isinstance(cfg.get("url"), str):
            continue
        headers = cfg.get("headers") if isinstance(cfg.get("headers"), dict) else {}
        raw = {"url": cfg["url"], "headers": {k: v for k, v in headers.items() if isinstance(k, str) and isinstance(v, str)}}
        try:
            rendered = _interpolate_env_vars(raw)
        except Exception:  # noqa: BLE001 - an exception may quote a resolved value; the probe sees the raw refs
            rendered = raw
        out.append({"name": str(name), "url": str(rendered["url"]), "headers": {k: str(v) for k, v in rendered["headers"].items()}})
    return out


def cost_policies(servers: dict) -> dict:
    """Read declarations using the native parser; inspect cached packages without discovering or connecting."""
    try:
        from tools.mcp_tool_costs import CONFIG_KEYS, _parse_cost, config_cost_policy
        from hermes_cli.plugins import get_plugin_manager

        portable = get_plugin_manager().get_portable_mcp_servers()
    except (ImportError, AttributeError):
        return {"supported": False, "policies": []}
    rows = []
    for name in sorted(servers.keys() | portable.keys()):
        native, package = servers.get(name), portable.get(name, {})
        if not isinstance(package, dict):
            package = {}
        editable = isinstance(native, dict) and ("command" in native or "url" in native)
        own = {k: native[k] for k in CONFIG_KEYS if isinstance(native, dict) and k in native}
        # The native loader rejects a malformed package before it can donate inherited keys.
        if native is not None:
            try:
                config_cost_policy(name, package)
            except (ValueError, TypeError):
                package = {}
        inherited = {k: package[k] for k in CONFIG_KEYS if k in package}
        effective = {**inherited, **own}
        sources = {k: "native" if k in own else "package" if k in inherited else "default" for k in CONFIG_KEYS}
        row = {"name": name, "source": "native_override" if native is not None and package else "native" if native is not None else "package",
               "valid": True, "can_edit": editable, "error": None,
               "package_revision": hashlib.sha256(json.dumps(inherited, sort_keys=True, default=str).encode()).hexdigest(),
               "overrides": {"tool_costs": None, "spend_limit": None, "cost_unit": None},
               "tool_costs": [], "spend_limit": 0, "cost_unit": "credits", "budget_enabled": False, "field_sources": sources}
        try:
            # Validate the native entry separately as the Agent does before package inheritance.
            config_cost_policy(name, own)
            policy = config_cost_policy(name, effective)
            costs = effective.get("tool_costs") or {}
            row["tool_costs"] = [{"name": tool, "low": cost.low, "high": cost.high, "note": cost.note}
                                 for tool, value in costs.items() for cost in [_parse_cost(value, "declared cost")]]
            row["spend_limit"] = effective.get("spend_limit") or 0
            row["cost_unit"] = (effective.get("cost_unit") or "credits").strip()
            row["budget_enabled"] = policy is not None and policy.limit > 0
            row["overrides"] = {k: own.get(k) for k in CONFIG_KEYS}
        except (ValueError, TypeError):
            # Native errors may quote arbitrary config values, including mistakenly pasted credentials.
            row.update(valid=False, error="Invalid declared cost policy. Check tool estimates, limit and unit.")
        rows.append(row)
    return {"supported": True, "policies": rows}


# A refresh is due at 80% of the grant and the native loop wakes for it; past this grace it is overdue.
_REFRESH_GRACE_S = 120.0
_NO_SUBSCRIPTIONS = {"active": 0, "refresh_overdue": 0, "lapsed": 0, "pending": 0, "paused": 0}


def _grant_expiry(state: dict) -> float:
    """Epoch seconds the grant expires; ``inf`` for a no-expiry grant, 0 without a readable one."""
    from datetime import datetime

    if state.get("refresh_before") is None:
        return float("inf")
    try:
        return datetime.fromisoformat(str(state["refresh_before"])).timestamp()
    except ValueError:
        return 0.0


def _subscription_state(route: dict, state: dict, now: float) -> str:
    from tools.mcp_tool_events import _refresh_due_at

    if route.get("enabled", True) is False:
        return "paused"
    if not isinstance(state.get("granted_at"), (int, float)):
        return "pending"
    if _grant_expiry(state) <= now:
        return "lapsed"
    return "refresh_overdue" if _refresh_due_at(state) + _REFRESH_GRACE_S <= now else "active"


def events(servers: dict, now: float | None = None) -> dict:
    """The native events opt-in owner's durable state, counted per server; never secrets, routes, grants or cursors.

    Reads the webhook route store and ``mcp_event_subscriptions.json`` of the scoped profile, plus this runtime's
    registry for the event utilities. Utilities are counted by their registered names, not the server's parsed
    capabilities: the SDK drops the ``events`` capability, so it cannot say whether a server offers them."""
    import time

    try:
        from hermes_cli.webhook import _get_webhook_config, _load_subscriptions
        from tools.mcp_tool_events import EVENT_UTILITY_KEYS, _load_state, _server_routes
        from tools.mcp_tool_schema import mcp_prefixed_tool_name
    except (ImportError, AttributeError):
        return {"supported": False, "callback": "missing", "servers": []}
    webhook = _get_webhook_config()
    url = (webhook.get("extra") or {}).get("public_url") or webhook.get("public_url") or ""
    url = url.strip() if isinstance(url, str) else ""
    callback = "ready" if url.startswith("https://") else "not_https" if url else "missing"
    routes, states = _load_subscriptions(), _load_state()
    registered = {tool["name"]: tool["server"] for tool in registry_tools()}
    now = time.time() if now is None else now
    rows = []
    for name in sorted(servers):
        counts = dict(_NO_SUBSCRIPTIONS)
        for route_name, route in _server_routes(routes, name).items():
            counts[_subscription_state(route, states.get(route_name, {}), now)] += 1
        utilities = sum(1 for key in EVENT_UTILITY_KEYS if registered.get(mcp_prefixed_tool_name(name, key)) == name)
        rows.append({"name": name, "utilities": utilities, "subscriptions": counts})
    return {"supported": True, "callback": callback, "servers": rows}


def register(registry_) -> None:
    @registry_.method("mcp.cost_policies")
    def policies(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params), load_plugins=False):
            return cost_policies(params.get("servers") or {})

    @registry_.method("mcp.probe_targets")
    def targets(ctx: CallContext, params: dict) -> dict:
        # Plugins load as for mcp.status: a named profile's plugin secret sources hydrate only then.
        with scoped_home(profile_home_param(params)):
            return {"targets": probe_targets(params.get("servers") or {})}

    @registry_.method("mcp.status")
    def status_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"servers": status()}

    @registry_.method("mcp.events")
    def events_(ctx: CallContext, params: dict) -> dict:
        servers = params.get("servers")
        with scoped_home(profile_home_param(params)):
            return events(servers if isinstance(servers, dict) else {})

    @registry_.method("mcp.registry_tools")
    def tools(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"tools": registry_tools()}

    @registry_.method("mcp.reload")
    def reload(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"output": _reload_mcp()}
