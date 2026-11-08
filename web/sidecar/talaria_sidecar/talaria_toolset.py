"""The opt-in ``talaria`` agent toolset (TAL-1164, TAL-1165, TAL-1166, TAL-1167): Talaria-owned tools that run on the Web server.

Each handler forwards its call to the server over the sidecar's RPC channel (``rpc.call_server``) and returns the
server's result unchanged. The toolset is registered once the Agent imports, and is never one of a profile's default
toolsets: a session or profile turns it on through the toolsets picker.
"""

from __future__ import annotations

import json
import logging
import math

from . import rpc
from .errors import RpcError

log = logging.getLogger("talaria_sidecar.talaria_toolset")

TOOLSET = "talaria"
# The Agent describes a registry-only toolset as "Plugin toolset: <name>"; the catalog shows this instead.
TOOLSET_DESCRIPTION = (
    "List, start, message, branch, organise, summarise and compress this profile's Talaria chats, wait on or stop their "
    "turns, manage their queued messages, and list your background work."
)

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


SESSION_NEW_SCHEMA = {
    "name": "session_new",
    "description": (
        "Start a new Talaria chat session in this profile, with the profile's default model and workspace and your own "
        "toolsets, and send it its first message. Returns its session_id and the stream_id of the turn it started."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "message": {"type": "string", "description": "The first message: the work for the new session's agent."},
            "title": {"type": "string", "description": "A title for the session; without one it is generated as usual."},
        },
        "required": ["message"],
    },
}

_MESSAGE = {"type": "string", "description": "The message for that session's agent."}

SESSION_SEND_SCHEMA = {
    "name": "session_send",
    "description": (
        "Send a message to another Talaria session. An idle session starts a turn with it (outcome started); a running "
        "one gets it queued for its current turn, as the composer queues a steer (outcome queued, with its steer_id). "
        "A session with more access than yours (YOLO on, or a toolset you lack) is refused with exceeds_caller."
    ),
    "parameters": {"type": "object", "properties": {"session_id": _SESSION_ID, "message": _MESSAGE}, "required": ["session_id", "message"]},
}

SESSION_WAIT_DEFAULT_S = 300
SESSION_WAIT_MAX_S = 600

SESSION_WAIT_SCHEMA = {
    "name": "session_wait",
    "description": (
        "Wait for another Talaria session's running turn to end, then return its run_state and its last assistant "
        "message (at most 4,000 characters; truncated says it was cut). The outcome is ended, not_running (nothing was "
        "running), timeout (still running after timeout_s; run_state is its current state) or cancelled (your own turn "
        "was stopped)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": _SESSION_ID,
            "timeout_s": {"type": "integer", "description": f"Seconds to wait, at most {SESSION_WAIT_MAX_S}. Default {SESSION_WAIT_DEFAULT_S}."},
        },
        "required": ["session_id"],
    },
}

SESSION_INTERRUPT_SCHEMA = {
    "name": "session_interrupt",
    "description": (
        "Stop another Talaria session's running turn, as its Stop button does. cancelled is false when nothing was "
        "running; withdrawn_steers lists the queued messages the stop took back."
    ),
    "parameters": {"type": "object", "properties": {"session_id": _SESSION_ID}, "required": ["session_id"]},
}


_ANY_SESSION_ID = {"type": "string", "description": "The session_id of a session in this profile (yours included), from session_list."}

SESSION_BRANCH_SCHEMA = {
    "name": "session_branch",
    "description": (
        "Make a new Talaria session from one in this profile: branch forks its whole history (titled \"(fork)\"), "
        "duplicate copies it (titled \"(copy)\"). Returns the new session_id. Refused with not_permitted when the "
        "session does not allow it."
    ),
    "parameters": {
        "type": "object",
        "properties": {"session_id": _ANY_SESSION_ID, "mode": {"type": "string", "enum": ["branch", "duplicate"]}},
        "required": ["session_id", "mode"],
    },
}

SESSION_UPDATE_SCHEMA = {
    "name": "session_update",
    "description": (
        "Rename, move, pin or archive a Talaria session in this profile. Only the fields you give change; archiving also "
        "unpins. Returns the session's row. Refused with not_permitted, and nothing changed, when the session does not "
        "allow one of them."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": _ANY_SESSION_ID,
            "title": {"type": "string", "description": "The new title."},
            "project_id": {"type": ["string", "null"], "description": "The project to move it to; null or empty removes it from its project."},
            "pinned": {"type": "boolean"},
            "archived": {"type": "boolean"},
        },
        "required": ["session_id"],
    },
}

SESSION_HANDOFF_SCHEMA = {
    "name": "session_handoff",
    "description": (
        "Summarise a Talaria session's recent conversation for a handoff, as its handoff card does, and add the summary "
        "card to its transcript. Needs at least 10 answered rounds; refused while the session is running."
    ),
    "parameters": {"type": "object", "properties": {"session_id": _ANY_SESSION_ID}, "required": ["session_id"]},
}

SESSION_COMPRESS_SCHEMA = {
    "name": "session_compress",
    "description": (
        "Compress a Talaria session's model context now, as /compress does, and return the compression summary. "
        "Refused while the session is running, with the reason."
    ),
    "parameters": {"type": "object", "properties": {"session_id": _ANY_SESSION_ID}, "required": ["session_id"]},
}

