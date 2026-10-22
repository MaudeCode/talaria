"""``chat.*``, ``approval.*``, ``clarify.*``: one Agent turn per ``chat.start`` call.

The server owns the WebUI session (transcript merge, journals, SSE fan-out);
the sidecar owns the ``AIAgent`` instance. ``chat.start`` streams the Agent's
callbacks as frames and returns the settled result. Approval and clarify
prompts block the Agent thread until the server relays the user's answer
through ``approval.respond`` / ``clarify.respond``; ``rpc.cancel`` or
``chat.interrupt`` stop the turn (``api/streaming.py`` in the Python backend).
"""

from __future__ import annotations

import contextlib
import contextvars
import copy
import hashlib
import importlib.util
import inspect
import json
import logging
import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from typing import Any
from types import SimpleNamespace

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home, session_workspace
from ..rpc import CallContext
from .checkpoints import checkpoint_kwargs
from .providers import runtime_failure
from .state_db import release_all, release_home, release_session_db
from .toolsets import disabled_toolsets

log = logging.getLogger("talaria_sidecar.chat")

_AGENT_CACHE_MAX = 32
# Shutdown waits this long for evicted agents' memory providers; the server kills the sidecar 5 s after closing stdin.
_AGENT_RELEASE_TIMEOUT = 4.0
# Profile deletion waits this long for the profile's memory flushes, under the server's 120 s call timeout.
_PROFILE_RELEASE_TIMEOUT = 60.0
_SESSION_FINALIZE_TIMEOUT = 10.0
_TOOL_RESULT_SNIPPET_MAX = 4000
# Predecessor ``_TOOL_ARG_CONTENT_KEYS`` (#4928): card content / diff-reconstruction inputs keep the long cap.
_TOOL_ARG_CONTENT_KEYS = frozenset({"command", "cmd", "script", "code", "patch", "diff", "old_string", "new_string", "content", "path", "file_path"})


class _Run:
    def __init__(self, stream_id: str, session_id: str, ctx: CallContext):
        self.stream_id = stream_id
        self.session_id = session_id
        self.ctx = ctx
        self.agent = None
        self.cancel = threading.Event()
        # Set when the turn is over for any reason; the cancel watcher must not mistake it for a cancellation.
        self.finished = threading.Event()
        self.clarify_entries: dict[str, "_ClarifyEntry"] = {}
        self.lock = threading.Lock()
        # The Agent's transcript list from before this turn: a Stop while the Agent still holds it has no checkpoint.
        self.prior_messages = None
        # TAL-897: the session ended (clear/delete) or the sidecar is draining, set under both cache and run locks; an
        # agent this run binds afterwards forks no review and stays out of the cache.
        self.session_ended = False
        self.home = None  # the profile home its agent runs under, set by ``start``
        self.mcp_discovery_outcome = "ok"


class _ClarifyEntry:
    def __init__(self, data: dict):
        self.clarify_id = uuid.uuid4().hex
        self.data = data
        self.event = threading.Event()
        self.result: str | None = None
        self.deadline: float | None = None


_RUNS: dict[str, _Run] = {}
_RUNS_BY_SESSION: dict[str, str] = {}
# Which run owns the Agent's gateway approval callback per session; register/unregister happen under one lock so a
# stale run can never remove a successor's callback, and a successor can never leak a predecessor's.
_APPROVAL_CB_OWNER: dict[str, str] = {}
_APPROVAL_CB_LOCK = threading.Lock()
_RUNS_LOCK = threading.Lock()
# session id -> (agent, signature, profile home).
_AGENT_CACHE: "OrderedDict[str, tuple[Any, str, Any]]" = OrderedDict()
_AGENT_CACHE_LOCK = threading.Lock()
# Running release thread -> the profile home it runs under.
_RELEASES: dict[threading.Thread, Any] = {}
_RELEASES_LOCK = threading.Lock()
# ``(agent, home)`` inside ``chat.commit_memory`` or ``chat.refine`` (guarded by ``_AGENT_CACHE_LOCK``): like a turn, each
# defers the agent's release, and deleting ``home`` waits for it.
_COMMITTING: list = []
# Set (under ``_RUNS_LOCK``) when shutdown drains: no turn is admitted after the drain's snapshot of ``_RUNS``.
_DRAINING = threading.Event()
_MCP_DISCOVERIES: dict[str, threading.Event] = {}
_MCP_DISCOVERY_LOCK = threading.Lock()
_MCP_CLOSING_HOMES: set[str] = set()
_MCP_REDISCOVERY_WAIT = 2.0
_MCP_PENDING_KEY = "mcp_discovery_pending"


def _snippet(raw: Any, limit: int = _TOOL_RESULT_SNIPPET_MAX) -> str:
    """Predecessor ``_tool_result_snippet``: the ``output``/``result``/``error`` of a dict (or JSON) result, hard-cut."""
    if limit <= 0:
        return ""
    text = str(raw or "")
    try:
        data = raw if isinstance(raw, dict) else json.loads(text)
        if isinstance(data, dict):
            preview = data.get("output") or data.get("result") or data.get("error") or text
            text = str(preview)
    except Exception:  # noqa: BLE001
        pass
    return text[:limit]


_RAW_RESULT_MAX_KEYS = 64
_RAW_RESULT_OUTCOME_KEYS = ("error", "exit_code", "exitCode", "success", "status", "results")
# TAL-1261: a ``results`` batch keeps up to 64 items, each projected like the result with 16 fields of 400 characters.
_RAW_RESULT_ITEM_KEYS = 16
_RAW_RESULT_ITEM_MAX = 400


def _without_error(item: Any) -> bool:
    """An item the server's ``presentError`` reads as error-free: not an object, or its ``error`` is blank text, ``false``,
    ``null``, a number, or an empty object or list."""
    error = item.get("error") if isinstance(item, dict) else None
    return not (error is True or (isinstance(error, str) and error.strip()) or (isinstance(error, (dict, list)) and error))


def _result_diff(raw: Any) -> str | None:
    """A dict (or JSON-object text) result's string ``diff`` field, whole; the server decides what it shows."""
    try:
        data = raw if isinstance(raw, dict) else json.loads(str(raw or ""))
    except Exception:  # noqa: BLE001
        return None
    diff = data.get("diff") if isinstance(data, dict) else None
    return diff if isinstance(diff, str) else None


def _edit_snapshot(name: str, args: Any, task_id: str) -> Any:
    """TAL-909: the Agent's before-state of a file edit, through the task's terminal; None for a remote backend (the
    Agent never diffs an unrelated local file), a non-edit tool, or any failure."""
    try:
        from agent.display import capture_local_edit_snapshot

        return capture_local_edit_snapshot(name, args, task_id=task_id)
    except Exception:  # noqa: BLE001
        return None


def _edit_metadata(name: str, args: Any, result: Any, snapshot: Any) -> dict:
    """TAL-909: a tool-result row's ``display_metadata``: an edit's unified ``diff`` from its snapshot, which the server
    turns into ``edit_diff``. Empty when the result carries its own ``diff`` (``patch``), which the server already reads."""
    if snapshot is None or _result_diff(result) is not None:
        return {}
    try:
        from agent.display import extract_edit_diff

        diff = extract_edit_diff(name, result, function_args=args, snapshot=snapshot)
    except Exception:  # noqa: BLE001
        return {}
    return {"diff": diff} if diff else {}


def _raw_result(raw: Any, limit: int = _TOOL_RESULT_SNIPPET_MAX, max_keys: int = _RAW_RESULT_MAX_KEYS, items: bool = True) -> Any:
    """The tool result as the server's outcome rule reads it, bounded: a dict (or JSON-object text) keeps its first
    ``max_keys`` top-level fields plus its outcome fields, scalars as they are, text and non-empty nested values as capped
    (JSON) text, except a ``results`` list, whose object items keep the same shape one level down (TAL-1261); anything
    else is the capped text. The sidecar decides nothing; the server does."""
    try:
        data = raw if isinstance(raw, dict) else json.loads(str(raw or ""))
    except Exception:  # noqa: BLE001
        data = None
    if not isinstance(data, dict):
        return str(raw if raw is not None else "")[:limit]
    out: dict = {}
    # The server's outcome rule reads these, wherever they sit in the result.
    kept = list(data.items())[:max_keys] + [(k, data[k]) for k in _RAW_RESULT_OUTCOME_KEYS if k in data]
    for key, value in kept:
        if items and key == "results" and isinstance(value, list) and value:
            # Past the cap, the first item without an error rides along, so a long batch is judged like the whole one.
            batch = value[:_RAW_RESULT_MAX_KEYS] + [item for item in value[_RAW_RESULT_MAX_KEYS:] if _without_error(item)][:1]
            # A non-object item stays text, even JSON-object text: only object items count toward the batch's outcome.
            out[key] = [_raw_result(item, _RAW_RESULT_ITEM_MAX, _RAW_RESULT_ITEM_KEYS, False) if isinstance(item, dict)
                        else (item if isinstance(item, str) else json.dumps(item, default=str))[:_RAW_RESULT_ITEM_MAX] for item in batch]
        elif value is None or isinstance(value, (bool, int)) or (isinstance(value, float) and value == value and abs(value) != float("inf")):
            out[str(key)] = value
        elif isinstance(value, (dict, list)) and not value:
            out[str(key)] = {} if isinstance(value, dict) else []
        else:
            text = value if isinstance(value, str) else json.dumps(value, default=str)
            out[str(key)] = text[:limit]
    return out


_TODO_TOOL_NAMES = frozenset({"todo", "todo_list"})


def _is_todo_tool(name: Any) -> bool:
    """TAL-889: the Agent's own todo-tool predicate (canonical ``todo_list`` and legacy aliases); older Agents lack it."""
    try:
        from tools.todo_tool import is_todo_tool_name
    except Exception:  # noqa: BLE001 - older Agent without the predicate
        return isinstance(name, str) and name in _TODO_TOOL_NAMES
    return bool(is_todo_tool_name(name))


def _delegation_cost_usd(name: Any, raw: Any):
    """Predecessor ``_delegation_cost_usd``: total spend a ``delegate_task`` result reports, or None."""
    if str(name or "") != "delegate_task":
        return None
    try:
        data = raw if isinstance(raw, dict) else json.loads(str(raw or ""))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    results = data.get("results")
    if not isinstance(results, list):
        return None
    total = 0.0
    for entry in results:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("cost_status") or "").strip().lower() == "unknown":
            return None
        value = entry.get("cost_usd")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if not (0 < value < 1e12):
            continue
        total += float(value)
    return round(total, 6) if total > 0 else None


def _js_number(value: int | float) -> str:
    """A number as JavaScript's `String()` shows it once the persisted JSON is parsed (`1.0` -> `1`, `1e21` -> `1e+21`)."""
    try:
        number = float(value)
    except OverflowError:
        return "Infinity" if value > 0 else "-Infinity"
    if number != number:
        return "NaN"
    if number in (float("inf"), float("-inf")):
        return "Infinity" if number > 0 else "-Infinity"
    if number == 0:
        return "0"
    sign = "-" if number < 0 else ""
    # repr() gives the shortest round-trip digits, as JavaScript does; only the notation differs.
    mantissa, _, exp = repr(abs(number)).partition("e")
    whole, _, frac = mantissa.partition(".")
    digits = (whole + frac).lstrip("0")
    point = len(whole) + int(exp or 0) - (len(whole + frac) - len((whole + frac).lstrip("0")))
    digits = digits.rstrip("0") or "0"
    k, n = len(digits), point
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * -n + digits
    e = n - 1
    return sign + digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))


def _display_repr(text: str) -> str:
    quote = '"' if "'" in text and '"' not in text else "'"
    escaped = text.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return quote + escaped.replace(quote, "\\" + quote) + quote


def _display_str(value: Any, nested: bool = False) -> str:
    """A non-string argument as the server renders the parsed JSON of a persisted call (`pythonStr` in
    `sessions/tool-display.ts`): Python `str()` shapes with JavaScript number text, so a live and a persisted call
    show one target."""
    if isinstance(value, str):
        return _display_repr(value) if nested else value
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_display_str(item, True) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{_display_repr(str(k))}: {_display_str(item, True)}" for k, item in value.items()) + "}"
    return str(value)


def _args_snapshot(args: Any) -> dict:
    snap: dict = {}
    if isinstance(args, dict):
        for k, v in list(args.items())[:4]:
            s2 = _display_str(v)
            cap = _TOOL_RESULT_SNIPPET_MAX if str(k).lower() in _TOOL_ARG_CONTENT_KEYS else 120
            snap[k] = s2[:cap] + ("..." if len(s2) > cap else "")
    return snap


def _usage(agent: Any) -> dict:
    def _num(name: str):
        value = getattr(agent, name, None)
        return value if isinstance(value, (int, float)) else 0

    cost = getattr(agent, "session_estimated_cost_usd", None)
    return {
        "prompt_tokens": int(_num("session_prompt_tokens")),
        "completion_tokens": int(_num("session_completion_tokens")),
        "cache_read_tokens": int(_num("session_cache_read_tokens")),
        "cache_write_tokens": int(_num("session_cache_write_tokens")),
        "estimated_cost_usd": float(cost) if isinstance(cost, (int, float)) else None,
    }


def _context_length(agent: Any) -> dict:
    cc = getattr(agent, "context_compressor", None)
    if cc is None:
        return {}
    out = {}
    for key in ("context_length", "threshold_tokens", "last_prompt_tokens", "compression_count"):
        value = getattr(cc, key, None)
        if isinstance(value, (int, float)):
            out[key] = int(value)
    threshold = _next_turn_threshold(agent, cc)
    if threshold:
        out["next_turn_threshold_tokens"] = threshold
    return out


def _next_turn_threshold(agent: Any, cc: Any) -> int | None:
    """TAL-1005: the compression threshold the next turn runs under. A turn that ended on a fallback leaves the
    fallback's threshold on the compressor, but the Agent restores the primary runtime at the next turn's start
    (``restore_primary_runtime``), so this is the trigger the compressor installs for that runtime's snapshot."""
    value = getattr(cc, "threshold_tokens", None)
    primary = getattr(agent, "_primary_runtime", None)
    if getattr(agent, "_fallback_activated", False) is True and isinstance(primary, dict):
        value = primary.get("compressor_threshold_tokens")
        preview = getattr(cc, "preview_threshold_tokens", None)
        if callable(preview) and isinstance(primary.get("compressor_context_length"), int):
            try:
                value = preview(str(primary.get("compressor_model") or ""), primary["compressor_context_length"], str(primary.get("compressor_provider") or ""))
            except Exception:  # noqa: BLE001
                log.debug("primary threshold preview failed", exc_info=True)
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 else None


# TAL-539: the hard cap on raw tool output kept in a compressed context (predecessor ``_hard_prune_post_compression_*``).
_TAIL_TOOL_BUDGET_TOKENS = 4096
_TAIL_TOOL_MIN_SNIPPET_TOKENS = 256
_ROUGH_TOKEN_CHARS = 4


def _content_text(content: Any) -> str:
    if isinstance(content, list):
        return " ".join(str(p.get("text") or "") for p in content if isinstance(p, dict))
    return str(content or "")


