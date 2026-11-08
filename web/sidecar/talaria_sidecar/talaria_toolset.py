"""The opt-in ``talaria`` agent toolset (TAL-1164, TAL-1165, TAL-1166, TAL-1167, TAL-1168, TAL-1169, TAL-1170): Talaria-owned tools that run on the Web server.

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
    "turns, manage their queued messages, see what they wait on and answer their questions and approvals, read or set "
    "their goals, organise this profile's projects and workspaces, list profiles, and list your background work."
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

PENDING_LIST_SCHEMA = {
    "name": "pending_list",
    "description": (
        "List the Talaria sessions in this profile that wait on an approval or a clarify question: each session's oldest "
        "prompt of each kind (its id, and the command or question with its choices) and how many of that kind it holds. "
        "Give session_id for one session."
    ),
    "parameters": {"type": "object", "properties": {"session_id": _ANY_SESSION_ID}, "required": []},
}

CLARIFY_RESPOND_SCHEMA = {
    "name": "clarify_respond",
    "description": (
        "Answer another Talaria session's clarify question, from pending_list, as its user would. A question with several "
        "steps takes {\"answers\": {\"q0\": \"...\", \"q1\": [\"...\"]}} as JSON. Your own session's questions are for the user; "
        "an answered or expired question is refused as stale, and a session with more access than yours as exceeds_caller."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": {"type": "string", "description": "The session_id of another session in this profile."},
            "clarify_id": {"type": "string", "description": "The question's id from pending_list."},
            "answer": {"type": "string", "description": "The reply: one of its choices or your own text."},
        },
        "required": ["session_id", "clarify_id", "answer"],
    },
}

APPROVAL_RESPOND_SCHEMA = {
    "name": "approval_respond",
    "description": (
        "Approve once or deny another Talaria session's pending command, from pending_list, as its user would. Works only "
        "when the user turned on talaria.agent_approvals for this profile; otherwise it is refused as agent_approvals_off. "
        "Your own session's approvals are for the user; an answered or expired one is refused as stale, and a session with "
        "more access than yours as exceeds_caller. The target's transcript shows that your session answered."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": {"type": "string", "description": "The session_id of another session in this profile."},
            "approval_id": {"type": "string", "description": "The approval's id from pending_list."},
            "choice": {"type": "string", "enum": ["once", "deny"], "description": "once runs this one command; deny refuses it."},
        },
        "required": ["session_id", "approval_id", "choice"],
    },
}

_NO_PARAMS = {"type": "object", "properties": {}, "required": []}
_PROJECT_NAME = {"type": "string", "description": "The project's name, at most 128 characters."}
_WORKSPACE_PATH = {"type": "string", "description": "The workspace folder's path, as workspace_list gives it."}

PROJECT_LIST_SCHEMA = {
    "name": "project_list",
    "description": "List this profile's Talaria projects, the folders the sidebar groups chats into, each with its project_id and name.",
    "parameters": _NO_PARAMS,
}

PROJECT_CREATE_SCHEMA = {
    "name": "project_create",
    "description": "Create a Talaria project in this profile. Move a chat into it with session_update's project_id.",
    "parameters": {"type": "object", "properties": {"name": _PROJECT_NAME}, "required": ["name"]},
}

PROJECT_RENAME_SCHEMA = {
    "name": "project_rename",
    "description": "Rename one of this profile's Talaria projects.",
    "parameters": {
        "type": "object",
        "properties": {"project_id": {"type": "string", "description": "The project's project_id, from project_list."}, "name": _PROJECT_NAME},
        "required": ["project_id", "name"],
    },
}

WORKSPACE_LIST_SCHEMA = {
    "name": "workspace_list",
    "description": "List this profile's Talaria workspaces, the folders a chat can work in, each with its path and name.",
    "parameters": _NO_PARAMS,
}

WORKSPACE_ADD_SCHEMA = {
    "name": "workspace_add",
    "description": (
        "Add an existing folder to this profile's Talaria workspaces. The server refuses a path that does not exist, is "
        "not a folder, is a system directory, or is already listed, with its reason."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "The folder's absolute path; ~ is the user's home."},
            "name": {"type": "string", "description": "Its name in the workspace list; the folder's name when absent."},
        },
        "required": ["path"],
    },
}

WORKSPACE_RENAME_SCHEMA = {
    "name": "workspace_rename",
    "description": "Rename one of this profile's Talaria workspaces.",
    "parameters": {
        "type": "object",
        "properties": {"path": _WORKSPACE_PATH, "name": {"type": "string", "description": "Its new name."}},
        "required": ["path", "name"],
    },
}

PROFILE_LIST_SCHEMA = {
    "name": "profile_list",
    "description": "List the Hermes profiles on this server and which one this session runs in (active). Read-only.",
    "parameters": _NO_PARAMS,
}

GOAL_GET_SCHEMA = {
    "name": "goal_get",
    "description": "Read a Talaria session's standing /goal: its text, status, and turns used of its budget.",
    "parameters": {"type": "object", "properties": {"session_id": _ANY_SESSION_ID}, "required": ["session_id"]},
}

GOAL_SET_SCHEMA = {
    "name": "goal_set",
    "description": (
        "Run /goal on a Talaria session in this profile, as its user would. New goal text replaces its goal and starts its "
        "first turn toward it; pause, resume and clear control the standing goal. A running session takes only pause, "
        "resume, clear or status; a session with more access than yours is refused as exceeds_caller."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": _ANY_SESSION_ID,
            "text": {"type": "string", "description": "The goal, or pause, resume or clear."},
        },
        "required": ["session_id", "text"],
    },
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


def _optional(field: str):
    """Send ``field`` only when given a non-blank string, stripped."""

    def add(args: dict, params: dict) -> None:
        value = args.get(field)
        if isinstance(value, str) and value.strip():
            params[field] = value.strip()

    return add


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
session_new = _tool("server.session_new", "session_new", ("message",), _optional("title"))
session_send = _tool("server.session_send", "session_send", ("session_id", "message"))
session_wait = _tool("server.session_wait", "session_wait", ("session_id",), _wait_timeout)
session_interrupt = _tool("server.session_interrupt", "session_interrupt", ("session_id",))
session_branch = _tool("server.session_branch", "session_branch", ("session_id", "mode"))
session_update = _tool("server.session_update", "session_update", ("session_id",), _update_fields)
session_handoff = _tool("server.session_handoff", "session_handoff", ("session_id",), lambda args, params: SESSION_HANDOFF_TIMEOUT_S)
session_compress = _tool("server.session_compress", "session_compress", ("session_id",), lambda args, params: SESSION_COMPRESS_TIMEOUT_S)
background_list = _tool("server.background_list", "background_list", ())
pending_list = _tool("server.pending_list", "pending_list", (), _optional("session_id"))
clarify_respond = _tool("server.clarify_respond", "clarify_respond", ("session_id", "clarify_id", "answer"))
approval_respond = _tool("server.approval_respond", "approval_respond", ("session_id", "approval_id", "choice"))
project_list = _tool("server.project_list", "project_list", ())
project_create = _tool("server.project_create", "project_create", ("name",))
project_rename = _tool("server.project_rename", "project_rename", ("project_id", "name"))
workspace_list = _tool("server.workspace_list", "workspace_list", ())
workspace_add = _tool("server.workspace_add", "workspace_add", ("path",), _optional("name"))
workspace_rename = _tool("server.workspace_rename", "workspace_rename", ("path", "name"))
profile_list = _tool("server.profile_list", "profile_list", ())
goal_get = _tool("server.goal_get", "goal_get", ("session_id",))
goal_set = _tool("server.goal_set", "goal_set", ("session_id", "text"))

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
    (PENDING_LIST_SCHEMA, pending_list, "🔔"),
    (CLARIFY_RESPOND_SCHEMA, clarify_respond, "🙋"),
    (APPROVAL_RESPOND_SCHEMA, approval_respond, "✅"),
    (PROJECT_LIST_SCHEMA, project_list, "📁"),
    (PROJECT_CREATE_SCHEMA, project_create, "🗃️"),
    (PROJECT_RENAME_SCHEMA, project_rename, "✏️"),
    (WORKSPACE_LIST_SCHEMA, workspace_list, "🗄️"),
    (WORKSPACE_ADD_SCHEMA, workspace_add, "➕"),
    (WORKSPACE_RENAME_SCHEMA, workspace_rename, "🔤"),
    (PROFILE_LIST_SCHEMA, profile_list, "👤"),
    (GOAL_GET_SCHEMA, goal_get, "🎯"),
    (GOAL_SET_SCHEMA, goal_set, "🏁"),
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
