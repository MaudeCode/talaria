"""The default-on ``harness`` agent toolset (TAL-1963): tools that use Talaria's own surfaces for the calling session.

TAL-1967 adds ``propose`` and ``proposal_read``: a change the agent may not make itself waits for the owner's approval on a
transcript card, and the server applies an approved one through the route that owns it.

TAL-1968 adds ``show``: a workspace file, table, chart or HTML page the server stores and the transcript renders.

TAL-1969 adds ``request_secret``: the user types a credential into a secure field, the server saves it to the profile
``.env``, and the agent learns only whether it was saved.

TAL-1970 adds ``notify``: an alert about this session on the user's devices, through Web Push and the Relay.

TAL-1971 adds ``deliver``: a workspace file handed to the user as a download row in the chat.

TAL-1974 adds ``terminal_open`` and ``terminal_read``: a long command runs in the session's embedded terminal, where the user
watches it live, while the agent reads its output in slices. The agent types only the first command and cannot close it.

TAL-1972 adds ``report_issue``: a Talaria misbehaviour the agent ran into, filed as feedback marked as the agent's, so it
reaches the Inbox like a user's report.

Unlike the opt-in ``talaria`` toolset, these tools only write Talaria state for the session that calls them, so every
Web turn gets the toolset unless the profile's ``agent.disabled_toolsets`` names it. Each handler forwards its call to
the server with ``talaria_toolset._tool`` and returns the server's result unchanged.
"""

from __future__ import annotations

import json
import threading

from . import rpc
from .talaria_toolset import _tool

TOOLSET = "harness"
# The Agent describes a registry-only toolset as "Plugin toolset: <name>"; the catalog shows this instead.
TOOLSET_DESCRIPTION = (
    "Hand the user a decision review to answer on a Talaria page, read their answers, and record what you did with each; "
    "propose a plugin install, MCP server, setting or scheduled task for the owner to approve; show a file, table, chart or "
    "page in the chat; ask the user for a credential, saved to the profile's .env without entering the chat; notify the user's "
    "devices that something is ready or needs them; deliver a file you made as a download; run a long command in a terminal "
    "the user watches and read its output; report a Talaria problem you ran into as feedback."
)

_WHEN = (
    "Use a decision review instead of clarify when you have more than a handful of questions, when the choices need an "
    "explanation, or when the user may finish answering later. "
)
_TEXT = {"type": "string"}

DECISION_REVIEW_PUT_SCHEMA = {
    "name": "decision_review_put",
    "description": (
        "Create a decision review the user answers on a Talaria page in their own time, or revise one with its review_id. "
        + _WHEN
        + "Returns at once with its review_id, url and progress; end your turn normally. When the user submits, this session "
        "gets a message telling you to call decision_review_read. Each item is one decision with 2 to 4 specific choices "
        "and the effect of each. On a revision an item whose content changed keeps its answer and is marked for review, "
        "and a removed item's answer stays in the review's history. At most 100 items."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "The review's title, at most 200 characters."},
            "intro": {"type": "string", "description": "One or two sentences on why these decisions are needed."},
            "review_id": {"type": "string", "description": "A review of this session to revise, from an earlier decision_review_put."},
            "items": {
                "type": "array",
                "description": "The decisions, in the order you want them asked.",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "A stable id, unique in the review; keep it when you revise the item."},
                        "title": {"type": "string", "description": "A short name for the decision."},
                        "question": {"type": "string", "description": "The plain question the user answers."},
                        "explanation": {"type": "string", "description": "Why it matters, without jargon."},
                        "example": {"type": "string", "description": "A concrete example of what each choice means in practice."},
                        "current": {"type": "string", "description": "What happens today."},
                        "recommendation": {"type": "string", "description": "What you recommend and why."},
                        "recommended_choice": {"type": "string", "description": "The value of the recommended choice."},
                        "choices": {
                            "type": "array",
                            "description": "2 to 4 choices with unique values.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "value": {"type": "string", "description": "A short machine value, unique in the item."},
                                    "label": {"type": "string", "description": "The choice as the user reads it."},
                                    "effect": {"type": "string", "description": "What happens if the user picks it."},
                                },
                                "required": ["value", "label", "effect"],
                            },
                        },
                        "technical": {
                            "type": "object",
                            "description": "Optional details for a technical reader.",
                            "properties": {"detail": _TEXT, "sources": {"type": "array", "items": _TEXT, "description": "Links or file paths, at most 20."}},
                        },
                    },
                    "required": ["id", "title", "question", "explanation", "current", "recommendation", "recommended_choice", "choices"],
                },
            },
        },
        "required": ["title", "items"],
    },
}

