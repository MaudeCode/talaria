"""The opt-in ``talaria`` agent toolset (TAL-1164): Talaria-owned tools that run on the Web server.

Each handler forwards its call to the server over the sidecar's RPC channel (``rpc.call_server``) and returns the
server's result unchanged. The toolset is registered once the Agent imports, and is never one of a profile's default
toolsets: a session or profile turns it on through the toolsets picker.
"""

from __future__ import annotations

import json
import logging

from . import rpc
from .errors import RpcError

log = logging.getLogger("talaria_sidecar.talaria_toolset")

TOOLSET = "talaria"
# The Agent describes a registry-only toolset as "Plugin toolset: <name>"; the catalog shows this instead.
TOOLSET_DESCRIPTION = "List this profile's Talaria chats and whether each one is running or waiting on you."

SESSION_LIST_SCHEMA = {
    "name": "session_list",
    "description": (
        "List the Talaria chat sessions in this profile, newest first (at most 50), with each session's live run "
        "state: whether it is running, how many steering messages are queued for it, and any approval or question "
        "waiting on the user. The session you are running in has is_caller set."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Only list sessions whose title contains this text (case-insensitive)."},
        },
        "required": [],
    },
}


def caller_session_id(agent_session_id: str) -> str:
    """The Web session whose running agent has ``agent_session_id``: compression can move an agent onto a new id, and
    only a running turn calls tools. Any other id is passed on as is, for the server to resolve or refuse."""
    from .methods import chat

    with chat._RUNS_LOCK:
        for run in chat._RUNS.values():
            if run.agent is not None and str(getattr(run.agent, "session_id", "") or "") == agent_session_id:
                return run.session_id
    return agent_session_id


def _ask(method: str, params: dict) -> str:
    try:
        return json.dumps(rpc.call_server(method, params), ensure_ascii=False)
    except RpcError as exc:
        return json.dumps({"error": str(exc), "condition": exc.data.get("condition")}, ensure_ascii=False)


def session_list(args: dict, session_id: str | None = None) -> str:
    if not session_id:
        return json.dumps({"error": "session_list runs only inside a Talaria chat session", "condition": "caller_unknown"})
    query = args.get("query") if isinstance(args, dict) else None
    return _ask("server.session_list", {
        "caller_session_id": caller_session_id(str(session_id)),
        "query": query.strip() if isinstance(query, str) and query.strip() else None,
    })


def register() -> None:
    """Add the toolset to the Agent's process-wide tool registry."""
    from tools.registry import registry

    registry.register(name="session_list", toolset=TOOLSET, schema=SESSION_LIST_SCHEMA, handler=session_list,
                      description=SESSION_LIST_SCHEMA["description"], emoji="🗂️")