BACKGROUND_LIST_SCHEMA = {
    "name": "background_list",
    "description": (
        "List your own session's background work: the delegations, background processes and /background tasks it "
        "started, each with its status."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

# The server bounds a handoff summary at two 60-second attempts; a compression has no deadline of its own.
SESSION_HANDOFF_TIMEOUT_S = 150.0
SESSION_COMPRESS_TIMEOUT_S = 600.0


def caller_session_id(agent_session_id: str) -> str:
    """The Web session whose running agent has ``agent_session_id``: compression can move an agent onto a new id, and
    only a running turn calls tools. Any other id is passed on as is, for the server to resolve or refuse."""
    from .methods import chat

    with chat._RUNS_LOCK:
        for run in chat._RUNS.values():
            if run.agent is not None and str(getattr(run.agent, "session_id", "") or "") == agent_session_id:
                return run.session_id
    return agent_session_id


def _ask(method: str, params: dict, timeout: float | None = None) -> str:
    try:
        return json.dumps(rpc.call_server(method, params, timeout=timeout), ensure_ascii=False)
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


def _wait_timeout(args: dict, params: dict) -> float:
    """``timeout_s`` clamped to 1..600 (300 when absent); the server call outlasts it by the usual call timeout."""
    raw = args.get("timeout_s")
    finite = isinstance(raw, int) or (isinstance(raw, float) and math.isfinite(raw))
    seconds = int(raw) if finite and not isinstance(raw, bool) else SESSION_WAIT_DEFAULT_S
    params["timeout_s"] = max(1, min(seconds, SESSION_WAIT_MAX_S))
    return params["timeout_s"] + rpc.SERVER_CALL_TIMEOUT


def _with_title(args: dict, params: dict) -> None:
    title = args.get("title")
    if isinstance(title, str) and title.strip():
        params["title"] = title.strip()


def _update_fields(args: dict, params: dict) -> None:
    """``session_update``'s optional fields, sent only when given; the server checks their types."""
    for field in ("title", "project_id", "pinned", "archived"):
        if field in args:
            value = args[field]
            params[field] = value.strip() if isinstance(value, str) else value


def _tool(method: str, name: str, fields: tuple[str, ...], extra=None):
    """A handler that sends the caller and the named string ``fields`` to ``method``; the server checks the target.
    ``extra`` adds optional params and may return the call's timeout."""

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
        timeout = extra(args, params) if extra else None
        return _ask(method, params, timeout)

    handler.__name__ = name
    return handler


queue_list = _tool("server.queue_list", "queue_list", ("session_id",))
queue_send_now = _tool("server.queue_send_now", "queue_send_now", ("session_id", "steer_id"))
queue_withdraw = _tool("server.queue_withdraw", "queue_withdraw", ("session_id", "steer_id"))
session_new = _tool("server.session_new", "session_new", ("message",), _with_title)
session_send = _tool("server.session_send", "session_send", ("session_id", "message"))
session_wait = _tool("server.session_wait", "session_wait", ("session_id",), _wait_timeout)
session_interrupt = _tool("server.session_interrupt", "session_interrupt", ("session_id",))
session_branch = _tool("server.session_branch", "session_branch", ("session_id", "mode"))
session_update = _tool("server.session_update", "session_update", ("session_id",), _update_fields)
session_handoff = _tool("server.session_handoff", "session_handoff", ("session_id",), lambda args, params: SESSION_HANDOFF_TIMEOUT_S)
session_compress = _tool("server.session_compress", "session_compress", ("session_id",), lambda args, params: SESSION_COMPRESS_TIMEOUT_S)
background_list = _tool("server.background_list", "background_list", ())

_TOOLS = (
    (SESSION_LIST_SCHEMA, session_list, "🗂️"),
    (QUEUE_LIST_SCHEMA, queue_list, "📬"),
    (QUEUE_SEND_NOW_SCHEMA, queue_send_now, "📨"),
    (QUEUE_WITHDRAW_SCHEMA, queue_withdraw, "↩️"),
    (SESSION_NEW_SCHEMA, session_new, "🆕"),
    (SESSION_SEND_SCHEMA, session_send, "💬"),
    (SESSION_WAIT_SCHEMA, session_wait, "⏳"),
    (SESSION_INTERRUPT_SCHEMA, session_interrupt, "⏹️"),
    (SESSION_BRANCH_SCHEMA, session_branch, "🌿"),
    (SESSION_UPDATE_SCHEMA, session_update, "🏷️"),
    (SESSION_HANDOFF_SCHEMA, session_handoff, "📝"),
    (SESSION_COMPRESS_SCHEMA, session_compress, "🗜️"),
    (BACKGROUND_LIST_SCHEMA, background_list, "🧵"),
)


# The Agent stops a tool after its generic deadline (420 s by default) unless the tool registers a longer budget.
_EXECUTION_TIMEOUTS = {"session_wait": SESSION_WAIT_MAX_S + rpc.SERVER_CALL_TIMEOUT, "session_compress": SESSION_COMPRESS_TIMEOUT_S}


def register() -> None:
    """Add the toolset to the Agent's process-wide tool registry."""
    from tools.registry import registry

    for schema, handler, emoji in _TOOLS:
        timeout = _EXECUTION_TIMEOUTS.get(schema["name"])
        registry.register(name=schema["name"], toolset=TOOLSET, schema=schema, handler=handler, description=schema["description"], emoji=emoji,
                          **({"execution_timeout": timeout} if timeout else {}))