_REVIEW_ID = {"type": "string", "description": "The review_id decision_review_put returned."}

DECISION_REVIEW_READ_SCHEMA = {
    "name": "decision_review_read",
    "description": (
        "Read one of this session's decision reviews: its status, and each item's answer exactly as the user gave it (the "
        "choice's label and effect as shown, any notes, deferred or custom), whether the answer needs review because the "
        "item changed after it, and the outcome you recorded."
    ),
    "parameters": {"type": "object", "properties": {"review_id": _REVIEW_ID}, "required": ["review_id"]},
}

DECISION_REVIEW_RECORD_SCHEMA = {
    "name": "decision_review_record",
    "description": (
        "Record what you did with each answered decision: applied, kept, blocked, reviewed or planned, with a short note. "
        "Every id must be an item of the review, or nothing is recorded. Once every answered item of a submitted review "
        "has an outcome, the review is applied."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "review_id": _REVIEW_ID,
            "outcomes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "The item's id."},
                        "state": {"type": "string", "enum": ["applied", "kept", "blocked", "reviewed", "planned"]},
                        "note": {"type": "string", "description": "What you did, in a sentence."},
                    },
                    "required": ["id", "state"],
                },
            },
        },
        "required": ["review_id", "outcomes"],
    },
}


def _passed(*fields: str):
    """Send each of ``fields`` the agent gave as is; the server checks its shape and names what it refuses."""

    def add(args: dict, params: dict) -> None:
        for field in fields:
            if field in args and args[field] is not None:
                params[field] = args[field]

    return add


PROPOSE_SCHEMA = {
    "name": "propose",
    "description": (
        "Ask the owner to approve a change you cannot make yourself. Returns at once with its proposal_id, status pending and "
        "the url of this chat, where the owner sees a card with the change and approves or rejects it once; end your turn "
        "normally. When they decide, this session gets a message; call proposal_read for the outcome. Kinds and payloads: "
        "plugin_install {catalog_id, pin} installs a plugin from the reviewed catalog at its pinned commit (it stays turned off); "
        "mcp_server {name, url} or {name, command, args, env_names} adds or replaces an MCP server, where env_names lists "
        ".env variables the server reads and never their values; setting {key, value} changes one Talaria or Agent setting; "
        "cron_job {title, schedule, prompt, context_sources} schedules a task, where context_sources are task ids whose last "
        "output it reads. A proposal expires like a clarify question does; ask again with a new one."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["plugin_install", "mcp_server", "setting", "cron_job"]},
            "payload": {"type": "object", "description": "The kind's fields, as listed in this tool's description."},
        },
        "required": ["kind", "payload"],
    },
}

PROPOSAL_READ_SCHEMA = {
    "name": "proposal_read",
    "description": (
        "Read one of this session's proposals: its status (pending, approved, rejected, applied, failed or expired), the "
        "change as the owner saw it, and the outcome: the result text when it was applied, the error when it failed."
    ),
    "parameters": {"type": "object", "properties": {"proposal_id": {"type": "string", "description": "The proposal_id propose returned."}}, "required": ["proposal_id"]},
}


