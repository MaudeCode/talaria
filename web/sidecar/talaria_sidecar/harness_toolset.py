"""The default-on ``harness`` agent toolset (TAL-1963): tools that use Talaria's own surfaces for the calling session.

TAL-1967 adds ``propose`` and ``proposal_read``: a change the agent may not make itself waits for the owner's approval on a
transcript card, and the server applies an approved one through the route that owns it.

Unlike the opt-in ``talaria`` toolset, these tools only write Talaria state for the session that calls them, so every
Web turn gets the toolset unless the profile's ``agent.disabled_toolsets`` names it. Each handler forwards its call to
the server with ``talaria_toolset._tool`` and returns the server's result unchanged.
"""

from __future__ import annotations

import json

from .talaria_toolset import _tool

TOOLSET = "harness"
# The Agent describes a registry-only toolset as "Plugin toolset: <name>"; the catalog shows this instead.
TOOLSET_DESCRIPTION = (
    "Hand the user a decision review to answer on a Talaria page, read their answers, and record what you did with each; "
    "propose a plugin install, MCP server, setting or scheduled task for the owner to approve."
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


def _proposal(args: dict, params: dict) -> None:
    """The agent's payload as given, and the session's clarify timeout, which the proposal expires with."""
    from .methods import chat  # chat imports this module

    payload = args.get("payload")
    if isinstance(payload, str):  # a model that sends the object as JSON text
        try:
            payload = json.loads(payload)
        except ValueError:
            pass
    # The server names each missing field of an absent or malformed payload.
    params["payload"] = payload if isinstance(payload, dict) else {}
    params["timeout_seconds"] = chat._clarify_timeout({})


decision_review_put = _tool("server.decision_review_put", "decision_review_put", ("title",), _passed("items", "intro", "review_id"))
decision_review_read = _tool("server.decision_review_read", "decision_review_read", ("review_id",))
decision_review_record = _tool("server.decision_review_record", "decision_review_record", ("review_id",), _passed("outcomes"))
propose = _tool("server.proposal_put", "propose", ("kind",), _proposal)
proposal_read = _tool("server.proposal_read", "proposal_read", ("proposal_id",))

_TOOLS = (
    (DECISION_REVIEW_PUT_SCHEMA, decision_review_put, "🗳️"),
    (DECISION_REVIEW_READ_SCHEMA, decision_review_read, "📋"),
    (DECISION_REVIEW_RECORD_SCHEMA, decision_review_record, "🧾"),
    (PROPOSE_SCHEMA, propose, "🔐"),
    (PROPOSAL_READ_SCHEMA, proposal_read, "📨"),
)


def register() -> None:
    """Add the toolset to the Agent's process-wide tool registry."""
    from tools.registry import registry

    for schema, handler, emoji in _TOOLS:
        registry.register(name=schema["name"], toolset=TOOLSET, schema=schema, handler=handler, description=schema["description"], emoji=emoji)
