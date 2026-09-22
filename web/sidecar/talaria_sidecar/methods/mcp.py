"""``mcp.*``: the Agent's MCP registry (status, known tools, reconnect).

Config edits and health probes live in the server; this namespace only reads
``tools.mcp_tool`` and ``tools.registry`` state without spawning servers.
"""

from __future__ import annotations

import logging

from ..home import profile_home_param, scoped_home
from ..rpc import CallContext
from .commands import _reload_mcp

log = logging.getLogger("talaria_sidecar.mcp")


def status() -> list[dict]:
    try:
        from tools.mcp_tool import get_mcp_status

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


def register(registry_) -> None:
    @registry_.method("mcp.status")
    def status_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"servers": status()}

    @registry_.method("mcp.registry_tools")
    def tools(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"tools": registry_tools()}

    @registry_.method("mcp.reload")
    def reload(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"output": _reload_mcp()}