SHOW_SCHEMA = {
    "name": "show",
    "description": (
        "Show the user something in this chat instead of describing it. Returns at once with its block_id and the url of this "
        "chat, where the block renders; it collects no answer. Kinds and payloads: file {path, title} shows a file of the "
        "session's workspace (an image, audio, video or PDF plays in place; a text or code file opens on the side page); "
        "table {title, columns, rows} shows at most 20 columns and 500 rows, cutting the rest and saying so; "
        "chart {title, kind: bar or line, series: [{name, points: [{label, value}]}], unit} draws up to 6 series of up to "
        "200 points; html {title, body} runs a page of at most 512 KB in a sandbox with scripts and no network. A refused "
        "payload comes back as an error with a condition and shows nothing."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["file", "table", "chart", "html"]},
            "payload": {"type": "object", "description": "The kind's fields, as listed in this tool's description."},
        },
        "required": ["kind", "payload"],
    },
}


REQUEST_SECRET_SCHEMA = {
    "name": "request_secret",
    "description": (
        "Ask the user for an API key, token or password your work needs, by the environment variable it is saved under. "
        "The user types it into a secure field in Talaria; the server saves it to this profile's .env and you never see "
        "it, so never ask for a secret in chat. Waits like clarify until the user saves or declines it or the clarify "
        "timeout passes. Returns {env_name, outcome: saved, declined or timed_out, existed_before} and, when saved, "
        "runtime_application: applied means your next tool call can read the variable, restart_required means it takes "
        "effect in a new session. env_name is the service's credential name: 3 to 64 capital letters, digits or "
        "underscores, ending in _KEY, _TOKEN or _SECRET, outside HERMES_, TALARIA_, TERMINAL_ and API_SERVER_; any other "
        "name is refused before the user is asked. purpose is shown to the user as "
        "written: say which service it is for and what you will do with it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "env_name": {"type": "string", "description": "The .env name, such as FOO_API_KEY."},
            "purpose": {"type": "string", "description": "One or two sentences the user reads before answering."},
            "optional": {"type": "boolean", "description": "True when you can continue without it."},
        },
        "required": ["env_name", "purpose"],
    },
}


NOTIFY_SCHEMA = {
    "name": "notify",
    "description": (
        "Send the user a push notification on their phone and browsers that opens this chat, when something is ready or "
        "needs them and they may not be looking. Returns at once with status sent and, per channel (web-push, relay), "
        "sent, muted or unavailable. level info (the default) is muted while the user has Talaria open; attention is "
        "delivered anyway, so use it only when you are blocked on them. At most 5 per 10 minutes and one attention per "
        "minute: past that the result is status rate_limited with retry_after_seconds and nothing is sent. A title over "
        "80 or a body over 300 characters is refused; nothing is cut."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "At most 80 characters, such as \"Weekly report ready\"."},
            "body": {"type": "string", "description": "At most 300 characters: what is ready or what you need."},
            "level": {"type": "string", "enum": ["info", "attention"]},
        },
        "required": ["title", "body"],
    },
}


DELIVER_SCHEMA = {
    "name": "deliver",
    "description": (
        "Hand the user a file you made in the session's workspace (a report, an export, a build) as an attachment row in "
        "this chat that they can download, open or share. Returns at once with its block_id, size and media. The row "
        "points at the live file and says when it changed after delivery. One file of at most 200 MB: a path outside the "
        "workspace is refused with outside_workspace, a folder with is_directory, a larger file with file_too_large, and "
        "nothing shows."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "The file, relative to the workspace or absolute inside it."},
            "title": {"type": "string", "description": "What the file is, such as \"Weekly report\"; defaults to its name."},
        },
        "required": ["path"],
    },
}


TERMINAL_OPEN_SCHEMA = {
    "name": "terminal_open",
    "description": (
        "Run a long command, such as a build, a test run or a deploy, in this session's embedded terminal, where the user "
        "watches the output live in the terminal pane, instead of running it in the background. Starts the session's "
        "terminal in its workspace, types command once followed by Enter, and returns at once with terminal_id and the url "
        "of this chat; read the output with terminal_read. You cannot type into it again or close it: further commands go "
        "through your own tools, and the user closes it. One live terminal per session: while one runs this is refused "
        "with limit_reached; a session without the terminal toolset is refused with terminal_toolset_disabled. A command must be one line without tabs of at most 8192 characters, and it passes the same command approval as your terminal tool: a denied one is "
        "refused with approval_denied and nothing starts."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The one command to type, such as \"npm test\"; omit to open an empty terminal."},
            "title": {"type": "string", "description": "What it runs, shown on the chat's card; defaults to the command."},
        },
    },
}

