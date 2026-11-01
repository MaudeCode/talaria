"""The opt-in ``talaria`` agent toolset (TAL-1164, TAL-1167): Talaria-owned tools that run on the Web server.

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
TOOLSET_DESCRIPTION = "List this profile's Talaria chats, see which are running or waiting on you, and manage their queued messages."

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


_SESSION_ID = {"type": "string", "description": "The session_id of another session in this profile, from session_list."}
_STEER_ID = {"type": "string", "description": "The steer_id of one of that session's queued messages, from queue_list."}

QUEUE_LIST_SCHEMA = {
    "name": "queue_list",
    "description": (
        "List the messages queued for another Talaria session's running turn, oldest first. Each has a steer_id, its "
        "text, its state (pending, or sending_now once delivery started) and the actions it still allows."
    ),
    "parameters": {"type": "object", "properties": {"session_id": _SESSION_ID}, "required": ["session_id"]},
}

QUEUE_SEND_NOW_SCHEMA = {
    "name": "queue_send_now",
    "description": (
        "Deliver one of another session's queued messages now instead of after its running tools. The outcome is "
        "delivered, next_step (it goes in at the next step), not_running, taken (already delivered or withdrawn) or failed."
    ),
    "parameters": {"type": "object", "properties": {"session_id": _SESSION_ID, "steer_id": _STEER_ID}, "required": ["session_id", "steer_id"]},
}

QUEUE_WITHDRAW_SCHEMA = {
    "name": "queue_withdraw",
    "description": (
        "Take back one of another session's queued messages before its agent reads it. withdrawn is false when the "
        "message was already taken or is being sent."
    ),
    "parameters": {"type": "object", "properties": {"session_id": _SESSION_ID, "steer_id": _STEER_ID}, "required": ["session_id", "steer_id"]},
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


def _queue_tool(method: str, name: str, fields: tuple[str, ...]):
    """A handler that sends the caller and the named string ``fields`` to ``method``; the server checks the target."""

    def handler(args: dict, session_id: str | None = None) -> str:
        if not session_id:
            return json.dumps({"error": f"{name} runs only inside a Talaria chat session", "condition": "caller_unknown"})
        args = args if isinstance(args, dict) else {}
        params = {"caller_session_id": caller_session_id(str(session_id))}
        for field in fields:
            value = args.get(field)
            if not isinstance(value, str) or not value.strip():
                return json.dumps({"error": f"{field} is required", "condition": "invalid_params"})
            params[field] = value.strip()
        return _ask(method, params)

    handler.__name__ = name
    return handler


queue_list = _queue_tool("server.queue_list", "queue_list", ("session_id",))
queue_send_now = _queue_tool("server.queue_send_now", "queue_send_now", ("session_id", "steer_id"))
queue_withdraw = _queue_tool("server.queue_withdraw", "queue_withdraw", ("session_id", "steer_id"))

_TOOLS = (
    (SESSION_LIST_SCHEMA, session_list, "🗂️"),
    (QUEUE_LIST_SCHEMA, queue_list, "📬"),
    (QUEUE_SEND_NOW_SCHEMA, queue_send_now, "📨"),
    (QUEUE_WITHDRAW_SCHEMA, queue_withdraw, "↩️"),
)


def register() -> None:
    """Add the toolset to the Agent's process-wide tool registry."""
    from tools.registry import registry

    for schema, handler, emoji in _TOOLS:
        registry.register(name=schema["name"], toolset=TOOLSET, schema=schema, handler=handler, description=schema["description"], emoji=emoji)