def _rough_tokens(text: str) -> int:
    """The Agent's estimate, which counts CJK and other non-ASCII text as denser; ceil(chars / 4) without it."""
    try:
        from agent.model_metadata import estimate_tokens_rough

        return int(estimate_tokens_rough(text))
    except Exception:  # noqa: BLE001
        return -(-len(text) // _ROUGH_TOKEN_CHARS)


def _tool_failure_outcome(text: str) -> str:
    """`` FAILED: <error>`` for a JSON tool payload with a top-level ``error`` / ``success: false``, `` FAILED: exit N`` for
    a non-zero ``exit_code`` / ``exitCode`` the agent did not kill itself, else ``""``: the Agent's compression-stub rule
    (``_payload_failure_suffix``, ``_sum_process_manage``). Payloads put these fields after ``output``, so a cut drops them."""
    try:
        payload = json.loads(text)
    except (ValueError, RecursionError):
        return ""
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    if not error and payload.get("success") is not False:
        code = payload.get("exit_code")
        code = payload.get("exitCode") if code is None else code
        if not isinstance(code, int) or isinstance(code, bool) or code == 0 or payload.get("completion_reason") == "killed":
            return ""
        error = f"exit {code}"
    preview = " ".join(str(error).split())[:80] if error else ""
    return f" FAILED: {preview}" if preview else " FAILED"


def _capped_tool_result(text: str, tokens: int, keep_tokens: int) -> str:
    """The kept head of an over-budget tool result plus a note on what the model no longer sees, ending on the outcome.
    TAL-827: the Agent's elision marker marks the cut, so its dispatch guard rejects a model that copies the marker
    into a durable write; Talaria's note follows on its own line."""
    outcome = _tool_failure_outcome(text)
    try:
        from agent.compression_marker import elide_middle
    except ImportError:  # An Agent without the shared marker keeps Talaria's own.
        prefix = "[Talaria context budget: omitted "
        suffix = f" (~{tokens} rough tokens) from this tool result; the full output remains in the visible transcript.{outcome}]"
        note_only, widest = f"{prefix}{len(text)} chars{suffix}", f"{prefix}{len(text)} of {len(text)} chars{suffix}"

        def cut(snippet: str) -> str:
            return f"{snippet}\n\n{prefix}{len(text) - len(snippet)} of {len(text)} chars{suffix}"
    else:
        note = f"\n[Talaria context budget: this tool result is ~{tokens} rough tokens; the full output remains in the visible transcript.{outcome}]"
        # With nothing kept the marker counts every char, its widest form for this text.
        note_only = widest = elide_middle(text, 0, 0) + note

        def cut(snippet: str) -> str:
            return elide_middle(text, len(snippet), 0) + note
    if keep_tokens < _TAIL_TOOL_MIN_SNIPPET_TOKENS:
        return note_only
    room = keep_tokens - _rough_tokens(widest) - 1
    snippet = text[: len(text) * room // tokens]
    # Density varies along the text: shrink until the kept head fits the remaining tokens.
    while snippet and _rough_tokens(snippet) > room:
        snippet = snippet[: len(snippet) * 3 // 4]
    snippet = snippet.rstrip()
    return cut(snippet) if snippet else note_only


def _skill_result_stubs(messages: list) -> dict[int, str]:
    """Recovery metadata for paired skill loads, captured before the Agent can prune their success/failure payloads.
    Extends the Agent's call-id and marker helpers; its older summaries omit small-skill markers and failure verdicts."""
    try:
        from agent.context_compressor import _tool_calls_by_id
    except ImportError:
        return {}
    try:
        from agent.context_compressor import _skill_pruned_marker
    except ImportError:
        def _skill_pruned_marker(name: str) -> str:
            return f"[SKILL_PRUNED: content lost in compression; reload with skill_view(name='{name}')]"

    calls = _tool_calls_by_id(messages)
    stubs = {}
    for i, msg in enumerate(messages):
        if msg.get("role") != "tool" or not msg.get("tool_call_id"):
            continue
        tool, raw_args = calls.get(msg["tool_call_id"], (None, None))
        if tool != "skill_view":
            continue
        try:
            args = json.loads(raw_args)
        except (TypeError, ValueError, RecursionError):
            continue
        name = args.get("name") if isinstance(args, dict) else None
        if not isinstance(name, str) or not name or args.get("file_path"):
            continue
        text = _content_text(msg.get("content"))
        outcome = _tool_failure_outcome(text)
        if text.startswith("[skill_view] ") and " FAILED" in text.split(" (", 1)[0]:
            outcome = " FAILED"
        if outcome:
            stubs[i] = f"[skill_view] name={name}{outcome}"
            continue
        try:
            payload = json.loads(text)
        except (ValueError, RecursionError):
            payload = None
        successful = isinstance(payload, dict) and payload.get("success") is True and isinstance(payload.get("content"), str)
        marker = _skill_pruned_marker(name)
        # Lean-tail stubs predate the current cap and may have been persisted by a different supported Agent.
        demoted = text.startswith(("[skill_view output demoted at compaction ", "[tool output demoted at compaction ")) and text.endswith("] " + marker)
        if successful or text.startswith(f"[skill_view] name={name} (") or text == marker or demoted:
            stubs[i] = marker
    return stubs


def _cap_tool_results(messages: list, compressor: Any, original_messages: list | None = None) -> list:
    """Newest bodies spend one shared budget. Skill reload/failure stubs, like omission notes, survive exhaustion."""
    originals = messages if original_messages is None else original_messages
    skill_stubs = _skill_result_stubs(originals)
    budget = getattr(compressor, "tail_token_budget", None)
    budget = budget if isinstance(budget, int) and budget > 0 else _TAIL_TOOL_BUDGET_TOKENS
    threshold = getattr(compressor, "threshold_tokens", None)
    if isinstance(threshold, int) and threshold > 0:
        budget = min(budget, max(512, threshold // 2))
    budget = max(512, budget)
    spent = 0
    out = list(messages)
    for i in range(len(out) - 1, -1, -1):
        msg = out[i]
        if msg.get("role") != "tool":
            continue
        text = _content_text(msg.get("content"))
        stub = skill_stubs.get(i)
        if stub and text != _content_text(originals[i].get("content")):
            text = stub
            out[i] = {**msg, "content": text}
        if not text.strip():
            continue
        tokens = _rough_tokens(text)
        if tokens <= budget - spent:
            spent += tokens
            continue
        out[i] = {**msg, "content": stub or _capped_tool_result(text, tokens, budget - spent)}
        spent = budget
    return out


def _post_compression_context(agent: Any, messages: list, system_message: Any) -> tuple[list, int | None]:
    """TAL-539: tool output produced after a mid-turn compression never went through the compressor's pruning. Run that
    pruning plus a hard cap on the model context, and estimate the next request from it (predecessor
    ``_prune_context_tool_results_after_compression`` / ``_estimate_post_compression_context_tokens``)."""
    compressor = getattr(agent, "context_compressor", None)
    context = messages
    prune = getattr(compressor, "_prune_old_tool_results", None)
    if callable(prune):
        try:
            pruned, count = prune(copy.deepcopy(messages), protect_tail_count=getattr(compressor, "protect_last_n", 20), protect_tail_tokens=getattr(compressor, "tail_token_budget", None))
            if count and isinstance(pruned, list) and len(pruned) == len(messages):
                context = pruned
        except Exception:  # noqa: BLE001 - the hard cap below still bounds the context
            log.debug("post-compression tool-result pruning failed", exc_info=True)
    context = _cap_tool_results(context, compressor, messages)
    estimate = None
    try:
        from agent.model_metadata import estimate_request_tokens_rough

        # The request carries the ephemeral prompt (surface, personality, delivery) after the system message.
        prompts = [p for p in (system_message, getattr(agent, "ephemeral_system_prompt", None)) if isinstance(p, str) and p.strip()]
        estimate = estimate_request_tokens_rough(context, system_prompt="\n\n".join(prompts), tools=getattr(agent, "tools", None) or None)
    except Exception:  # noqa: BLE001 - display-only figure
        log.debug("post-compression context estimate failed", exc_info=True)
    return context, estimate if isinstance(estimate, int) and estimate > 0 else None


# TAL-887: the Agent's password-manager prompts, answered like a clarify; the waits are the Agent's own surfaces' (its TUI).
_VAULT_PROMPT_TIMEOUTS = {"vault_unlock": 120, "vault_save_login": 180, "vault_code": 180, "skill_secret": 120}


def _set_vault_session(session_id) -> None:
    """Bind the session an unlock made on this thread belongs to (released with it)."""
    try:
        from agent.vault_backends import unlock
    except Exception:  # noqa: BLE001 - an Agent without the credential vault
        return
    unlock.set_current_session_id(session_id)


def _release_vault_session(session_id) -> None:
    """Lock the password managers ``session_id`` unlocked; other sessions keep theirs."""
    try:
        from agent.vault_backends.unlock import release_session
    except Exception:  # noqa: BLE001 - an Agent without the credential vault
        return
    release_session(session_id)


def _set_vault_prompts(session_id, unlock_cb, save_login_cb, code_cb) -> None:
    """Bind (or with ``None``s clear) the Agent's per-thread vault prompts and the session an unlock belongs to."""
    try:
        from agent.vault_backends import unlock
    except Exception:  # noqa: BLE001 - an Agent without the credential vault
        return
    _set_vault_session(session_id)
    unlock.set_unlock_prompt_callback(unlock_cb)
    unlock.set_save_login_prompt_callback(save_login_cb)
    unlock.set_code_prompt_callback(code_cb)


def _clarify_timeout(params: dict) -> int:
    """Predecessor ``_clarify_timeout_seconds``: an explicit request value wins, else the Agent's resolver over config."""
    explicit = params.get("clarify_timeout_seconds")
    if explicit is not None:
        try:
            return int(explicit)
        except (TypeError, ValueError):
            pass
    try:
        from tools.clarify_gateway import get_clarify_timeout

        return int(get_clarify_timeout())
    except Exception:  # noqa: BLE001 - older Agent without the resolver
        pass
    try:
        from hermes_cli.config import load_config

        cfg = load_config() or {}
        raw = (cfg.get("clarify") or {}).get("timeout")
        if raw is None:
            raw = (cfg.get("agent") or {}).get("clarify_timeout", 3600)
        return int(raw)
    except Exception:  # noqa: BLE001
        return 3600


def _steer_slot_lock(agent):
    """The Agent's own pending-steer lock (a plain ``Lock``), so a slot read or rewrite is atomic against its drains."""
    lock = agent.__dict__.get("_pending_steer_lock") if hasattr(agent, "__dict__") else None
    return contextlib.nullcontext() if lock is None else lock


def _steer_slot(agent) -> str:
    """The Agent's not-yet-applied steer text; call under ``_steer_slot_lock``."""
    return str(getattr(agent, "_pending_steer", "") or "")


def _agent_pending_steer_text(agent) -> str:
    """Predecessor ``_agent_pending_steer_text``: the Agent's not-yet-applied steer text."""
    with _steer_slot_lock(agent):
        return _steer_slot(agent)


def _slot_without(slot: str, pending: list[str], index: int) -> str | None:
    """``slot`` without the steer ``pending[index]`` while the Agent still holds it, else None (it already took it).

    The Agent keeps every not-yet-applied steer in one newline-joined slot, so the slot is the tail of ``pending``
    (the server's steers, oldest first), possibly behind text another surface queued: the server's
    ``pendingSteerSuffixStart`` rule. The longest tail that still holds the steer wins."""
    for start in range(index + 1):
        tail = "\n".join(pending[start:])
        if slot == tail or slot.endswith("\n" + tail):
            head = slot[: len(slot) - len(tail)].rstrip("\n")
            return "\n".join(part for part in [head, *pending[start:index], *pending[index + 1:]] if part)
    return None


def withdraw_steer(agent, pending: list[str], index: int) -> bool:
    """TAL-424: take a not-yet-applied steer back out of the Agent's slot, keeping the others in order. False when the
    Agent already took it; the slot is then left as it was, so no text is ever lost."""
    with _steer_slot_lock(agent):
        rest = _slot_without(_steer_slot(agent), pending, index)
        if rest is None:
            return False
        agent._pending_steer = rest or None
        return True


def steer_now(agent, pending: list[str], index: int) -> dict:
    """TAL-424: deliver a pending steer now with the Agent's ``redirect``. During a model request that request restarts
    with it (``delivery: redirect``); during tools it goes back on the slot and the tools yield (``delivery: steer``).
    With no live request the steer stays pending: back in its place, or last when the slot changed meanwhile."""
    text = pending[index]
    with _steer_slot_lock(agent):
        before = _steer_slot(agent)
        rest = _slot_without(before, pending, index)
        if rest is None:
            return {"redirected": False, "withdrawn": False}
        agent._pending_steer = rest or None
    redirect = getattr(agent, "redirect", None)
    try:
        redirected = bool(redirect(text)) if callable(redirect) else False
    except Exception as exc:  # noqa: BLE001
        log.debug("redirect failed: %s", exc)
        redirected = False
    if not redirected:
        with _steer_slot_lock(agent):
            if _steer_slot(agent) == rest:
                agent._pending_steer = before or None
                return {"redirected": False, "withdrawn": True, "requeued": "kept"}
        agent.steer(text)
        return {"redirected": False, "withdrawn": True, "requeued": "last"}
    with _steer_slot_lock(agent):
        slot = _steer_slot(agent)
    delivery = "steer" if slot == text or slot.endswith("\n" + text) else "redirect"
    return {"redirected": True, "withdrawn": True, "delivery": delivery}


def _steer_queue_params(params: dict) -> tuple[list[str], int]:
    pending = params.get("pending")
    index = params.get("index")
    if not isinstance(pending, list) or not all(isinstance(t, str) and t.strip() for t in pending):
        raise InvalidParams("pending must be a list of steer texts")
    if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(pending):
        raise InvalidParams("index must point into pending")
    return [t.strip() for t in pending], index


def _cancel_checkpoint(run: _Run) -> list | None:
    """The Agent's canonical transcript at the stop boundary (the turn's prompt, completed tool calls and results),
    which the live frames only project. The Agent republishes ``_session_messages`` after every tool round; until it
    does, it still holds the previous turn's list and there is no checkpoint."""
    agent = run.agent
    messages = getattr(agent, "_session_messages", None) if agent is not None else None
    if not isinstance(messages, list) or messages is run.prior_messages:
        return None
    try:
        return json.loads(json.dumps([m for m in list(messages) if isinstance(m, dict)], default=str))
    except Exception:  # noqa: BLE001 - a row the Agent is still mutating; Stop must not fail on it
        log.debug("cancel checkpoint snapshot failed", exc_info=True)
        return None


def _resolve_runtime(provider: str | None, model: str) -> dict:
    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"runtime provider unavailable: {exc}", condition="providers_unavailable") from exc
    try:
        runtime = resolve_runtime_provider(requested=provider or None, target_model=model or None)
    except Exception as exc:  # noqa: BLE001
        raise runtime_failure(exc, provider) from exc
    if not isinstance(runtime, dict):
        runtime = dict(vars(runtime)) if hasattr(runtime, "__dict__") else {}
    return runtime


@contextlib.contextmanager
def _turn_identity(session_id: str, workspace: str):
    """Bind this turn's identity to the calling context the way the predecessor's ``_set_turn_session_identity`` did:
    the approval session key (so ``register_gateway_notify`` cards reach this turn and dangerous commands are gated
    instead of auto-approved), the gateway session vars (platform ``webui``, chat/ui session ids, profile), and the session cwd
    (so terminals and AGENTS.md discovery run in the selected workspace, not the sidecar's launch directory). Every
    binding is a context variable, so concurrent turns cannot overwrite each other. Missing Agent surfaces are logged,
    not fatal."""
    resets: list = []
    try:
        from tools.approval_context import reset_current_session_key, set_current_session_key

        token = set_current_session_key(session_id)
        resets.append(lambda: reset_current_session_key(token))
    except Exception:  # noqa: BLE001
        log.debug("per-turn approval session-key bind failed", exc_info=True)
    try:
        from gateway import session_context as sc
        from hermes_cli.profiles import get_active_profile_name
        from hermes_constants import get_hermes_home, profile_name_for_home

        # The persistent Docker sandbox is keyed by the profile name; unbound, every profile reuses "default".
        profile = profile_name_for_home(get_hermes_home()) or get_active_profile_name()
        pairs = [
            (sc._SESSION_KEY, session_id), (sc._SESSION_UI_SESSION_ID, session_id), (sc._SESSION_PLATFORM, "webui"),
            (sc._SESSION_CHAT_ID, session_id), (sc._SESSION_ID, session_id), (sc._SESSION_PROFILE, profile),
        ]
        for var, value in pairs:
            tok = var.set(value)
            resets.append(lambda var=var, tok=tok: var.reset(tok))
    except Exception:  # noqa: BLE001
        log.debug("per-turn session context bind failed", exc_info=True)
    try:
        with session_workspace(workspace):
            yield
    finally:
        for reset in reversed(resets):
            try:
                reset()
            except Exception:  # noqa: BLE001
                log.debug("per-turn identity reset failed", exc_info=True)


#: Older configs named the CLI composite ``hermes``; the Agent registers it split in two (predecessor
#: ``_LEGACY_CLI_TOOLSET_ALIASES``). Agent 0.21.6 expands it itself; delete this once 0.21.6 is the oldest supported.
_LEGACY_TOOLSET_ALIASES = {"hermes": ("hermes-cli", "hermes-api-server")}


def _turn_toolsets(toolsets) -> list[str]:
    """The session's override as sent, else the profile's configured toolsets. ``None`` would hand the Agent every
    registered toolset."""
    return toolsets if isinstance(toolsets, list) else _profile_toolsets()


def _profile_toolsets() -> list[str]:
    """The profile's ``platform_toolsets.cli`` through the Agent's own resolver (default-off toolsets stay off), like
    ``hermes chat``. Runs under the call's ``scoped_home``."""
    from hermes_cli.config import load_config
    from hermes_cli.tools_config import _get_platform_tools

    resolved = sorted(_get_platform_tools(load_config() or {}, "cli"))
    return list(dict.fromkeys(name for raw in resolved for name in _LEGACY_TOOLSET_ALIASES.get(raw, (raw,))))


def _discover_mcp_tools(run: _Run) -> threading.Event | None:
    """Wait for the profile's first discovery; later turns give a shared background retry at most two seconds."""
    from .commands import discover_profile_mcp_tools, profile_mcp_tools_discovered

    profile_home = run.home
    home = os.path.realpath(profile_home)
    deadline = time.monotonic() + _MCP_REDISCOVERY_WAIT if profile_mcp_tools_discovered(home) else None

    def discover() -> None:
        try:
            discovered = discover_profile_mcp_tools()
            refresh_profile_agents_mcp_tools(profile_home)
            done.startup_outcome = "ok" if discovered else "noop"
        except Exception:  # noqa: BLE001
            done.startup_outcome = "error"
            log.warning("MCP discovery failed", exc_info=True)
        finally:
            with _RELEASES_LOCK:
                _RELEASES.pop(worker, None)
            done.set()

    with _MCP_DISCOVERY_LOCK:
        if _DRAINING.is_set():
            raise RpcError("The sidecar is shutting down.", condition="sidecar_unavailable")
        if home in _MCP_CLOSING_HOMES:
            raise RpcError("The profile is being deleted.", condition="profile_unavailable")
        done = _MCP_DISCOVERIES.get(home)
        if done is None or done.is_set():
            done = threading.Event()
            done.startup_outcome = "unknown"
            _MCP_DISCOVERIES[home] = done
            # The copied context carries the turn's home override and secret scope into the worker.
            worker = threading.Thread(target=contextvars.copy_context().run, args=(discover,), daemon=True, name=f"chat-mcp-{run.stream_id[:8]}")
            worker.failed = False
            # Existing profile/shutdown custody includes this worker after its originating turn has ended.
            with _RELEASES_LOCK:
                _RELEASES[worker] = profile_home
            try:
                worker.start()
            except Exception:
                with _RELEASES_LOCK:
                    _RELEASES.pop(worker, None)
                done.set()
                raise
    while not done.is_set():
        if run.cancel.is_set() or run.ctx.cancelled:
            run.mcp_discovery_outcome = "cancelled"
            return None
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            run.mcp_discovery_outcome = "timeout"
            run.ctx.emit("notice", {"key": _MCP_PENDING_KEY, "level": "info", "kind": "sticky",
                                    "text": "Some tools are still connecting. Using available tools for this turn.",
                                    "lapses_with_agent": False})
            return done
        done.wait(0.25 if remaining is None else min(0.25, remaining))
    run.mcp_discovery_outcome = getattr(done, "startup_outcome", "ok")
    return None


# Serializes every hook change the sidecar makes, so two turns or a turn and a profile deletion never interleave a
# drop with a registration.
_HOOKS_LOCK = threading.Lock()
_HOOK_CALLBACK_PREFIXES = {"agent.shell_hooks": "shell_hook[", "agent.outbound_webhooks": "outbound_webhook["}


def _drop_home_callbacks(*modules) -> None:
    """Forget this home's registrations in each Agent hook module and remove their callbacks from the home's plugin
    manager; the Agent has no teardown for either registry. Runs under the call's ``scoped_home`` and ``_HOOKS_LOCK``."""
    from agent import shell_hooks
    from hermes_cli.plugins import get_plugin_manager

    prefixes = tuple(_HOOK_CALLBACK_PREFIXES[module.__name__] for module in modules)
    for module in modules:
        shell_hooks._forget_home_registrations(module._registered, module._registered_lock)
    manager = get_plugin_manager()
    with shell_hooks._registered_lock:
        for event, callbacks in list(manager._hooks.items()):
            # Replaced, never edited in place: a concurrent invoke_hook keeps iterating the old list.
            manager._hooks[event] = [cb for cb in callbacks if not getattr(cb, "__name__", "").startswith(prefixes)]


def _hook_state_trusted(shell_hooks, cfg: dict) -> bool:
    """``sync_from_config``'s removal guard for Agents without it: an empty (failed-open) config, an unreadable
    allowlist or a ``hooks:`` entry the Agent could not parse must never disarm a registered guard."""
    if not cfg:
        return False
    try:
        allowlist = json.loads(shell_hooks.allowlist_path().read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        allowlist = {"approvals": []}
    except (OSError, ValueError):
        return False
    if not isinstance(allowlist, dict) or not isinstance(allowlist.get("approvals"), list):
        return False
    hooks = cfg.get("hooks")
    if hooks is None:
        return True
    if not isinstance(hooks, dict):
        return False
    events = [entries for event, entries in hooks.items() if event not in ("output_spill", "outbound") and entries is not None]
    if not all(isinstance(entries, list) for entries in events):
        return False
    return len(shell_hooks.iter_configured_hooks(cfg)) == sum(len(entries) for entries in events)


def _replace_shell_hooks(shell_hooks, cfg: dict) -> None:
    """Agents without ``sync_from_config``: wire the home's consented hooks from ``cfg`` and drop the rest, so a hook
    removed from config or revoked stops, as it does on v0.22.3. The stale callbacks go only after the current set is
    wired, so a concurrent turn's tool call always meets its guard. Add-only when the hook state is not trusted."""
    if not _hook_state_trusted(shell_hooks, cfg):
        shell_hooks.register_from_config(cfg, accept_hooks=False)
        return
    from hermes_cli.plugins import get_plugin_manager

    manager = get_plugin_manager()
    stale = [cb for callbacks in manager._hooks.values() for cb in callbacks if getattr(cb, "__name__", "").startswith("shell_hook[")]
    shell_hooks._forget_home_registrations(shell_hooks._registered, shell_hooks._registered_lock)
    shell_hooks.register_from_config(cfg, accept_hooks=False)
    with shell_hooks._registered_lock:
        for event, callbacks in list(manager._hooks.items()):
            manager._hooks[event] = [cb for cb in callbacks if not any(cb is old for old in stale)]


def _register_profile_hooks(home: Path) -> None:
    """Wire the profile's consented shell hooks and current outbound webhooks before the turn's tools run, like the
    gateway on every session open (TAL-1258). Hooks added or approved since the last call join this one; hooks removed
    from config or revoked stop, through ``sync_from_config`` or its sidecar twin for older Agents. Outbound webhooks
    are add-only on every Agent, so each call replaces the home's set with the configured one (a concurrent turn's
    notification can miss that instant; webhooks only observe). Consent comes from the allowlist or an opt-in in
    force: stdin is the RPC pipe, so nothing prompts. A failure is logged and never blocks the turn."""
    try:
        from agent import outbound_webhooks, shell_hooks
        from hermes_cli.config import load_config

        with _HOOKS_LOCK:
            sync = getattr(shell_hooks, "sync_from_config", None)
            if sync is not None:
                sync(load_config)
            else:
                _replace_shell_hooks(shell_hooks, load_config())
            _drop_home_callbacks(outbound_webhooks)
            outbound_webhooks.register_from_config(load_config())
    except Exception:  # noqa: BLE001
        log.warning("shell-hook sync failed; keeping the registered hooks", exc_info=True)


def forget_profile_hooks(home: Path) -> None:
    """Profile deletion: drop the home's shell hooks and outbound webhooks. The Agent keys both registries and its
    plugin manager by path, so a profile recreated at that path would otherwise fire hooks its new config and allowlist
    never approved. Raises rather than let the profile go with its hooks still wired."""
    try:
        from agent import outbound_webhooks, shell_hooks
    except ImportError:  # no Agent, so no hook was ever registered
        return
    with _HOOKS_LOCK, scoped_home(home):
        _drop_home_callbacks(shell_hooks, outbound_webhooks)


@contextlib.contextmanager
def agent_scope(home: Path):
    """``scoped_home`` for a call that runs Agent work: the profile's hooks are wired before any of it (TAL-1258), so
    the call's first LLM request, tool call or lifecycle event already sees them, even as a session's first work after
    a sidecar restart."""
    with scoped_home(home):
        _register_profile_hooks(home)
        yield


def _notify_archive(home: Path, session_id: str, lineage: list[str] | None) -> None:
    import hermes_state_common

    emit = getattr(hermes_state_common, "emit_session_deleted", None)
    if emit is None:
        return
    # Upstream hook warnings can include arbitrary callback exceptions. Keep one payload-free diagnostic.
    thread_id, warned = threading.get_ident(), False

    def bounded_diagnostic(record):
        nonlocal warned
        if record.thread != thread_id:
            return True
        warned = warned or record.levelno >= logging.WARNING
        return False

    handlers = list(logging.getLogger().handlers)
    for handler in handlers:
        handler.addFilter(bounded_diagnostic)
    try:
        # The emitter only needs db_path for profile identity. Opening SessionDB would migrate an owner's store.
        emit(SimpleNamespace(db_path=home / "state.db"), [session_id, *(lineage or [])],
             reason="archive", primary=session_id, sessions_dir=home / "sessions")
    finally:
        for handler in handlers:
            handler.removeFilter(bounded_diagnostic)
        if warned:
            log.warning("Session archive notification reported a callback failure")


def _profile_fallback_chain() -> list[dict] | None:
    """The profile's fallback routes (``fallback_providers`` first, then legacy ``fallback_model``, deduplicated)
    through the Agent's own resolver, like the CLI and gateway. Runs under the call's ``scoped_home``."""
    from hermes_cli.config import load_config
    from hermes_cli.fallback_config import get_fallback_chain

    return get_fallback_chain(load_config() or {}) or None


def _profile_prefill_messages() -> list[dict] | None:
    """The profile's few-shot prefill (``HERMES_PREFILL_MESSAGES_FILE``, then ``prefill_messages_file``, then legacy
    ``agent.prefill_messages_file``; relative to the profile) through the Agent's own loader, like the CLI, gateway and
    Desktop. A missing or empty file is None. Runs under the call's ``scoped_home``."""
    from hermes_cli.cli_config_load import _load_prefill_messages, _resolve_prefill_messages_file
    from hermes_cli.config import load_config
    from hermes_constants import get_hermes_home

    return _load_prefill_messages(_resolve_prefill_messages_file(load_config() or {}), get_hermes_home()) or None


def _main_model_request_overrides(model: str, provider, base_url: str = "") -> dict | None:
    """Predecessor ``_main_model_request_overrides``: the profile's ``model.service_tier`` and ``model.extra_body``
    (written by ``/api/model/set``) apply only to turns on that configured main model. Runs under ``scoped_home``."""
    from hermes_cli.config import load_config

    model_cfg = (load_config() or {}).get("model")
    if not isinstance(model_cfg, dict):
        return None
    main_model = str(model_cfg.get("default") or model_cfg.get("name") or "").strip()
    main_provider = str(model_cfg.get("provider") or "").strip().lower()
    if not main_model or main_model != model.strip():
        return None
    # An unset or ``auto`` main provider resolves at runtime, so the model id alone identifies the main model.
    from hermes_cli.models import normalize_provider

    if main_provider not in ("", "auto") and normalize_provider(main_provider) != normalize_provider(str(provider or "").strip().lower()):
        return None
    from ..speed import fast_overrides

    overrides = fast_overrides(model, str(provider or ""), base_url, str(model_cfg.get("service_tier") or "").strip().lower()) or {}
    extra_body = model_cfg.get("extra_body")
    if isinstance(extra_body, dict) and extra_body:
        overrides["extra_body"] = extra_body
    return overrides or None


def _request_overrides(model: str, provider, runtime: dict) -> dict | None:
    """The resolver's ``request_overrides`` (a custom provider entry's ``extra_body``) under the main-model ones, whose
    ``extra_body`` wins key by key, the Agent's own merge order. Runs under ``scoped_home``."""
    merged = dict(runtime.get("request_overrides") or {})
    main = _main_model_request_overrides(model, provider, str(runtime.get("base_url") or "")) or {}
    extra_body = {**(merged.get("extra_body") or {}), **(main.get("extra_body") or {})}
    merged.update(main)
    if extra_body:
        merged["extra_body"] = extra_body
    return merged or None


def _provider_routing_kwargs() -> dict:
    """The profile's OpenRouter ``provider_routing`` and ``openrouter.min_coding_score`` as ``AIAgent`` kwargs, with the
    Agent's own mapping (``gateway/session_worker_construct.routing_agent_kwargs``). The score is coerced like the CLI's
    (``cli_init_mixin``), so a quoted number counts and a value outside 0..1 stays unset. Runs under ``scoped_home``."""
    from hermes_cli.config import load_config

    cfg = load_config() or {}
    routing = cfg.get("provider_routing")
    routing = routing if isinstance(routing, dict) else {}
    openrouter = cfg.get("openrouter")
    raw_score = openrouter.get("min_coding_score") if isinstance(openrouter, dict) else None
    try:
        score = float(raw_score) if raw_score not in (None, "") else None
    except (TypeError, ValueError):
        score = None
    return {
        "providers_allowed": routing.get("only"), "providers_ignored": routing.get("ignore"),
        "providers_order": routing.get("order"), "provider_sort": routing.get("sort"),
        "provider_require_parameters": routing.get("require_parameters", False),
        "provider_data_collection": routing.get("data_collection"),
        "openrouter_min_coding_score": score if score is not None and 0.0 <= score <= 1.0 else None,
    }


def _agent_signature(model: str, provider, runtime: dict, toolsets, home: str, kwargs: dict) -> str:
    """Cache identity of an ``AIAgent``: everything its constructor bound from the resolved runtime, so a rotated key,
    a different API mode, ACP command, or credential pool never reuses an agent built for the old bundle. The key
    itself only enters as a digest."""
    api_key = runtime.get("api_key")
    key_digest = hashlib.sha256(str(api_key).encode("utf-8")).hexdigest()[:16] if api_key else None
    pool = runtime.get("credential_pool")
    pool_identity = pool if isinstance(pool, (str, int, float, bool, list, dict)) or pool is None else f"{type(pool).__name__}:{getattr(pool, 'name', None) or getattr(pool, 'provider', None) or id(pool)}"
    bundle = {
        "model": model, "provider": provider, "base_url": runtime.get("base_url"), "api_key": key_digest,
        "api_mode": runtime.get("api_mode"), "acp_command": runtime.get("acp_command"), "acp_args": runtime.get("acp_args"),
        "credential_pool": pool_identity, "toolsets": toolsets, "home": home, "cwd": kwargs.get("cwd"),
        "disabled_toolsets": kwargs.get("disabled_toolsets"),
        "max_iterations": kwargs.get("max_iterations"), "max_tokens": kwargs.get("max_tokens"),
        # Bound at construction too: a reasoning-effort change from the composer must build a fresh agent.
        "reasoning_config": kwargs.get("reasoning_config"),
        "request_overrides": kwargs.get("request_overrides"),
        "provider_routing": [kwargs.get(name) for name in (
            "providers_allowed", "providers_ignored", "providers_order", "provider_sort", "provider_require_parameters",
            "provider_data_collection", "openrouter_min_coding_score")],
        "checkpoints": [kwargs.get(name) for name in ("checkpoints_enabled", "checkpoint_max_snapshots", "checkpoint_max_total_size_mb", "checkpoint_max_file_size_mb")],
        # Entries may carry their own ``api_key``.
        "fallback_model": hashlib.sha256(json.dumps(kwargs.get("fallback_model"), sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16],
        # Read each turn, so an edited prefill file builds a fresh agent.
        "prefill_messages": hashlib.sha256(json.dumps(kwargs.get("prefill_messages"), sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16],
    }
    return json.dumps(bundle, sort_keys=True, default=str)


def _agent_kwargs(AIAgent, params: dict, session_id: str, model: str, provider, runtime: dict, toolsets) -> dict:
    """The ``AIAgent`` arguments of a session's agent apart from a turn's callbacks: the resolved runtime, the session's
    toolsets and budgets, and the profile's fallback chain, request overrides, prefill and checkpoints. Everything
    ``_agent_signature`` reads is here, so an agent ``/refine`` builds (TAL-902) is the one the next turn reuses. Runs under
    the call's ``scoped_home``."""
    kwargs: dict = dict(
        model=model,
        provider=provider,
        base_url=runtime.get("base_url"),
        api_key=runtime.get("api_key"),
        platform="webui",
        quiet_mode=True,
        enabled_toolsets=toolsets,
        disabled_toolsets=disabled_toolsets(),
        session_id=session_id,
    )
    for name, value in (
        ("api_mode", runtime.get("api_mode")),
        ("acp_command", runtime.get("acp_command")),
        ("acp_args", runtime.get("acp_args")),
        ("credential_pool", runtime.get("credential_pool")),
        ("gateway_session_key", session_id),
        # TAL-903: anchors subdirectory AGENTS.md discovery (and the memory provider) at the session workspace, when the
        # server says it is a host path; a remote terminal backend's target-side path must never be read on the host.
        ("cwd", params.get("workspace") if params.get("workspace_local") is True else None),
    ):
        if _supported(AIAgent, name) and value is not None:
            kwargs[name] = value
    if isinstance(params.get("max_iterations"), int) and params["max_iterations"] > 0 and _supported(AIAgent, "max_iterations"):
        kwargs["max_iterations"] = params["max_iterations"]
    if isinstance(params.get("max_tokens"), int) and params["max_tokens"] > 0 and _supported(AIAgent, "max_tokens"):
        kwargs["max_tokens"] = params["max_tokens"]
    # Predecessor: `agent.reasoning_effort` (already coerced for the model) → AIAgent ``reasoning_config``.
    reasoning_config = params.get("reasoning_config")
    if isinstance(reasoning_config, dict) and _supported(AIAgent, "reasoning_config"):
        kwargs["reasoning_config"] = reasoning_config
    fallback_chain = _profile_fallback_chain()
    if fallback_chain and _supported(AIAgent, "fallback_model"):
        kwargs["fallback_model"] = fallback_chain
    request_overrides = _request_overrides(model, provider, runtime)
    if request_overrides and _supported(AIAgent, "request_overrides"):
        kwargs["request_overrides"] = request_overrides
    prefill_messages = _profile_prefill_messages()
    if prefill_messages and _supported(AIAgent, "prefill_messages"):
        kwargs["prefill_messages"] = prefill_messages
    # TAL-976: the profile's OpenRouter provider routing, as the Agent's own CLI and gateway turns read it.
    for name, value in _provider_routing_kwargs().items():
        if _supported(AIAgent, name):
            kwargs[name] = value
    # TAL-913: the profile's ``checkpoints`` section, as the Agent's own CLI and gateway turns read it.
    for name, value in checkpoint_kwargs().items():
        if _supported(AIAgent, name):
            kwargs[name] = value
    return kwargs


def _build_agent(AIAgent, kwargs: dict, home, session_id: str, state_db: bool = True):
    """A new session agent on the profile's ``state.db`` (unless ``state_db`` is false), which it releases with it."""
    session_db = _acquire_session_db(home) if state_db and _supported(AIAgent, "session_db") else None
    if session_db is not None:
        kwargs["session_db"] = session_db
        kwargs["session_id"] = _execution_session_id(session_db, session_id)
    try:
        agent = AIAgent(**kwargs)
    except BaseException:
        release_session_db(session_db)
        raise
    agent._talaria_session_db = session_db  # released with the agent (``_release_agent``)
    return agent


def _evict_idle_agents_locked() -> None:
    """Trim the agent LRU (caller holds ``_AGENT_CACHE_LOCK``), never dropping a session whose turn is still running."""
    if len(_AGENT_CACHE) <= _AGENT_CACHE_MAX:
        return
    with _RUNS_LOCK:
        live = {sid for sid, sid_stream in _RUNS_BY_SESSION.items() if (r := _RUNS.get(sid_stream)) is not None and not r.finished.is_set()}
    dropped = []
    for sid in list(_AGENT_CACHE):
        if len(_AGENT_CACHE) <= _AGENT_CACHE_MAX:
            break
        if sid not in live:
            dropped.append(_AGENT_CACHE.pop(sid))
    _release_agents_locked(dropped)


def _release_agent(agent, home) -> threading.Thread:
    """The gateway's soft eviction on a daemon thread under the owning profile: end the memory session with the
    transcript (``on_session_end``, then provider shutdown), then release the LLM clients (the Codex app-server child,
    httpx pools) while session tool state stays for a resumed session."""

    def call(name: str, *args) -> bool:
        method = getattr(agent, name, None)
        if not callable(method):
            return True
        try:
            method(*args)
        except Exception:  # noqa: BLE001 - one failed phase never skips the next
            log.warning("evicted agent %s() failed", name, exc_info=True)
            return False
        return True

    def release() -> None:
        released = False
        try:
            with scoped_home(home):
                messages = getattr(agent, "_session_messages", None)
                flushed = call("shutdown_memory_provider", messages if isinstance(messages, list) else None)
                released = True
                thread.failed = not (call("release_clients") and flushed)
        except Exception:  # noqa: BLE001 - the profile scope could not be entered
            log.warning("releasing an evicted agent under its profile failed", exc_info=True)
            thread.failed = True
        finally:
            if not released:
                # The memory flush needs the profile; the LLM clients and the Codex child close regardless.
                call("release_clients")
            release_session_db(getattr(agent, "_talaria_session_db", None))
            with _RELEASES_LOCK:
                _RELEASES.pop(thread, None)

    thread = threading.Thread(target=release, daemon=True, name="chat-agent-release")
    thread.failed = False  # type: ignore[attr-defined] - read by profile deletion
    with _RELEASES_LOCK:
        _RELEASES[thread] = home
    thread.start()
    return thread


def _release_agents_locked(entries) -> list[threading.Thread]:
    """Release cache entries that just left the cache (caller holds ``_AGENT_CACHE_LOCK``). An agent a turn still holds
    keeps its memory provider and clients; that turn releases it when it ends."""
    with _RUNS_LOCK:
        held = [run.agent for run in _RUNS.values()] + [agent for agent, _home in _COMMITTING]
    return [_release_agent(agent, home) for agent, _signature, home in entries if not any(agent is other for other in held)]


def _release_if_dropped_locked(agent, home) -> None:
    """A holder (turn or commit) is done with ``agent``: release it if it left the cache meanwhile and nothing else holds
    it (caller holds ``_AGENT_CACHE_LOCK``)."""
    if agent is not None and not any(entry[0] is agent for entry in _AGENT_CACHE.values()):
        _release_agents_locked([(agent, None, home)])


def _join(threads, deadline: float) -> None:
    for thread in threads:
        thread.join(max(0.0, deadline - time.monotonic()))


def _cancel_background_reviews(entries, message: str) -> list[threading.Thread]:
    """TAL-897: stop the post-turn memory/skill review fork of each ``(agent, home)``, which no turn interrupt or release
    reaches, so a deleted session or a stopping sidecar no longer pays for it. Each cancel then holds the agent's review
    slot (a run token from the Agent's ``prepare_background_review_run``, never finished), so the Agent admits no later
    review: not from a turn still running (a clear does not stop it), a spawn already under way, or a review deferred to
    or requeued on the idle queue (managed local runtime). ``skip_background_review`` spares the turn finalizer queueing
    one at all. Only a turn's start waits on a held slot, and an ended agent runs no further turn.

    A cancel lasts until its fork acknowledges, which the Agent's own wait does not bound, and runs as a release under
    ``home`` (``_RELEASES``): shutdown waits for it, and profile deletion, retries included, refuses while it runs or
    once it failed."""
    unique = {id(agent): (agent, home) for agent, home in entries if agent is not None}
    for agent, _home in unique.values():
        try:
            agent.skip_background_review = True
        except AttributeError:  # an object without instance attributes forks no reviews
            pass
    try:
        from agent.background_review import cancel_background_review_for_live_turn, prepare_background_review_run
    except ImportError:
        return []

    def cancel(agent) -> None:
        thread = threading.current_thread()
        try:
            try:
                # One cancel per agent at a time, so none mistakes another's freshly held slot for a review to cancel.
                lock = vars(agent).setdefault("_talaria_review_cancel_lock", threading.Lock())
            except TypeError:
                return  # no instance attributes, so no review slot either
            with lock:
                # A spawn that slipped in between the cancel and the slot claim is cancelled on the next pass.
                for _ in range(3):
                    if getattr(agent, "_talaria_review_slot", None) is not None:
                        return
                    cancel_background_review_for_live_turn(agent, message=message, tool_reason="session ended")
                    slot = prepare_background_review_run(agent)
                    if slot is not None:
                        agent._talaria_review_slot = slot
                        return
                    current = getattr(agent, "_background_review_run", None)
                    if current is None:
                        return  # not an Agent with a review slot
                    if current.cancel_requested.is_set():
                        # A cancelled fork past the Agent's wait may still write: wait for it to acknowledge, then claim
                        # the slot before the Agent can requeue it.
                        current.request_done.wait()
            log.warning("a background review kept restarting after its session ended")
            thread.failed = True
        except Exception:  # noqa: BLE001 - teardown continues without it
            log.warning("cancelling a background review failed", exc_info=True)
            thread.failed = True
        finally:
            with _RELEASES_LOCK:
                _RELEASES.pop(thread, None)

    threads = []
    for agent, home in unique.values():
        thread = threading.Thread(target=cancel, args=(agent,), daemon=True, name="chat-review-cancel")
        thread.failed = False  # type: ignore[attr-defined] - read by profile deletion
        with _RELEASES_LOCK:
            _RELEASES[thread] = home
        thread.start()
        threads.append(thread)
    return threads


def evict_all_agents() -> int:
    """Drop every cached agent (credentials or environment changed underneath them)."""
    with _AGENT_CACHE_LOCK:
        entries = list(_AGENT_CACHE.values())
        _AGENT_CACHE.clear()
        _release_agents_locked(entries)
    return len(entries)


def drain_agents(timeout: float = _AGENT_RELEASE_TIMEOUT) -> None:
    """Shutdown: release every cached agent, stop running turns (like a Stop) so each releases the agent it holds, and
    wait, bounded, for those turns and every release still running."""
    deadline = time.monotonic() + timeout
    with _MCP_DISCOVERY_LOCK, _AGENT_CACHE_LOCK, _RUNS_LOCK:
        # Admission closes with the snapshot, so no later turn forks a review outside it.
        _DRAINING.set()
        runs = list(_RUNS.values())
        owners = [(entry[0], entry[2]) for entry in _AGENT_CACHE.values()] + [(run.agent, run.home) for run in runs]
        for run in runs:
            run.session_ended = True
    _cancel_background_reviews(owners, "sidecar shutting down")
    evict_all_agents()
    for run in runs:
        run.cancel.set()
    while time.monotonic() < deadline:
        with _AGENT_CACHE_LOCK, _RUNS_LOCK:
            if not _COMMITTING and not any(_RUNS.get(run.stream_id) is run for run in runs):
                break
        time.sleep(0.05)
    # A turn may have cached its agent after the first eviction.
    evict_all_agents()
    with _RELEASES_LOCK:
        threads = list(_RELEASES)
    _join(threads, deadline)
    # TAL-1191: the state.db handles state_db writes keep between turns; each final release checkpoints once.
    release_all()


def refresh_profile_agents_mcp_tools(home) -> None:
    """MCP reload: republish the live registry's tools to the profile's cached agents, like the gateway's
    ``_mcp_reload_refresh_cached_agents``. ``content_aware`` publishes a same-name schema change on every supported
    Agent (0.22.0 implies it for an explicit reload, 0.21.x does not). Each agent keeps its build-time toolset
    selection. An agent whose refresh fails leaves the cache, so its session's next turn builds one from the live
    registry instead of keeping stale schemas; the rest still refresh."""
    from tools.mcp_tool_agent import refresh_agent_mcp_tools

    target = os.path.realpath(home)
    with _AGENT_CACHE_LOCK:
        failed = []
        for session_id, entry in list(_AGENT_CACHE.items()):
            if os.path.realpath(entry[2]) != target:
                continue
            try:
                refresh_agent_mcp_tools(entry[0], quiet_mode=True, content_aware=True)
            except Exception:  # noqa: BLE001
                log.warning("Failed to refresh MCP tools for session %s; evicting its agent", session_id, exc_info=True)
                failed.append(_AGENT_CACHE.pop(session_id))
        _release_agents_locked(failed)


@contextlib.contextmanager
def release_profile_agents(home):
    """Fence discovery and drain this profile's agents and background work before the caller removes its home."""
    from .commands import forget_profile_mcp_tools

    target = os.path.realpath(home)
    with _MCP_DISCOVERY_LOCK:
        if target in _MCP_CLOSING_HOMES:
            raise RpcError("The profile is already being deleted.", condition="profile_unavailable")
        _MCP_CLOSING_HOMES.add(target)
    try:
        with _AGENT_CACHE_LOCK:
            entries = [_AGENT_CACHE.pop(sid) for sid, entry in list(_AGENT_CACHE.items()) if os.path.realpath(entry[2]) == target]
            started = _release_agents_locked(entries)
        started += _cancel_background_reviews([(entry[0], entry[2]) for entry in entries], "profile deleted")
        deadline = time.monotonic() + _PROFILE_RELEASE_TIMEOUT
        # A commit or refine under the home holds its agent past the cache; the agent's release starts when it lets go.
        while (holding := _holding_home(target)) and time.monotonic() < deadline:
            time.sleep(0.05)
        # The threads started here count even once they left ``_RELEASES``: a fast failure must still block the delete.
        with _RELEASES_LOCK:
            threads = list(dict.fromkeys(started + [thread for thread, owner in _RELEASES.items() if owner is not None and os.path.realpath(owner) == target]))
        _join(threads, deadline)
        if any(thread.is_alive() and thread.name.startswith("chat-mcp-") for thread in threads):
            raise RpcError("The profile is still connecting MCP tools. Retry in a moment.")
        if holding or any(thread.is_alive() for thread in threads):
            raise RpcError("The profile is still saving memory from its chats. Retry in a moment.")
        if any(thread.failed for thread in threads):
            raise RpcError("Memory from the profile's chats could not be saved; see the sidecar log. Retry to delete the profile anyway.")
        release_home(target)
        yield
        # The old generation has no worker left that could restore its readiness after deletion.
        forget_profile_mcp_tools(target)
        with _MCP_DISCOVERY_LOCK:
            _MCP_DISCOVERIES.pop(target, None)
    finally:
        with _MCP_DISCOVERY_LOCK:
            _MCP_CLOSING_HOMES.discard(target)


def _holding_home(target: str) -> bool:
    with _AGENT_CACHE_LOCK:
        return any(os.path.realpath(home) == target for _agent, home in _COMMITTING)


def _acquire_session_db(home):
    """TAL-529: the profile's ``state.db`` from the Agent's shared-handle registry, one reference per agent (released with
    it), so the turn's conversation reaches ``hermes sessions``, CLI resume, and ``session_search``. None when it cannot
    open: the turn runs without it, like the predecessor's ``_build_session_db_for_stream``."""
    try:
        from hermes_state_registry import acquire

        return acquire(Path(home) / "state.db")
    except Exception:  # noqa: BLE001
        log.warning("state.db unavailable under %s; this agent's turns will not reach it", home, exc_info=True)
        return None


def _execution_session_id(db, session_id: str) -> str:
    """Predecessor ``_resolve_agent_execution_session_id``: a new agent for a session the Agent rotated by compression
    (the old agent went with a sidecar restart or a runtime change) runs on the live tip, with the server's history,
    rather than the closed Web id. The tip qualifies as in the Agent's own adoption: a different, still-open row. Any
    doubt keeps the Web id."""
    try:
        tip = db.get_compression_tip(session_id)
        if tip and tip != session_id:
            row = db.get_session(tip)
            if row and row.get("ended_at") is None:
                log.info("agent for %s runs on its live compression tip %s", session_id, tip)
                return str(tip)
    except Exception:  # noqa: BLE001
        log.warning("compression tip lookup failed for %s", session_id, exc_info=True)
    return session_id


def _agent_class():
    try:
        from run_agent import AIAgent
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"AIAgent unavailable: {exc}", condition="agent_unavailable") from exc
    return AIAgent


def _require_data_use_support(history: list) -> frozenset[str]:
    """A downgraded Agent must never send history whose connector privacy requirements it cannot enforce."""
    if not any(isinstance(row, dict) and row.get("data_use") for row in history):
        return frozenset()
    try:
        from agent.message_metadata import DATA_USE, data_use_requirement
    except ImportError:
        pass
    else:
        if DATA_USE == "data_use" and callable(data_use_requirement):
            return data_use_requirement(history)
    raise RpcError("This Agent release cannot enforce connector privacy requirements. Update Hermes Agent before continuing, compressing or refining this chat.", condition="agent_incompatible")


def _max_iterations_summary_request() -> str:
    """The user row the Agent appends to ask for a summary once its tool budget runs out; the server drops it."""
    try:
        from agent.context_compressor import MAX_ITERATIONS_SUMMARY_REQUEST
    except Exception:  # noqa: BLE001
        return ""
    return str(MAX_ITERATIONS_SUMMARY_REQUEST)


def _has_voice_turn_route() -> bool:
    """Whether the Agent routes a marked turn to ``auxiliary.voice_chat`` (``agent.voice_turn_route``, v0.21.6)."""
    try:
        return importlib.util.find_spec("agent.voice_turn_route") is not None
    except (ImportError, ValueError):
        return False


def _supported(cls, name: str) -> bool:
    """Whether ``cls.__init__`` accepts ``name`` (named, or through ``**kwargs``)."""
    try:
        parameters = inspect.signature(cls.__init__).parameters
    except (TypeError, ValueError):
        return False
    return name in parameters or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values())


@lru_cache(maxsize=32)
def _run_conversation_parameters(cls) -> frozenset[str]:
    """Probe explicit turn capabilities once per Agent class; unknown signatures keep legacy arguments."""
    try:
        return frozenset(inspect.signature(cls.run_conversation).parameters)
    except (TypeError, ValueError):
        return frozenset()


def _approval_notifier(session_id: str, emit):
    """The Agent's gateway notify callback for one turn: emits each parked approval, then ``approval_resolved``
    (id plus the Agent's reason) once its wait ends by any path, an ``approvals.timeout`` expiry included (TAL-514)."""
    try:
        from tools.approval import register_gateway_settle
    except Exception:  # noqa: BLE001
        register_gateway_settle = None

    def notify(data):
        payload = dict(data or {})
        payload.setdefault("session_id", session_id)
        payload.setdefault("approval_id", str(payload.get("request_id") or uuid.uuid4().hex))
        emit("approval", payload)
        request_id = str(payload.get("request_id") or "")
        if register_gateway_settle is None or not request_id:
            return
        approval_id = payload["approval_id"]

        def settle(reason):
            emit("approval_resolved", {"approval_id": approval_id, "session_id": session_id, "reason": str(reason or "")})

        # False: the wait already ended between the emit and this registration.
        if not register_gateway_settle(session_id, request_id, settle):
            settle("resolved")

    return notify


#: The Agent's compression-start lifecycle lines: "Compacting context" (and its heartbeat), pre-API, 413, and too-large
#: compression. Preflight and idle notices are left out: "Compacting context" follows them once compression proceeds.
_COMPRESSION_START_MARKERS = ("compacting context", "pre-api compression:", "context too large", "— compressing (", "- compressing (", "compression attempt")
_COMPRESSION_NOT_STARTED = ("skipping", "defer", "cooldown", "will not start")


def _is_compression_start(lower: str) -> bool:
    """Predecessor ``_is_agent_compression_start_status``: only real start notices, never skips or post-compress chatter."""
    if any(marker in lower for marker in _COMPRESSION_NOT_STARTED):
        return False
    if "compressed" in lower and "compressing" not in lower and "compression attempt" not in lower:
        return False
    return any(marker in lower for marker in _COMPRESSION_START_MARKERS)


def _status_events(kind, text: str) -> list[str]:
    """Events for one Agent status line: compression, provider diagnostics, and the turn's terminal error."""
    lower = text.lower()
    events = ["terminal_error"] if "non-retryable error" in lower else []
    kind = str(kind or "").strip().lower()
    # TAL-1006: the Agent's one terminal edge of a started compaction (``_emit_compaction_done``); an aborted attempt
    # sends none and ends with the turn.
    if kind == "compacted":
        return ["compression_finished"]
    if kind == "lifecycle":
        if _is_compression_start(lower):
            return events + ["compressing"]
        # The Agent's own compression retries ("Compressed N → M messages, retrying...") are not provider fallbacks.
        if "compress" in lower or "context reduced to" in lower:
            return events
        # Buffered diagnostics change wording across Agent releases; their severity glyph stays stable.
        if not events and text.startswith(("⚠", "❌")):
            return ["warning"]
    if "fallback" in lower or "rate limit" in lower or ("retry" in lower and "non-retryable" not in lower):
        events.append("warning")
    return events


#: TAL-821: the Agent's live status line during a rate-limit backoff (``turn_recovery.compute_error_backoff``), e.g.
#: "⏳ the free model is busy — resets in ~17m, retrying in 600s (attempt 1/3)". The Agent's other waits are not known
#: rate limits: "waiting on provider" covers a 5xx retry as well as a 429 without a reset, and "provider overloaded" is a
#: Z.AI overload. ``webui`` is not an attended source, so the Agent sits out a free-tier cooldown instead of ending.
_RATE_LIMIT_WAIT_RE = re.compile(r"^⏳ (?:rate limited|the free model is busy) —.* retrying in (\d+)s\b", re.IGNORECASE)
#: The line's reset window, in the Agent's ``format_duration_compact`` units ("45s", "17m", "1h 5m", "1.5d").
_RESET_IN_RE = re.compile(r"resets in ~((?:\d+(?:\.\d+)?[dhms] ?)+)")
_DURATION_UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}


def _rate_limit_wait(text: str) -> tuple[float, str] | None:
    """``(seconds, "reset")`` until the provider's limit resets, else ``(seconds, "retry")`` until the Agent retries, for a
    rate-limit wait line; None for any other line. The reset is the provider's own ``reset_at`` as the Agent read it from
    the error; the credential pool's exhausted mark is no better, since without that field it is a fixed one-hour guess."""
    wait = _RATE_LIMIT_WAIT_RE.match(text)
    if not wait:
        return None
    reset = _RESET_IN_RE.search(text)
    if not reset:
        return float(wait.group(1)), "retry"
    return sum(float(amount) * _DURATION_UNITS[unit] for amount, unit in re.findall(r"(\d+(?:\.\d+)?)([dhms])", reset.group(1))), "reset"


def start(ctx: CallContext, params: dict) -> dict:  # noqa: PLR0915 - one turn, one function
    session_id = str(params.get("session_id") or "").strip()
    stream_id = str(params.get("stream_id") or "").strip()
    if not session_id or not stream_id:
        raise InvalidParams("session_id and stream_id are required")
    user_message = params.get("user_message")
    if not (isinstance(user_message, str) and user_message.strip()) and not (isinstance(user_message, list) and user_message):
        raise InvalidParams("user_message is required")
    model = str(params.get("model") or "").strip()
    provider = str(params.get("model_provider") or "").strip() or None
    history = params.get("conversation_history")
    if history is None:
        history = []
    if not isinstance(history, list):
        raise InvalidParams("conversation_history must be a list")
    _require_data_use_support(history)
    toolsets = _turn_toolsets(params.get("enabled_toolsets"))
    system_message = params.get("system_message")
    home = profile_home_param(params)
    run = _Run(stream_id, session_id, ctx)
    run.home = home
    with _RUNS_LOCK:
        if _DRAINING.is_set():
            raise RpcError("The sidecar is shutting down.", condition="sidecar_unavailable")
        prior = _RUNS.get(_RUNS_BY_SESSION.get(session_id) or "")
        # A previous turn for this session that never returned (a tool ignoring its interrupt) still owns the cached
        # agent; this turn must not share, rebind, or un-interrupt that live instance.
        session_busy = prior is not None and not prior.finished.is_set()
        # TAL-829: a second agent beside a turn nobody stopped would wait on that turn's durable turn lease (up to 30
        # minutes) and then write the same session. A stopped turn only lingers until the Agent abandons the wedged
        # tool, which lets its lease go within seconds.
        if session_busy and not (prior.cancel.is_set() or prior.ctx.cancelled):
            raise RpcError("This chat is still answering the previous message. Stop it or wait for it to finish.", condition="session_busy")
        _RUNS[stream_id] = run
        _RUNS_BY_SESSION[session_id] = stream_id
    raw_emit = ctx.emit
    steer_state = {"last": None}
    usage_state = {"last": None}
    pending_mcp = False

    def emit(event, data=None):
        """Predecessor ``_webui_steer_events_before``: before content frames, report the Agent's pending steer text
        whenever it changed so the server can mark consumed steers live rather than only after ``done``. TAL-397: the
        Agent's session counters ride the same boundary, so the server meters cost and tokens while the turn runs."""
        if event in ("token", "reasoning", "interim_assistant", "tool", "tool_complete") and run.agent is not None:
            pending = _agent_pending_steer_text(run.agent)
            if pending != steer_state["last"]:
                steer_state["last"] = pending
                raw_emit("steer_pending", {"text": pending})
            usage = _usage(run.agent)
            if usage != usage_state["last"]:
                usage_state["last"] = usage
                raw_emit("usage", usage)
        raw_emit(event, data)
    timing = getattr(ctx, "timing", None)
    try:
        if timing:
            timing.begin("mcp_discovery")
        mcp_discovery = _discover_mcp_tools(run)
        pending_mcp = mcp_discovery is not None
        if timing:
            timing.end("mcp_discovery", "cancelled" if ctx.cancelled or run.cancel.is_set() else "timeout" if pending_mcp else run.mcp_discovery_outcome)
        with timing.span("runtime_resolution") if timing else contextlib.nullcontext():
            runtime = _resolve_runtime(provider, model)
        if timing:
            timing.begin("agent_binding")
        resolved_model = model or str(runtime.get("model") or "")
        resolved_provider = provider or runtime.get("provider")
        AIAgent = _agent_class()
        live_tool_calls: list[dict] = []
        started_ids: set[str] = set()
        completed_ids: set[str] = set()
        edit_snapshots: dict[str, Any] = {}
        prepared_metadata: dict[str, dict] = {}
        token_sent = [False]

        def on_token(text):
            if text is None:
                return
            token_sent[0] = True
            emit("token", {"text": str(text)})

        def on_reasoning(text):
            if text is None:
                return
            emit("reasoning", {"text": str(text)})

        def on_interim(text, **kw):
            visible = str(text or "").strip()
            if not visible:
                return
            emit("interim_assistant", {"text": visible, "already_streamed": bool(kw.get("already_streamed", False))})

        def on_tool_start(tool_call_id, name, args):
            tid = str(tool_call_id or "")
            if tid and tid in started_ids:
                return
            if tid:
                started_ids.add(tid)
                snapshot = _edit_snapshot(name, args, session_id)
                if snapshot is not None:
                    edit_snapshots[tid] = snapshot
            live_tool_calls.append({"name": name, "args": args if isinstance(args, dict) else {}, "tid": tid, "done": False})
            emit("tool", {"event_type": "tool.started", "name": name, "preview": None, "args": _args_snapshot(args), "tid": tid})

        def on_tool_complete(tool_call_id, name, args, function_result):
            tid = str(tool_call_id or "")
            if tid and tid in completed_ids:
                return
            if tid:
                completed_ids.add(tid)
            snippet = _snippet(function_result)
            for call in reversed(live_tool_calls):
                if call.get("done"):
                    continue
                if call.get("tid") == tid or (not call.get("tid") and call.get("name") == name):
                    call["done"] = True
                    call["snippet"] = snippet
                    break
            payload = {"event_type": "tool.completed", "name": name, "preview": snippet, "args": _args_snapshot(args), "tid": tid, "raw_result": _raw_result(function_result)}
            # TAL-909: the metadata the Agent persisted on the result row, or, from an Agent without the callback, live only.
            metadata = prepared_metadata.pop(tid) if tid in prepared_metadata else _edit_metadata(name, args, function_result, edit_snapshots.pop(tid, None))
            if metadata:
                payload["display_metadata"] = metadata
            # TAL-397: ``raw_result`` caps nested values, so the todo tool's list travels whole for the server's ``todo_state``.
            if function_result is not None and _is_todo_tool(name):
                payload["todo_result"] = function_result if isinstance(function_result, str) else json.dumps(function_result, default=str)
            # TAL-448: likewise a result's unified ``diff``, so the server's ``edit_diff`` counts cover the whole change.
            diff = _result_diff(function_result)
            if diff is not None:
                payload["result_diff"] = diff
            cost = _delegation_cost_usd(name, function_result)
            if cost is not None:
                payload["cost_usd"] = cost
                for call in reversed(live_tool_calls):
                    if call.get("tid") == tid:
                        call["cost_usd"] = cost
                        break
            emit("tool_complete", payload)

        def on_tool_result_metadata(tool_call_id, name, args, function_result):
            """TAL-909: called before the Agent appends and flushes the tool-result row, which keeps the returned dict as
            its ``display_metadata``; the completion frame that follows carries the same dict."""
            tid = str(tool_call_id or "")
            metadata = _edit_metadata(name, args, function_result, edit_snapshots.pop(tid, None))
            prepared_metadata[tid] = metadata
            return metadata

        def on_tool(*cb_args, **cb_kwargs):
            # Structured callbacks carry tool cards; the Agent already throttles MCP progress.
            if len(cb_args) >= 3 and cb_args[0] == "tool.progress":
                emit("tool_progress", {"tool_call_id": str(cb_kwargs.get("tool_call_id") or ""), "message": cb_args[2],
                                       "progress": cb_kwargs.get("progress"), "total": cb_kwargs.get("total"),
                                       "percent": cb_kwargs.get("percent")})
                return
            if len(cb_args) >= 3 and cb_args[0] in ("reasoning.available", "_thinking"):
                text = cb_args[2] if cb_args[0] == "reasoning.available" else cb_args[1]
                if text:
                    emit("reasoning", {"text": str(text)})

        def on_status(kind, message):
            text = str(message or "").strip()
            for event in _status_events(kind, text):
                if event == "compressing":
                    emit("compressing", {"session_id": session_id, "message": "Compressing context"})
                elif event == "compression_finished":
                    emit("compression_finished", {"session_id": session_id})
                elif event == "warning":
                    emit("warning", {"type": "fallback", "message": text})
                else:
                    emit("status", {"kind": "terminal_error", "message": text})

        wait_state = {"active": False, "prompt": False}

        def on_thinking(text):
            """Normalize provider waits and prompt-reading progress from the Agent's live status callback."""
            line = str(text or "").strip()
            progress = re.fullmatch(r"⚙ processing prompt(?: — (\d+(?:\.\d+)?)%)?", line)
            if progress:
                wait_state["prompt"] = True
                emit("provider_phase", {"phase": {"phase": "prompt_reading", "progress_percent": min(100, float(progress[1])) if progress[1] else None}})
            elif wait_state["prompt"]:
                wait_state["prompt"] = False
                emit("provider_phase", {"phase": None})
            wait = _rate_limit_wait(line)
            if wait is not None:
                wait_state["active"] = True
                emit("rate_limit_wait", {"provider": str(getattr(run.agent, "provider", None) or resolved_provider or "") or None,
                                         "until": time.time() + wait[0], "until_kind": wait[1]})
            elif wait_state["active"]:
                wait_state["active"] = False
                emit("rate_limit_wait", {"provider": None, "until": None})

        # TAL-803: the Agent's sticky ``AgentNotice``s (a startup warning such as a memory provider that failed to load,
        # credit and usage bands) and their clears; the server keeps the session's active set.
        def on_notice(notice):
            text = str(getattr(notice, "text", "") or "").strip()
            if not text:
                return
            ttl_ms = getattr(notice, "ttl_ms", None)
            key = getattr(notice, "key", None)
            # The Agent raises a startup warning (memory provider unavailable) once per process, so a rebuilt agent never
            # repeats it: it outlives the agent that raised it. Credit notices are per agent and re-raised by the next one.
            emit("notice", {"id": getattr(notice, "id", None), "key": key, "level": str(getattr(notice, "level", "") or "info"),
                            "kind": str(getattr(notice, "kind", "") or "sticky"), "ttl_ms": ttl_ms if isinstance(ttl_ms, int) else None, "text": text,
                            "lapses_with_agent": not str(key or "").startswith("startup-warning.")})

        def on_notice_clear(key):
            if key:
                emit("notice_clear", {"key": str(key)})

        def ask(data: dict, timeout: int) -> str | None:
            """Park on a prompt the server relays until it is answered, the turn is cancelled or ends, or ``timeout``
            passes (``<= 0``: no limit). The answer, or None, goes back to the Agent and is never emitted."""
            entry = _ClarifyEntry(data)
            entry.data["clarify_id"] = entry.clarify_id
            entry.deadline = None if timeout <= 0 else time.monotonic() + float(timeout)
            with run.lock:
                run.clarify_entries[entry.clarify_id] = entry
            emit("clarify", dict(entry.data))
            while not entry.event.is_set():
                if run.cancel.is_set() or run.finished.is_set() or (data.get("kind") == "skill_secret" and (ctx.cancelled or run.session_ended)):
                    break
                if entry.deadline is None:
                    entry.event.wait(1.0)
                    continue
                remaining = entry.deadline - time.monotonic()
                if remaining <= 0:
                    break
                entry.event.wait(min(1.0, remaining))
            with run.lock:
                run.clarify_entries.pop(entry.clarify_id, None)
            emit("clarify_resolved", {"clarify_id": entry.clarify_id, "session_id": session_id})
            return entry.result

        def ask_vault(kind: str, fields: dict) -> str:
            """TAL-887: a password-manager prompt; an empty answer is the Agent's decline, as are expiry and cancel."""
            timeout = _VAULT_PROMPT_TIMEOUTS[kind]
            data = {"kind": kind, "session_id": session_id, "requested_at": time.time(), "timeout_seconds": timeout, **fields}
            return ask(data, timeout) or ""

        def vault_unlock_prompt(backend, display_name):
            # The Agent stores the unlock right after this returns, on the thread that called it: a tool worker
            # inherits this callback but not the turn's session, so bind it here too, or closing the session could
            # not lock the manager again.
            _set_vault_session(session_id)
            return ask_vault("vault_unlock", {"backend": str(backend), "display_name": str(display_name)})

        def vault_save_login_prompt(origin, site):
            # The server sends ``{"identifier", "password"}``; the Agent stores it in its vault and fills the page.
            raw = ask_vault("vault_save_login", {"origin": str(origin), "site": str(site)})
            try:
                answer = json.loads(raw) if raw else None
            except ValueError:
                return None
            return answer if isinstance(answer, dict) and answer.get("password") else None

        def vault_code_prompt(site, hint):
            return ask_vault("vault_code", {"site": str(site), "hint": str(hint or "")})

        def skill_secret_prompt(env_var, prompt, metadata=None):
            skipped = {"success": True, "stored_as": env_var, "validated": False, "skipped": True}
            if not isinstance(env_var, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", env_var):
                return skipped
            metadata = metadata if isinstance(metadata, dict) else {}
            fields = {"env_var": env_var, "prompt": str(prompt), **{key: str(metadata.get(key) or "") for key in ("skill_name", "help", "required_for")}}
            value = ask_vault("skill_secret", fields)
            if not value.strip():
                return skipped
            # The native writer strips these bytes, and reports non-ASCII characters to stderr. Refuse rather
            # than change the credential or expose any of its characters in logs.
            if not value.isascii() or any(char in value for char in ("\r", "\n", "\0")):
                return {**skipped, "success": False}
            try:
                from hermes_cli.config import save_env_value_secure
                from hermes_constants import get_hermes_home

                # Keep the inherited secret scope so setup can use the value immediately. Fence the write against
                # eviction/replacement under the same lock that changes the run's identity and session lifetime.
                with _RUNS_LOCK:
                    if (ctx.cancelled or run.cancel.is_set() or run.finished.is_set() or run.session_ended
                            or _RUNS_BY_SESSION.get(session_id) != stream_id or _RUNS.get(stream_id) is not run
                            or get_hermes_home() != home):
                        return skipped
                    saved = save_env_value_secure(env_var, value)
                return {"success": saved.get("success") is True, "stored_as": env_var, "validated": saved.get("validated") is True, "skipped": False}
            except Exception:  # noqa: BLE001 - never expose an exception that could include the submitted value
                return {**skipped, "success": False}

        def clarify_callback(question, choices=None, multi_select=False, questions=None):
            # TAL-351: remove the legacy signature path when v0.21.6 is the oldest supported Agent.
            structured = isinstance(question, list)
            if structured:
                questions, question = question, ""
            choices_list = [str(c) for c in (choices or [])]
            # Predecessor `_clarify_timeout_seconds`: the Agent's own resolver over this profile's config
            # (``clarify.timeout`` else ``agent.clarify_timeout`` else 3600); ``<= 0`` waits until answered or cancelled.
            # The advertised ``timeout_seconds`` is what the clients count down, so it is the same number.
            timeout = _clarify_timeout(params)
            data = {"question": str(question or ""), "choices_offered": choices_list, "session_id": session_id, "kind": "clarify", "requested_at": time.time(), "timeout_seconds": timeout}
            if multi_select:
                data["multi_select"] = True
            # Batch prompts (the Agent's ``_run_batch``) carry no top-level question and expect the ``{"answers": {...}}`` reply.
            if isinstance(questions, list) and questions:
                data["questions"] = questions
            answer = ask(data, timeout)
            if answer is not None:
                if structured:
                    return {"answers": json.loads(answer)["answers"], "outcome": "submitted"}
                return answer
            cancelled = run.cancel.is_set() or run.finished.is_set()
            if structured:
                return {"answers": {}, "outcome": "cancelled" if cancelled else "timed_out",
                        "notice": "The user cancelled the clarification." if cancelled else "The clarification timed out."}
            # Older tools have no outcome field. A batch understands timed_out; a single needs an empty answer.
            if questions:
                return json.dumps({"answers": {}, "timed_out": not cancelled})
            return ""

        # TAL-818: a ``manage_connections`` card (a hosted connect, an MCP install) opened; the server turns the frame into
        # the chat's connect card, which reads and answers the operation through ``connectors.operation`` / ``respond``.
        # Only a client that draws the card asks for it: without the callback the Agent answers with plain links at once.
        connect_card = params.get("connect_card") is True

        def on_connection(payload):
            from .connectors import remember_chat_operation

            view = remember_chat_operation(home, payload)
            if view is not None:
                emit("connection", view)
            return None

        # Approval bridge: the Agent parks dangerous commands in its gateway queue and calls back here.
        try:
            from tools.approval import register_gateway_notify, unregister_gateway_notify
        except Exception:  # noqa: BLE001
            register_gateway_notify = unregister_gateway_notify = None
        approval_cb = _approval_notifier(session_id, emit) if register_gateway_notify is not None else None

        kwargs = _agent_kwargs(AIAgent, params, session_id, resolved_model, resolved_provider, runtime, toolsets)
        kwargs.update(stream_delta_callback=on_token, reasoning_callback=on_reasoning, tool_progress_callback=on_tool, clarify_callback=clarify_callback)
        for name, value in (
            ("interim_assistant_callback", on_interim),
            ("tool_start_callback", on_tool_start),
            ("tool_complete_callback", on_tool_complete),
            ("tool_result_metadata_callback", on_tool_result_metadata),
            ("status_callback", on_status),
            ("thinking_callback", on_thinking),
            ("notice_callback", on_notice),
            ("notice_clear_callback", on_notice_clear),
            ("connection_callback", on_connection if connect_card else None),
        ):
            if _supported(AIAgent, name) and value is not None:
                kwargs[name] = value
        signature = _agent_signature(resolved_model, resolved_provider, runtime, toolsets, str(params.get("profile_home")), kwargs)
        agent = None

        def bind(bound) -> None:
            """Claim the agent for this run under ``_AGENT_CACHE_LOCK``, so an eviction never releases it mid-turn."""
            run.prior_messages = getattr(bound, "_session_messages", None)
            run.agent = bound
            if run.session_ended:
                bound.skip_background_review = True

        if not session_busy:
            with _AGENT_CACHE_LOCK:
                cached = _AGENT_CACHE.get(session_id)
                if cached and cached[1] == signature:
                    agent = cached[0]
                    _AGENT_CACHE.move_to_end(session_id)
                    bind(agent)
        cached_agent = agent is not None
        if agent is not None:
            for name in ("stream_delta_callback", "reasoning_callback", "tool_progress_callback", "clarify_callback", "interim_assistant_callback", "tool_start_callback", "tool_complete_callback", "tool_result_metadata_callback", "status_callback", "thinking_callback", "notice_callback", "notice_clear_callback"):
                if name in kwargs and hasattr(agent, name):
                    setattr(agent, name, kwargs[name])
            # A cached agent keeps the last turn's card callback; this turn's client decides afresh (TAL-818).
            if hasattr(agent, "connection_callback"):
                agent.connection_callback = on_connection if connect_card else None
            # TAL-902: an agent ``/refine`` built runs its first turn here. Like a new one, it lapses the notices of the
            # agent it replaced and raises the startup notices it parked while it had no callback.
            if vars(agent).pop("_talaria_unannounced", False):
                emit("notices_reset", {})
                replay = getattr(agent, "_replay_startup_warnings", None)
                if callable(replay):
                    replay()
        else:
            # TAL-803: the notices a replaced agent raised lapse with it (``lapses_with_agent``); this one raises its own.
            emit("notices_reset", {})
            # A ``/btw`` side question's throwaway session stays out of state.db.
            agent = _build_agent(AIAgent, kwargs, home, session_id, state_db=not params.get("ephemeral"))
            with _AGENT_CACHE_LOCK:
                bind(agent)
                if not run.session_ended:
                    replaced = _AGENT_CACHE.pop(session_id, None)
                    _AGENT_CACHE[session_id] = (agent, signature, home)
                    _release_agents_locked([replaced] if replaced else [])
                    _evict_idle_agents_locked()
        if timing:
            timing.end("agent_binding", "cache_hit" if cached_agent else "ok")
            timing.begin("conversation_setup")
        # Predecessor ``agent.ephemeral_system_prompt``: personality, surface context, progress guidance, and delivery
        # hints travel as runtime instructions that are never persisted to history.
        ephemeral = params.get("ephemeral_system_prompt")
        if isinstance(ephemeral, str) and ephemeral.strip():
            try:
                agent.ephemeral_system_prompt = ephemeral
            except Exception:  # noqa: BLE001 - read-only stand-ins
                pass
        if approval_cb is not None:
            with _APPROVAL_CB_LOCK:
                register_gateway_notify(session_id, approval_cb)
                _APPROVAL_CB_OWNER[session_id] = stream_id
        usage_state["last"] = _usage(agent)
        compressions_before = int(getattr(getattr(agent, "context_compressor", None), "compression_count", 0) or 0)

        # A cached agent may still carry the interrupt a previous cancel left behind; the Agent keeps a pending
        # interrupt across turn start, so it would abort this turn immediately.
        clear_interrupt = getattr(agent, "clear_interrupt", None)
        if callable(clear_interrupt):
            try:
                clear_interrupt()
            except Exception:  # noqa: BLE001
                log.debug("agent.clear_interrupt failed", exc_info=True)

        def _watch_cancel():
            nonlocal pending_mcp
            while not run.cancel.wait(0.25):
                if pending_mcp and mcp_discovery.is_set():
                    # Discovery can finish while this agent is being built, after the worker's cache refresh.
                    try:
                        with scoped_home(home):
                            refresh_profile_agents_mcp_tools(home)
                    except Exception:  # noqa: BLE001 - refresh failure must not disable Stop
                        log.warning("Late MCP refresh failed", exc_info=True)
                    with run.lock:
                        if pending_mcp:
                            emit("notice_clear", {"key": _MCP_PENDING_KEY})
                            pending_mcp = False
                if run.finished.is_set():
                    return
                if ctx.cancelled:
                    run.cancel.set()
                    break
            if run.finished.is_set() and not run.cancel.is_set():
                return
            try:
                agent.interrupt("Cancelled by user", hard_cancel=True)
            except TypeError:
                agent.interrupt("Cancelled by user")
            except Exception:  # noqa: BLE001
                log.debug("agent.interrupt failed", exc_info=True)
            with run.lock:
                for entry in list(run.clarify_entries.values()):
                    entry.event.set()

        watcher = threading.Thread(target=_watch_cancel, daemon=True, name=f"chat-cancel-{stream_id[:8]}")
        watcher.start()
        run_kwargs: dict = {"user_message": user_message, "conversation_history": history, "task_id": session_id}
        run_params = _run_conversation_parameters(type(agent))
        if system_message and ("system_message" in run_params or not run_params):
            run_kwargs["system_message"] = system_message
        # Talaria generates and syncs the title; suppress the Agent's duplicate auxiliary request.
        if "title_user_message" in run_params:
            run_kwargs["title_user_message"] = ""
        # The server's clean user text (no workspace prefix) is what state.db stores; the Agent keeps the sent bytes beside it.
        persist = params.get("persist_user_message")
        if not (isinstance(persist, str) and persist.strip()):
            persist = user_message if isinstance(user_message, str) else None
        if "persist_user_message" in run_params and persist is not None:
            run_kwargs["persist_user_message"] = persist
        # TAL-801: a spoken turn runs on the profile's ``auxiliary.voice_chat`` slot; the Agent consumes the mark at turn
        # setup. Every turn sets it, as the Agent's own surfaces do, so a mark a failed turn never consumed cannot leak.
        if _has_voice_turn_route():
            agent._voice_turn_pending = params.get("voice_turn") is True
        error: str | None = None
        result: dict = {}
        # The Agent reads its vault prompts from the thread running the turn (and copies them onto tool workers).
        _set_vault_prompts(session_id, vault_unlock_prompt, vault_save_login_prompt, vault_code_prompt)
        try:
            try:
                from tools.skills_tool import bind_turn_secret_capture
            except ImportError:  # Older Agents and v0.22.2 have only an unsafe process-global callback slot.
                bind_turn_secret_capture = None
                log.debug("Agent lacks turn-local skill secret capture; secure setup is unavailable")
            with bind_turn_secret_capture(skill_secret_prompt) if bind_turn_secret_capture and params.get("skill_secret") is True else contextlib.nullcontext():
                if timing:
                    timing.end("conversation_setup")
                    timing.observe("conversation_entry")
                    timing.emit("conversation_entry")
                raw = agent.run_conversation(**run_kwargs)
            result = raw if isinstance(raw, dict) else {}
        except Exception as exc:  # noqa: BLE001
            log.warning("agent turn failed for %s: %s", session_id, exc)
            error = f"{type(exc).__name__}: {exc}"
        finally:
            _set_vault_prompts(None, None, None, None)
            run.finished.set()
            watcher.join(timeout=2)
            # A successor turn for the same session (admitted past the cancel-unwind ceiling) may have registered
            # its own callback meanwhile: compare-and-unregister under the same lock registration takes.
            if unregister_gateway_notify is not None:
                with _APPROVAL_CB_LOCK:
                    if _APPROVAL_CB_OWNER.get(session_id) == stream_id:
                        _APPROVAL_CB_OWNER.pop(session_id, None)
                        try:
                            unregister_gateway_notify(session_id)
                        except Exception:  # noqa: BLE001
                            pass
        cancelled = ctx.cancelled or run.cancel.is_set() or (bool(getattr(agent, "_interrupt_requested", False)) and error is None and not result.get("final_response"))
        compressions_after = int(getattr(getattr(agent, "context_compressor", None), "compression_count", 0) or 0)
        last_error = getattr(agent, "_last_error", None)
        if not error and last_error:
            error = str(last_error)
        if not error and isinstance(result.get("error"), str) and result.get("error"):
            error = str(result["error"])
        # The Agent ends a failed turn with ``failed``/``partial`` (never ``status``), often after text streamed and with
        # the turn's messages; a failed turn is an error whatever it carries.
        failed = bool(result.get("failed"))
        partial = bool(result.get("partial"))
        if not error and failed and result.get("final_response"):
            error = str(result["final_response"])
        status = "cancelled" if cancelled else ("error" if failed or (error and not result.get("messages")) else "completed")
        pending_steer = str(result.get("pending_steer") or "") if isinstance(result, dict) else ""
        messages = [m for m in (result.get("messages") or []) if isinstance(m, dict)]
        compressed = compressions_after > compressions_before
        context_messages, context_estimate = _post_compression_context(agent, messages, system_message) if compressed and messages and status == "completed" else (None, None)
        return {
            "status": status,
            "messages": messages,
            "context_messages": context_messages,
            "post_compression_context_tokens_estimate": context_estimate,
            "final_response": str(result.get("final_response") or ""),
            "error": error,
            "failed": failed,
            "partial": partial,
            "compression_exhausted": bool(result.get("compression_exhausted")),
            # The pinned Agent marks an exhausted tool budget only in ``turn_exit_reason`` (``max_iterations_reached(n/n)``).
            "tool_limit_reached": bool(result.get("tool_limit_reached") or result.get("max_iterations_reached") or str(result.get("turn_exit_reason") or "").startswith("max_iterations_reached")),
            "max_iterations_summary_request": _max_iterations_summary_request(),
            "usage": _usage(agent),
            "context": _context_length(agent),
            # TAL-801: the Agent's result names the model the turn ran on; a voice turn's route is undone by now.
            "model": str(result.get("model") or getattr(agent, "model", None) or resolved_model),
            "provider": str(resolved_provider or ""),
            "compressed": compressed,
            "agent_session_id": str(getattr(agent, "session_id", None) or session_id),
            "token_sent": token_sent[0],
            "pending_steer": pending_steer,
            "live_tool_calls": live_tool_calls,
        }
    finally:
        with run.lock:
            if pending_mcp:
                emit("notice_clear", {"key": _MCP_PENDING_KEY})
                pending_mcp = False
        with _AGENT_CACHE_LOCK:
            with _RUNS_LOCK:
                _RUNS.pop(stream_id, None)
                if _RUNS_BY_SESSION.get(session_id) == stream_id:
                    _RUNS_BY_SESSION.pop(session_id, None)
                # TAL-887: a session ended mid-turn (``chat.evict_agent`` marks the run under these locks) released its
                # unlocks then; one the Agent stored after that is released now.
                if run.session_ended:
                    _release_vault_session(session_id)
            # An agent evicted or replaced while this turn held it is released now that the turn is over.
            _release_if_dropped_locked(run.agent, home)


def _checkpoint_required() -> bool:
    """``compression.checkpoint_required`` needs the memory provider loaded to write the pre-compression checkpoint."""
    try:
        from hermes_cli.config import load_config

        return ((load_config() or {}).get("compression") or {}).get("checkpoint_required") is True
    except Exception:  # noqa: BLE001
        return False


#: Compressed results awaiting the server's write: ``commit_token -> (agent, profile home, expiry timer)``.
_PENDING_COMPRESSIONS: dict[str, tuple[Any, Any, threading.Timer]] = {}
_PENDING_COMPRESSIONS_LOCK = threading.Lock()
#: A server that never answers (restart, crash) gets its compression discarded after this long.
_PENDING_COMPRESSION_TTL = 600.0


def _release_compression(agent, committed: bool) -> None:
    """Emit (committed) or discard the Agent's deferred context-engine notification, then close the throwaway agent."""
    from agent.conversation_compression import finalize_context_engine_compression_notification

    try:
        finalize_context_engine_compression_notification(agent, committed=committed)
    finally:
        with contextlib.suppress(Exception):
            agent._end_session_on_close = False
        close = getattr(agent, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001
                log.debug("compression agent close failed", exc_info=True)


def finalize_compression(token: str, committed: bool) -> bool:
    """``chat.compress_finalize``: the server reports whether it installed the result; unknown tokens are a no-op."""
    with _PENDING_COMPRESSIONS_LOCK:
        entry = _PENDING_COMPRESSIONS.pop(token, None)
    if entry is None:
        return False
    agent, home, expiry = entry
    expiry.cancel()  # a no-op when the timer itself is finalizing
    with scoped_home(home):
        _release_compression(agent, committed=committed)
    return True


def compress(ctx: CallContext, params: dict) -> dict:
    """Manual ``/compress`` of ``conversation_history`` through the Agent's shared core (``compress_now``) on a throwaway
    agent, like the gateway's ``_run_manual_compression``. The server owns the transcript: it re-checks the session and
    installs ``messages`` itself, so nothing here touches history or the cached turn agent. The agent has no session
    store, so the Agent neither rotates nor writes state.db; its one deferred effect, the context-engine notification,
    waits for ``chat.compress_finalize`` with the returned ``commit_token`` (two-phase, like the gateway's commit)."""
    home = profile_home_param(params)
    session_id = str(params.get("session_id") or "").strip()
    if not session_id:
        raise InvalidParams("session_id is required")
    history = params.get("conversation_history")
    if not isinstance(history, list):
        raise InvalidParams("conversation_history must be a list")
    _require_data_use_support(history)
    model = str(params.get("model") or "").strip()
    provider = str(params.get("model_provider") or "").strip() or None
    focus_topic = str(params.get("focus_topic") or "").strip()[:500] or None
    toolsets = _turn_toolsets(params.get("enabled_toolsets"))
    runtime = _resolve_runtime(provider, model)
    if not runtime.get("api_key"):
        raise RpcError("No provider configured -- cannot compress.", condition="credential_missing")
    from agent.conversation_compression_manual import CompressRequest, compress_now

    AIAgent = _agent_class()
    kwargs: dict = dict(
        model=model or str(runtime.get("model") or ""),
        provider=provider or runtime.get("provider"),
        base_url=runtime.get("base_url"),
        api_key=runtime.get("api_key"),
        platform="webui",
        quiet_mode=True,
        enabled_toolsets=toolsets,
        disabled_toolsets=disabled_toolsets(),
        session_id=session_id,
    )
    for name, value in (
        ("api_mode", runtime.get("api_mode")),
        ("acp_command", runtime.get("acp_command")),
        ("acp_args", runtime.get("acp_args")),
        ("credential_pool", runtime.get("credential_pool")),
        ("gateway_session_key", session_id),
        ("skip_memory", not _checkpoint_required()),
        ("request_overrides", _request_overrides(kwargs["model"], kwargs["provider"], runtime)),
        ("prefill_messages", _profile_prefill_messages()),
    ):
        if _supported(AIAgent, name) and value is not None:
            kwargs[name] = value
    agent = AIAgent(**kwargs)
    held = False
    try:
        result = compress_now(agent, history, CompressRequest(focus_topic=focus_topic), task_id=session_id)
        message = None
        if result.status != "compressed":
            from agent.conversation_compression_manual import render_compress_result

            message = "\n".join(render_compress_result(result)) or None
        payload = {
            "status": result.status,
            "messages": json.loads(json.dumps([m for m in result.after_messages if isinstance(m, dict)], default=str)),
            "before_tokens": int(result.before_tokens or 0),
            "after_tokens": int(result.after_tokens or 0),
            "summary": json.loads(json.dumps(result.summary, default=str)) if isinstance(result.summary, dict) else None,
            "message": message,
            "agent_session_id": str(getattr(agent, "session_id", None) or session_id),
            "commit_token": None,
        }
        if result.status == "compressed":
            token = uuid.uuid4().hex
            # A server that never answers (restart, failed RPC) gets the compression discarded on its own.
            expiry = threading.Timer(_PENDING_COMPRESSION_TTL, finalize_compression, args=(token, False))
            expiry.daemon = True
            with _PENDING_COMPRESSIONS_LOCK:
                _PENDING_COMPRESSIONS[token] = (agent, home, expiry)
            expiry.start()
            held = True
            payload["commit_token"] = token
        return payload
    finally:
        if not held:
            _release_compression(agent, committed=False)


_REFINE_BUSY = "Agent is running — wait for the turn to finish, then /refine."


def _session_running_locked(session_id: str) -> bool:
    """Whether a turn for ``session_id`` has not returned yet, or no turn can start (caller holds ``_RUNS_LOCK``)."""
    run = _RUNS.get(_RUNS_BY_SESSION.get(session_id) or "")
    return _DRAINING.is_set() or (run is not None and not run.finished.is_set())


def _refine_agent(params: dict, session_id: str, home):
    """The session's cached agent, else one built the way its turn builds it and cached for that turn, held in
    ``_COMMITTING`` until the caller lets go; None when a turn started meanwhile. Runs under the call's ``scoped_home``."""
    with _AGENT_CACHE_LOCK:
        with _RUNS_LOCK:
            # Checked again with the claim: a turn admitted since ``refine``'s check holds the cached agent.
            if _session_running_locked(session_id):
                return None
        cached = _AGENT_CACHE.get(session_id)
        if cached is not None:
            _COMMITTING.append((cached[0], home))
            return cached[0]
    model = str(params.get("model") or "").strip()
    provider = str(params.get("model_provider") or "").strip() or None
    toolsets = _turn_toolsets(params.get("enabled_toolsets"))
    # Like a turn: the profile's MCP servers connect before the agent snapshots its tools, which its next turn keeps.
    try:
        from .commands import discover_profile_mcp_tools

        discover_profile_mcp_tools()
    except Exception:  # noqa: BLE001
        log.warning("MCP discovery failed", exc_info=True)
    runtime = _resolve_runtime(provider, model)
    resolved_model = model or str(runtime.get("model") or "")
    resolved_provider = provider or runtime.get("provider")
    AIAgent = _agent_class()
    kwargs = _agent_kwargs(AIAgent, params, session_id, resolved_model, resolved_provider, runtime, toolsets)
    signature = _agent_signature(resolved_model, resolved_provider, runtime, toolsets, str(params.get("profile_home")), kwargs)
    built = _build_agent(AIAgent, kwargs, home, session_id)
    with _AGENT_CACHE_LOCK:
        with _RUNS_LOCK:
            running = _session_running_locked(session_id)
        cached = _AGENT_CACHE.get(session_id)
        agent = None if running else cached[0] if cached else built
        if agent is not None:
            _COMMITTING.append((agent, home))
        if agent is built:
            built._talaria_unannounced = True  # its first turn announces it (``start``)
            _AGENT_CACHE[session_id] = (built, signature, home)
            _evict_idle_agents_locked()
        else:
            _release_agents_locked([(built, None, home)])
    return agent


def refine(params: dict) -> str:
    """TAL-902: ``/refine [focus]`` like the Agent's live-session handler (``_format_live_refine_output``): the memory/skill
    review fork of ``messages`` (the server's model context for the session) on the session's agent, never while its turn
    runs. The fork carries this call's ``scoped_home``, so its memory and skill writes land in the session's profile."""
    session_id = str(params.get("session_id") or "").strip()
    messages = params.get("messages")
    if not session_id or not isinstance(messages, list):
        raise InvalidParams("session_id and messages are required")
    _require_data_use_support(messages)
    focus = str(params.get("focus") or "").strip()
    with _RUNS_LOCK:
        if _session_running_locked(session_id):
            return _REFINE_BUSY
    if not messages:
        return "Nothing to refine yet — the conversation is empty."
    home = profile_home_param(params)
    agent = _refine_agent(params, session_id, home)
    if agent is None:
        return _REFINE_BUSY
    try:
        agent._spawn_background_review(messages_snapshot=list(messages), review_memory=True,
                                       review_skills="skill_manage" in (getattr(agent, "valid_tool_names", None) or set()),
                                       focus=focus or None, explicit=True)
    except Exception as exc:  # noqa: BLE001 - the Agent's own wording for a fork that could not start
        log.warning("/refine failed to start for session %s", session_id, exc_info=True)
        return f"/refine failed to start: {exc}"
    finally:
        with _AGENT_CACHE_LOCK:
            _COMMITTING.remove((agent, home))
            _release_if_dropped_locked(agent, home)
    tail = f" (focus: {focus})" if focus else ""
    return f"⚗ Reviewing this conversation in the background{tail} — any memory/skill updates will be reported when done."


def _run_for(params: dict) -> _Run | None:
    stream_id = str(params.get("stream_id") or "").strip()
    session_id = str(params.get("session_id") or "").strip()
    with _RUNS_LOCK:
        if stream_id:
            return _RUNS.get(stream_id)
        if session_id:
            sid = _RUNS_BY_SESSION.get(session_id)
            return _RUNS.get(sid) if sid else None
    return None


def register(registry) -> None:
    @registry.method("chat.start")
    def start_(ctx: CallContext, params: dict) -> dict:
        session_id = str(params.get("session_id") or "").strip()
        workspace = params.get("workspace")
        if not isinstance(workspace, str) or not workspace.strip():
            raise InvalidParams("workspace is required")
        with agent_scope(profile_home_param(params)):
            with _turn_identity(session_id, workspace):
                return start(ctx, params)

    @registry.method("chat.compress")
    def compress_(ctx: CallContext, params: dict) -> dict:
        with agent_scope(profile_home_param(params)):
            return compress(ctx, params)

    @registry.method("chat.refine")
    def refine_(ctx: CallContext, params: dict) -> dict:
        with agent_scope(profile_home_param(params)):
            return {"output": refine(params)}

    @registry.method("chat.compress_finalize", requires_agent=False)
    def compress_finalize_(ctx: CallContext, params: dict) -> dict:
        token = str(params.get("commit_token") or "").strip()
        if not token:
            raise InvalidParams("commit_token is required")
        return {"finalized": finalize_compression(token, params.get("committed") is True)}

    @registry.method("chat.interrupt", requires_agent=False)
    def interrupt_(ctx: CallContext, params: dict) -> dict:
        run = _run_for(params)
        if run is None:
            return {"ok": False, "reason": "not_running"}
        # Before the interrupt, so the unwinding Agent cannot reshape the transcript first.
        checkpoint = _cancel_checkpoint(run)
        run.cancel.set()
        # Predecessor ``_finalize_webui_steers``: drain the Agent's not-yet-applied steer text so the server can
        # settle queued steers (consumed vs leftover) before it writes the terminal cancel row.
        pending = ""
        agent = run.agent
        if agent is not None:
            drain = getattr(agent, "_drain_pending_steer", None)
            try:
                pending = str(drain() or "") if callable(drain) else _agent_pending_steer_text(agent)
            except Exception:  # noqa: BLE001
                pending = _agent_pending_steer_text(agent)
        result = {"ok": True, "pending_steer": pending}
        if checkpoint is not None:
            result["checkpoint"] = checkpoint
        return result

    @registry.method("chat.steer", requires_agent=False)
    def steer_(ctx: CallContext, params: dict) -> dict:
        text = str(params.get("text") or "").strip()
        if not text:
            raise InvalidParams("text is required")
        run = _run_for(params)
        if run is None or run.agent is None:
            return {"accepted": False, "fallback": "not_running"}
        if not hasattr(run.agent, "steer"):
            return {"accepted": False, "fallback": "agent_lacks_steer"}
        try:
            accepted = bool(run.agent.steer(text))
        except Exception as exc:  # noqa: BLE001
            log.debug("steer failed: %s", exc)
            return {"accepted": False, "fallback": "steer_error"}
        # `can_redirect`: whether this Agent can deliver a pending steer now (TAL-424 "Send now").
        return {"accepted": accepted, "fallback": None if accepted else "not_running", "can_redirect": callable(getattr(run.agent, "redirect", None))}

    @registry.method("chat.steer_withdraw", requires_agent=False)
    def steer_withdraw_(ctx: CallContext, params: dict) -> dict:
        pending, index = _steer_queue_params(params)
        run = _run_for(params)
        if run is None or run.agent is None:
            return {"withdrawn": False}
        return {"withdrawn": withdraw_steer(run.agent, pending, index)}

    @registry.method("chat.steer_now", requires_agent=False)
    def steer_now_(ctx: CallContext, params: dict) -> dict:
        pending, index = _steer_queue_params(params)
        run = _run_for(params)
        if run is None or run.agent is None:
            return {"redirected": False, "withdrawn": False, "reason": "not_running"}
        return steer_now(run.agent, pending, index)

    @registry.method("chat.finalize_session", requires_agent=False)
    def finalize_(ctx: CallContext, params: dict) -> dict:
        session_id = str(params.get("session_id") or "").strip()
        reason = params.get("reason")
        if not session_id or reason not in ("clear", "delete", "archive"):
            raise InvalidParams("session_id and reason (clear/delete/archive) are required")
        lineage = params.get("lineage")
        if lineage is not None and (not isinstance(lineage, list) or len(lineage) > 10_000
                                    or any(not isinstance(sid, str) or not sid for sid in lineage)):
            raise InvalidParams("lineage must contain session ids")
        home = profile_home_param(params)
        messages: list[str] = []

        def finalize() -> None:
            try:
                # Scope inside the worker: a timed-out plugin keeps its own profile until it finishes.
                with agent_scope(home):
                    if reason == "archive":
                        _notify_archive(home, session_id, lineage)
                        return
                    from hermes_cli import lifecycle

                    callback = getattr(lifecycle, "finalize_session", None)
                    if callback is None:
                        return
                    results = callback(session_id=session_id, platform="webui", reason=reason)
                    extract = getattr(lifecycle, "session_end_messages", None)
                    if extract is not None:
                        messages.extend(extract(results))
            except Exception:  # noqa: BLE001 - hooks must never block the boundary
                log.warning("Session lifecycle callback failed (%s)", reason)
            finally:
                with _RELEASES_LOCK:
                    _RELEASES.pop(worker, None)

        worker = threading.Thread(target=finalize, name="session-finalize", daemon=True)
        worker.failed = False  # type: ignore[attr-defined] - hook failures do not prevent profile deletion
        with _RELEASES_LOCK:
            _RELEASES[worker] = home
        worker.start()
        worker.join(_SESSION_FINALIZE_TIMEOUT)
        if worker.is_alive():
            log.warning("Session lifecycle callback exceeded deadline (%s)", reason)
            return {"messages": []}
        return {"messages": messages}

    @registry.method("chat.evict_agent", requires_agent=False)
    def evict_(ctx: CallContext, params: dict) -> dict:
        """Drop a session's cached agent. Only delete/clear (``clear_session``) end its approval grants, parked
        approvals, kernels and background review; a model switch, truncate or compress leaves a running turn's agent
        in place."""
        session_id = str(params.get("session_id") or "").strip()
        end_session = params.get("clear_session") is True
        with _AGENT_CACHE_LOCK:
            with _RUNS_LOCK:
                run = _RUNS.get(_RUNS_BY_SESSION.get(session_id) or "")
                if end_session and run is not None:
                    run.session_ended = True
            if not end_session and run is not None and not run.finished.is_set():
                return {"evicted": False}
            entry = _AGENT_CACHE.pop(session_id, None)
            _release_agents_locked([entry] if entry else [])
        if end_session:
            # The server does not wait for an eviction; the cancels finish on their own.
            _cancel_background_reviews(([(entry[0], entry[2])] if entry else []) + ([(run.agent, run.home)] if run else []), "session deleted or cleared")
            try:
                from tools.approval import clear_session
                clear_session(session_id)
            except Exception:  # noqa: BLE001
                pass
            # TAL-887: a password manager this session unlocked locks again with it; other sessions keep theirs.
            _release_vault_session(session_id)
        return {"evicted": entry is not None}

    @registry.method("chat.commit_memory", requires_agent=False)
    def commit_memory_(ctx: CallContext, params: dict) -> dict:
        """Predecessor ``commit_session_memory``: flush the cached Agent's memory for a session the user just left.
        Providers get the session's transcript and run under the ``scoped_home`` the Agent was built in, which v0.22.3
        binds them to (like ``_release_agent``), not the request's ``profile_home``."""
        session_id = str(params.get("session_id") or "").strip()
        with _AGENT_CACHE_LOCK:
            cached = _AGENT_CACHE.get(session_id)
            with _RUNS_LOCK:
                busy = _DRAINING.is_set() or (_RUNS_BY_SESSION.get(session_id) or "") in _RUNS
            agent = cached[0] if cached else None
            commit = getattr(agent, "commit_memory_session", None) if agent is not None else None
            if commit is None or busy:
                return {"committed": False}
            _COMMITTING.append((agent, cached[2]))
        try:
            with scoped_home(cached[2]):
                commit(list(getattr(agent, "_session_messages", None) or []))
        except Exception as exc:  # noqa: BLE001
            log.warning("commit_memory_session() failed for session %s: %s", session_id, exc)
            return {"committed": False}
        finally:
            with _AGENT_CACHE_LOCK:
                _COMMITTING.remove((agent, cached[2]))
                _release_if_dropped_locked(agent, cached[2])
        return {"committed": True}

    @registry.method("approval.respond", requires_agent=True)
    def approval_respond_(ctx: CallContext, params: dict) -> dict:
        session_id = str(params.get("session_id") or "").strip()
        choice = str(params.get("choice") or "deny").strip()
        request_id = str(params.get("request_id") or "").strip() or None
        if choice not in ("once", "session", "always", "deny"):
            raise InvalidParams(f"Invalid choice: {choice}")
        try:
            from tools import approval as approval_mod
        except Exception as exc:  # noqa: BLE001
            raise RpcError(f"approval module unavailable: {exc}", condition="agent_unavailable") from exc
        with scoped_home(profile_home_param(params)):
            entries = approval_mod.list_gateway_approvals(session_id)
            targets = [e for e in entries if e.get("request_id") == request_id] if request_id else entries[:1]
            keys = []
            for entry in targets:
                keys.extend(entry.get("pattern_keys") or [entry.get("pattern_key", "")])
            keys = [k for k in keys if k]
            if choice == "session":
                for k in keys:
                    approval_mod.approve_session(session_id, k)
            elif choice == "always" and keys:
                permanent_set = getattr(approval_mod, "_permanent_set", None)
                baseline_key = getattr(approval_mod, "_baseline_key", None)
                baselines = getattr(approval_mod, "_permanent_baseline_by_home", None)
                if not callable(permanent_set) or not callable(baseline_key) or not isinstance(baselines, dict):
                    raise RpcError("Agent cannot safely persist command approvals", condition="agent_incompatible")
                for k in keys:
                    approval_mod.approve_session(session_id, k)
                    approval_mod.approve_permanent(k)
                try:
                    # Older retained Agents' _persist_choice saves full snapshots. Capture only unsaved grants
                    # against this home's baseline, so a concurrent revocation cannot become fresh approval intent.
                    with approval_mod._lock:
                        grants = permanent_set() - baselines.get(baseline_key(), set())
                    approval_mod.save_permanent_allowlist(grants)
                except Exception:  # noqa: BLE001
                    log.debug("save_permanent_allowlist failed", exc_info=True)
            resolved = approval_mod.resolve_gateway_approval(session_id, choice, request_id=request_id)
        return {"ok": bool(resolved), "resolved": int(resolved or 0), "choice": choice}

    @registry.method("approval.pending", requires_agent=True)
    def approval_pending_(ctx: CallContext, params: dict) -> dict:
        session_id = str(params.get("session_id") or "").strip()
        try:
            from tools.approval import list_gateway_approvals
        except Exception as exc:  # noqa: BLE001
            raise RpcError(f"approval module unavailable: {exc}", condition="agent_unavailable") from exc
        return {"pending": list_gateway_approvals(session_id)}

    @registry.method("approval.set_yolo", requires_agent=True)
    def set_yolo_(ctx: CallContext, params: dict) -> dict:
        session_id = str(params.get("session_id") or "").strip()
        enabled = bool(params.get("enabled"))
        try:
            from tools.approval import disable_session_yolo, enable_session_yolo, is_session_yolo_enabled, resolve_gateway_approval
        except Exception as exc:  # noqa: BLE001
            raise RpcError(f"approval module unavailable: {exc}", condition="agent_unavailable") from exc
        (enable_session_yolo if enabled else disable_session_yolo)(session_id)
        # Parked approvals are released `once`: a `session` or `always` grant would keep their patterns approved after
        # YOLO turns off, whatever choice the card that enabled it carried.
        released = resolve_gateway_approval(session_id, "once", resolve_all=True) if enabled else 0
        return {"yolo_enabled": bool(is_session_yolo_enabled(session_id)), "released": int(released or 0)}

    @registry.method("clarify.respond", requires_agent=False)
    def clarify_respond_(ctx: CallContext, params: dict) -> dict:
        response = str(params.get("response") or "")
        clarify_id = str(params.get("clarify_id") or "").strip()
        run = _run_for(params)
        if run is None:
            return {"ok": False}
        if params.get("session_id") and str(params["session_id"]) != run.session_id:
            return {"ok": False}
        with run.lock:
            entries = list(run.clarify_entries.values())
            target = next((e for e in entries if e.clarify_id == clarify_id), None) if clarify_id else (entries[0] if entries else None)
            if target is None or target.event.is_set() or (target.deadline is not None and time.monotonic() >= target.deadline):
                return {"ok": False}
            skill_secret = target.data.get("kind") == "skill_secret"
            if skill_secret and (not clarify_id or ctx.cancelled or run.ctx.cancelled or run.cancel.is_set() or run.finished.is_set() or run.session_ended):
                return {"ok": False}
            # Secure answers are as typed; an empty reply is their decline. Only the first answer releases a waiter.
            secure = str(target.data.get("kind") or "").startswith("vault_") or skill_secret
            if not secure:
                response = response.strip()
            if not response and not secure:
                raise InvalidParams("response is required")
            target.result = response
            target.event.set()
            return {"ok": True, "clarify_id": target.clarify_id}