TERMINAL_READ_SCHEMA = {
    "name": "terminal_read",
    "description": (
        "Read a terminal you opened with terminal_open: its output after after_event_id (from the start without it), with "
        "colors and cursor codes removed, at most max_lines lines (400 by default and at most). Pass next_event_id as "
        "after_event_id to read on; truncated means output after the cursor is not in this read, usually because more "
        "follows. The terminal keeps running after your command finishes, so watch the output for its end; exit_code is "
        "set only once the shell itself exited, and running is false then. A terminal of another session, or one the user "
        "closed or restarted, is refused with terminal_not_found."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "terminal_id": {"type": "string", "description": "The terminal_id terminal_open returned."},
            "after_event_id": {"type": "integer", "description": "The next_event_id of your previous read."},
            "max_lines": {"type": "integer", "description": "At most this many lines, up to 400."},
        },
        "required": ["terminal_id"],
    },
}


REPORT_ISSUE_SCHEMA = {
    "name": "report_issue",
    "description": (
        "Report a problem with Talaria itself, the app and server you are running in, as feedback the maintainers triage: "
        "a tool result you cannot parse, a refusal that names no reason, a card that lost its state. Not for problems in "
        "the user's project or a model mistake. The report is marked as yours, with this session's id, the Agent version "
        "and your model. Returns report_id once it is filed. summary is at most 120 characters and detail at most 4000; a "
        "longer one is refused, nothing is cut. The same summary twice from this session within an hour is refused with "
        "duplicate; too many reports from this server is rate_limited with retry_after_seconds. Reports carry no files: "
        "hand one over with deliver first and name it in detail."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "One line, at most 120 characters: what went wrong."},
            "detail": {"type": "string", "description": "At most 4000 characters: what you did, what you expected and what happened instead."},
            "include_diagnostics": {"type": "boolean", "description": "True to attach the server's redacted diagnostics: versions, enabled providers and recent errors."},
        },
        "required": ["summary", "detail", "include_diagnostics"],
    },
}


def _payload(args: dict, params: dict) -> None:
    """The agent's payload as given; the server names each missing field of an absent or malformed one."""
    payload = args.get("payload")
    if isinstance(payload, str):  # a model that sends the object as JSON text
        try:
            payload = json.loads(payload)
        except ValueError:
            pass
    params["payload"] = payload if isinstance(payload, dict) else {}


def _proposal(args: dict, params: dict) -> None:
    """The agent's payload, and the session's clarify timeout, which the proposal expires with."""
    from .methods import chat  # chat imports this module

    _payload(args, params)
    params["timeout_seconds"] = chat._clarify_timeout({})


decision_review_put = _tool("server.decision_review_put", "decision_review_put", ("title",), _passed("items", "intro", "review_id"))
decision_review_read = _tool("server.decision_review_read", "decision_review_read", ("review_id",))
decision_review_record = _tool("server.decision_review_record", "decision_review_record", ("review_id",), _passed("outcomes"))
propose = _tool("server.proposal_put", "propose", ("kind",), _proposal)
proposal_read = _tool("server.proposal_read", "proposal_read", ("proposal_id",))
show = _tool("server.show_put", "show", ("kind",), _payload)


notify = _tool("server.notify", "notify", ("title", "body"), _passed("level"))
deliver = _tool("server.deliver", "deliver", ("path",), _passed("title"))
_terminal_open = _tool("server.terminal_open", "terminal_open", (), _passed("command", "title"))


def _command_refusal(command: str) -> str | None:
    """The Agent's own pre-exec guard on a command for the host terminal, as its terminal tool runs it on this turn's
    thread: hardline floors, allowlists, approval mode and, with someone there to answer, the approval card. The tool's
    refusal JSON, or None when the command may run."""
    from tools.approval import check_all_command_guards

    approval = check_all_command_guards(command, "local")
    if approval.get("approved"):
        return None
    description = approval.get("description") or "command flagged"
    if approval.get("status") == "pending_approval":
        return json.dumps({"error": f"The command needs the user's approval ({description}); call terminal_open again once they approve it.", "condition": "approval_pending"})
    return json.dumps({"error": approval.get("message") or f"Command denied: {description}.", "condition": "approval_denied"})


def terminal_open(args: dict, session_id: str | None = None) -> str:
    """Types nothing the Agent's command guard has not passed; the server checks everything else."""
    command = args.get("command") if isinstance(args, dict) else None
    if session_id and isinstance(command, str) and command.strip():
        refusal = _command_refusal(command.strip())
        if refusal is not None:
            return refusal
    return _terminal_open(args, session_id)
terminal_read = _tool("server.terminal_read", "terminal_read", ("terminal_id",), _passed("after_event_id", "max_lines"))
report_issue = _tool("server.report_issue", "report_issue", ("summary", "detail"), _passed("include_diagnostics"))


def _secret(args: dict, params: dict) -> float:
    """``optional`` and the session's clarify timeout; the call outlasts the prompt (no limit when the timeout is 0 or less)."""
    from .methods import chat  # chat imports this module

    params["optional"] = args.get("optional") is True
    timeout = chat._clarify_timeout({})
    params["timeout_seconds"] = timeout
    return timeout + rpc.SERVER_CALL_TIMEOUT if timeout > 0 else threading.TIMEOUT_MAX


_secret_request = _tool("server.secret_request", "request_secret", ("env_name", "purpose"), _secret)


def _apply_saved(env_name: str) -> str:
    """Let this turn's next tool call read a value the server just saved: the turn's secret scope is a copy taken when
    it started, so add the profile ``.env``'s value to it. ``applied`` only once the Agent's own resolver returns it."""
    try:
        from agent.secret_scope import current_secret_scope, get_secret
        from hermes_cli.config import load_env

        value = load_env().get(env_name)
        if not value:
            return "restart_required"
        scope = current_secret_scope()
        if isinstance(scope, dict):
            scope[env_name] = value
        return "applied" if get_secret(env_name) == value else "restart_required"
    except Exception:  # noqa: BLE001 - an older Agent, or a scope that refuses the read; never expose the value
        return "restart_required"


def request_secret(args: dict, session_id: str | None = None) -> str:
    raw = _secret_request(args, session_id)
    result = json.loads(raw)
    if isinstance(result, dict) and result.get("outcome") == "saved":
        result["runtime_application"] = _apply_saved(str(result.get("env_name")))
        return json.dumps(result)
    return raw


_TOOLS = (
    (DECISION_REVIEW_PUT_SCHEMA, decision_review_put, "🗳️"),
    (DECISION_REVIEW_READ_SCHEMA, decision_review_read, "📋"),
    (DECISION_REVIEW_RECORD_SCHEMA, decision_review_record, "🧾"),
    (PROPOSE_SCHEMA, propose, "🔐"),
    (PROPOSAL_READ_SCHEMA, proposal_read, "📨"),
    (SHOW_SCHEMA, show, "🖼️"),
    (REQUEST_SECRET_SCHEMA, request_secret, "🔑"),
    (NOTIFY_SCHEMA, notify, "🔔"),
    (DELIVER_SCHEMA, deliver, "📎"),
    (TERMINAL_OPEN_SCHEMA, terminal_open, "🖥️"),
    (TERMINAL_READ_SCHEMA, terminal_read, "📟"),
    (REPORT_ISSUE_SCHEMA, report_issue, "🐞"),
)


def register() -> None:
    """Add the toolset to the Agent's process-wide tool registry."""
    from tools.registry import registry

    for schema, handler, emoji in _TOOLS:
        registry.register(name=schema["name"], toolset=TOOLSET, schema=schema, handler=handler, description=schema["description"], emoji=emoji)
