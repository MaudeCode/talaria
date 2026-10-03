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
import hashlib
import inspect
import json
import logging
import threading
import time
import uuid
from collections import OrderedDict
from typing import Any

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.chat")

_AGENT_CACHE_MAX = 32
_TOOL_RESULT_SNIPPET_MAX = 4000
# Predecessor ``_TOOL_ARG_CONTENT_KEYS`` (#4928): card content / diff-reconstruction inputs keep the long cap.
_TOOL_ARG_CONTENT_KEYS = frozenset({"command", "cmd", "script", "code", "patch", "diff", "old_string", "new_string", "content", "path", "file_path"})
_CLARIFY_FALLBACK = "The user did not provide a response within the time limit. Use your best judgement to make the choice and proceed."


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


class _ClarifyEntry:
    def __init__(self, data: dict):
        self.clarify_id = uuid.uuid4().hex
        self.data = data
        self.event = threading.Event()
        self.result: str | None = None


_RUNS: dict[str, _Run] = {}
_RUNS_BY_SESSION: dict[str, str] = {}
# Which run owns the Agent's gateway approval callback per session; register/unregister happen under one lock so a
# stale run can never remove a successor's callback, and a successor can never leak a predecessor's.
_APPROVAL_CB_OWNER: dict[str, str] = {}
_APPROVAL_CB_LOCK = threading.Lock()
_RUNS_LOCK = threading.Lock()
_AGENT_CACHE: "OrderedDict[str, tuple[Any, str]]" = OrderedDict()
_AGENT_CACHE_LOCK = threading.Lock()


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
_RAW_RESULT_OUTCOME_KEYS = ("error", "exit_code", "exitCode", "success")


def _raw_result(raw: Any, limit: int = _TOOL_RESULT_SNIPPET_MAX) -> Any:
    """The tool result as the server's outcome rule reads it, bounded: a dict (or JSON-object text) keeps its first
    ``_RAW_RESULT_MAX_KEYS`` top-level fields plus its outcome fields, scalars as they are, text and non-empty nested
    values as capped (JSON) text; anything else is the capped text. The sidecar decides nothing; the server does."""
    try:
        data = raw if isinstance(raw, dict) else json.loads(str(raw or ""))
    except Exception:  # noqa: BLE001
        data = None
    if not isinstance(data, dict):
        return str(raw if raw is not None else "")[:limit]
    out: dict = {}
    # The server's outcome rule reads these, wherever they sit in the result.
    kept = list(data.items())[:_RAW_RESULT_MAX_KEYS] + [(k, data[k]) for k in _RAW_RESULT_OUTCOME_KEYS if k in data]
    for key, value in kept:
        if value is None or isinstance(value, (bool, int)) or (isinstance(value, float) and value == value and abs(value) != float("inf")):
            out[str(key)] = value
        elif isinstance(value, (dict, list)) and not value:
            out[str(key)] = {} if isinstance(value, dict) else []
        else:
            text = value if isinstance(value, str) else json.dumps(value, default=str)
            out[str(key)] = text[:limit]
    return out


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
    return out


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
        raise RpcError(str(exc), condition="credential_missing", data={"error_type": type(exc).__name__}) from exc
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
        try:
            from tools.approval_context import reset_current_session_key, set_current_session_key
        except ImportError:
            from tools.approval import reset_current_session_key, set_current_session_key  # type: ignore[no-redef]
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
        from agent.runtime_cwd import _SESSION_CWD

        tok = _SESSION_CWD.set(str(workspace))
        resets.append(lambda: _SESSION_CWD.reset(tok))
    except Exception:  # noqa: BLE001
        log.debug("per-turn session cwd bind failed", exc_info=True)
    try:
        yield
    finally:
        for reset in reversed(resets):
            try:
                reset()
            except Exception:  # noqa: BLE001
                log.debug("per-turn identity reset failed", exc_info=True)


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
        "credential_pool": pool_identity, "toolsets": toolsets, "home": home,
        "max_iterations": kwargs.get("max_iterations"), "max_tokens": kwargs.get("max_tokens"),
        # Bound at construction too: a reasoning-effort change from the composer must build a fresh agent.
        "reasoning_config": kwargs.get("reasoning_config"),
    }
    return json.dumps(bundle, sort_keys=True, default=str)


def _evict_idle_agents_locked() -> None:
    """Trim the agent LRU (caller holds ``_AGENT_CACHE_LOCK``), never dropping a session whose turn is still running."""
    if len(_AGENT_CACHE) <= _AGENT_CACHE_MAX:
        return
    with _RUNS_LOCK:
        live = {sid for sid, sid_stream in _RUNS_BY_SESSION.items() if (r := _RUNS.get(sid_stream)) is not None and not r.finished.is_set()}
    for sid in list(_AGENT_CACHE):
        if len(_AGENT_CACHE) <= _AGENT_CACHE_MAX:
            break
        if sid not in live:
            _AGENT_CACHE.pop(sid, None)


def evict_all_agents() -> int:
    """Drop every cached agent (credentials or environment changed underneath them)."""
    with _AGENT_CACHE_LOCK:
        count = len(_AGENT_CACHE)
        _AGENT_CACHE.clear()
    return count


def _agent_class():
    try:
        from run_agent import AIAgent
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"AIAgent unavailable: {exc}", condition="agent_unavailable") from exc
    return AIAgent


def _supported(cls, name: str) -> bool:
    """Whether ``cls.__init__`` accepts ``name`` (named, or through ``**kwargs``)."""
    try:
        parameters = inspect.signature(cls.__init__).parameters
    except (TypeError, ValueError):
        return False
    return name in parameters or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values())


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
    toolsets = params.get("enabled_toolsets")
    system_message = params.get("system_message")
    run = _Run(stream_id, session_id, ctx)
    with _RUNS_LOCK:
        prior = _RUNS.get(_RUNS_BY_SESSION.get(session_id) or "")
        # A previous turn for this session that never returned (a tool ignoring its interrupt) still owns the cached
        # agent; this turn must not share, rebind, or un-interrupt that live instance.
        session_busy = prior is not None and not prior.finished.is_set()
        _RUNS[stream_id] = run
        _RUNS_BY_SESSION[session_id] = stream_id
    raw_emit = ctx.emit
    steer_state = {"last": None}

    def emit(event, data=None):
        """Predecessor ``_webui_steer_events_before``: before content frames, report the Agent's pending steer text
        whenever it changed so the server can mark consumed steers live rather than only after ``done``."""
        if event in ("token", "reasoning", "interim_assistant", "tool", "tool_complete") and run.agent is not None:
            pending = _agent_pending_steer_text(run.agent)
            if pending != steer_state["last"]:
                steer_state["last"] = pending
                raw_emit("steer_pending", {"text": pending})
        raw_emit(event, data)
    try:
        runtime = _resolve_runtime(provider, model)
        resolved_model = model or str(runtime.get("model") or "")
        resolved_provider = provider or runtime.get("provider")
        AIAgent = _agent_class()
        live_tool_calls: list[dict] = []
        started_ids: set[str] = set()
        completed_ids: set[str] = set()
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
            cost = _delegation_cost_usd(name, function_result)
            if cost is not None:
                payload["cost_usd"] = cost
                for call in reversed(live_tool_calls):
                    if call.get("tid") == tid:
                        call["cost_usd"] = cost
                        break
            emit("tool_complete", payload)

        def on_tool(*cb_args, **cb_kwargs):
            # Structured callbacks carry tool cards; the progress callback only feeds reasoning text on older builds.
            if len(cb_args) >= 3 and cb_args[0] in ("reasoning.available", "_thinking"):
                text = cb_args[2] if cb_args[0] == "reasoning.available" else cb_args[1]
                if text:
                    emit("reasoning", {"text": str(text)})

        def on_status(kind, message):
            text = str(message or "").strip()
            if not text:
                return
            lower = text.lower()
            if "compress" in lower and ("start" in lower or "compressing" in lower):
                emit("compressing", {"session_id": session_id, "message": "Compressing context"})
            elif "fallback" in lower or "rate limit" in lower or "retry" in lower:
                emit("warning", {"type": "fallback", "message": text})
            elif "non-retryable error" in lower:
                emit("status", {"kind": "terminal_error", "message": text})

        def clarify_callback(question, choices, multi_select=False, questions=None):
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
            entry = _ClarifyEntry(data)
            entry.data["clarify_id"] = entry.clarify_id
            with run.lock:
                run.clarify_entries[entry.clarify_id] = entry
            emit("clarify", dict(entry.data))
            deadline = None if timeout <= 0 else time.monotonic() + float(timeout)
            while not entry.event.is_set():
                if run.cancel.is_set() or run.finished.is_set():
                    break
                if deadline is None:
                    entry.event.wait(1.0)
                    continue
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                entry.event.wait(min(1.0, remaining))
            with run.lock:
                run.clarify_entries.pop(entry.clarify_id, None)
            emit("clarify_resolved", {"clarify_id": entry.clarify_id, "session_id": session_id})
            return entry.result or _CLARIFY_FALLBACK

        # Approval bridge: the Agent parks dangerous commands in its gateway queue and calls back here.
        try:
            from tools.approval import register_gateway_notify, unregister_gateway_notify
        except Exception:  # noqa: BLE001
            register_gateway_notify = unregister_gateway_notify = None
        if register_gateway_notify is not None:
            def _approval_cb(data):
                payload = dict(data or {})
                payload.setdefault("session_id", session_id)
                payload.setdefault("approval_id", str(payload.get("request_id") or uuid.uuid4().hex))
                emit("approval", payload)
            approval_cb = _approval_cb
        else:
            approval_cb = None

        kwargs: dict = dict(
            model=resolved_model,
            provider=resolved_provider,
            base_url=runtime.get("base_url"),
            api_key=runtime.get("api_key"),
            platform="webui",
            quiet_mode=True,
            enabled_toolsets=toolsets if isinstance(toolsets, list) else None,
            session_id=session_id,
            stream_delta_callback=on_token,
            reasoning_callback=on_reasoning,
            tool_progress_callback=on_tool,
            clarify_callback=clarify_callback,
        )
        for name, value in (
            ("interim_assistant_callback", on_interim),
            ("tool_start_callback", on_tool_start),
            ("tool_complete_callback", on_tool_complete),
            ("status_callback", on_status),
            ("api_mode", runtime.get("api_mode")),
            ("acp_command", runtime.get("acp_command")),
            ("acp_args", runtime.get("acp_args")),
            ("credential_pool", runtime.get("credential_pool")),
            ("gateway_session_key", session_id),
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
        signature = _agent_signature(resolved_model, resolved_provider, runtime, toolsets, str(params.get("profile_home")), kwargs)
        agent = None
        if not session_busy:
            with _AGENT_CACHE_LOCK:
                cached = _AGENT_CACHE.get(session_id)
                if cached and cached[1] == signature:
                    agent = cached[0]
                    _AGENT_CACHE.move_to_end(session_id)
        if agent is not None:
            for name in ("stream_delta_callback", "reasoning_callback", "tool_progress_callback", "clarify_callback", "interim_assistant_callback", "tool_start_callback", "tool_complete_callback", "status_callback"):
                if name in kwargs and hasattr(agent, name):
                    setattr(agent, name, kwargs[name])
        else:
            agent = AIAgent(**kwargs)
            with _AGENT_CACHE_LOCK:
                _AGENT_CACHE[session_id] = (agent, signature)
                _AGENT_CACHE.move_to_end(session_id)
                _evict_idle_agents_locked()
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
        run.prior_messages = getattr(agent, "_session_messages", None)
        run.agent = agent
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
            while not run.cancel.wait(0.25):
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
        try:
            run_params = set(inspect.signature(agent.run_conversation).parameters)
        except (TypeError, ValueError):
            run_params = set()
        if system_message and ("system_message" in run_params or not run_params):
            run_kwargs["system_message"] = system_message
        if "persist_user_message" in run_params and isinstance(user_message, str):
            run_kwargs["persist_user_message"] = user_message
        error: str | None = None
        result: dict = {}
        try:
            raw = agent.run_conversation(**run_kwargs)
            result = raw if isinstance(raw, dict) else {}
        except Exception as exc:  # noqa: BLE001
            log.warning("agent turn failed for %s: %s", session_id, exc)
            error = f"{type(exc).__name__}: {exc}"
        finally:
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
        status = "cancelled" if cancelled else ("error" if error and not result.get("messages") else "completed")
        pending_steer = str(result.get("pending_steer") or "") if isinstance(result, dict) else ""
        return {
            "status": status,
            "messages": [m for m in (result.get("messages") or []) if isinstance(m, dict)],
            "final_response": str(result.get("final_response") or ""),
            "error": error,
            "result_status": str(result.get("status") or result.get("state") or ""),
            "tool_limit_reached": bool(result.get("tool_limit_reached") or result.get("max_iterations_reached")),
            "usage": _usage(agent),
            "context": _context_length(agent),
            "model": str(getattr(agent, "model", None) or resolved_model),
            "provider": str(resolved_provider or ""),
            "compressed": compressions_after > compressions_before,
            "agent_session_id": str(getattr(agent, "session_id", None) or session_id),
            "token_sent": token_sent[0],
            "pending_steer": pending_steer,
            "live_tool_calls": live_tool_calls,
        }
    finally:
        with _RUNS_LOCK:
            _RUNS.pop(stream_id, None)
            if _RUNS_BY_SESSION.get(session_id) == stream_id:
                _RUNS_BY_SESSION.pop(session_id, None)


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
    model = str(params.get("model") or "").strip()
    provider = str(params.get("model_provider") or "").strip() or None
    focus_topic = str(params.get("focus_topic") or "").strip()[:500] or None
    toolsets = params.get("enabled_toolsets")
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
        enabled_toolsets=toolsets if isinstance(toolsets, list) else None,
        session_id=session_id,
    )
    for name, value in (
        ("api_mode", runtime.get("api_mode")),
        ("acp_command", runtime.get("acp_command")),
        ("acp_args", runtime.get("acp_args")),
        ("credential_pool", runtime.get("credential_pool")),
        ("gateway_session_key", session_id),
        ("skip_memory", not _checkpoint_required()),
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
        with scoped_home(profile_home_param(params)):
            with _turn_identity(session_id, workspace):
                return start(ctx, params)

    @registry.method("chat.compress")
    def compress_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return compress(ctx, params)

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
            return {"redirected": False, "withdrawn": False}
        return steer_now(run.agent, pending, index)

    @registry.method("chat.evict_agent", requires_agent=False)
    def evict_(ctx: CallContext, params: dict) -> dict:
        session_id = str(params.get("session_id") or "").strip()
        with _AGENT_CACHE_LOCK:
            evicted = _AGENT_CACHE.pop(session_id, None) is not None
        try:
            from tools.approval import clear_session
            clear_session(session_id)
        except Exception:  # noqa: BLE001
            pass
        return {"evicted": evicted}

    @registry.method("chat.commit_memory", requires_agent=False)
    def commit_memory_(ctx: CallContext, params: dict) -> dict:
        """Predecessor ``commit_session_memory``: flush the cached Agent's memory for a session the user just left."""
        session_id = str(params.get("session_id") or "").strip()
        with _AGENT_CACHE_LOCK:
            cached = _AGENT_CACHE.get(session_id)
        with _RUNS_LOCK:
            busy = (_RUNS_BY_SESSION.get(session_id) or "") in _RUNS
        agent = cached[0] if cached else None
        commit = getattr(agent, "commit_memory_session", None) if agent is not None else None
        if commit is None or busy:
            return {"committed": False}
        try:
            commit()
        except Exception as exc:  # noqa: BLE001
            log.warning("commit_memory_session() failed for session %s: %s", session_id, exc)
            return {"committed": False}
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
            targets = [e for e in entries if not request_id or e.get("request_id") == request_id]
            keys = []
            for entry in targets:
                keys.extend(entry.get("pattern_keys") or [entry.get("pattern_key", "")])
            keys = [k for k in keys if k]
            if choice == "session":
                for k in keys:
                    approval_mod.approve_session(session_id, k)
            elif choice == "always":
                for k in keys:
                    approval_mod.approve_session(session_id, k)
                    approval_mod.approve_permanent(k)
                try:
                    # Persist the set that governs THIS home (per-profile under the home override), not the launch
                    # profile's module-level set, which would overwrite a named profile's allowlist with the wrong keys.
                    permanent_set = getattr(approval_mod, "_permanent_set", None)
                    with approval_mod._lock:
                        snapshot = set(permanent_set()) if callable(permanent_set) else set(approval_mod._permanent_approved)
                    approval_mod.save_permanent_allowlist(snapshot)
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
        released = resolve_gateway_approval(session_id, "session", resolve_all=True) if enabled else 0
        return {"yolo_enabled": bool(is_session_yolo_enabled(session_id)), "released": int(released or 0)}

    @registry.method("clarify.respond", requires_agent=False)
    def clarify_respond_(ctx: CallContext, params: dict) -> dict:
        response = str(params.get("response") or "").strip()
        clarify_id = str(params.get("clarify_id") or "").strip()
        if not response:
            raise InvalidParams("response is required")
        run = _run_for(params)
        if run is None:
            return {"ok": False}
        with run.lock:
            entries = list(run.clarify_entries.values())
        target = None
        if clarify_id:
            target = next((e for e in entries if e.clarify_id == clarify_id), None)
        elif entries:
            target = entries[0]
        if target is None:
            return {"ok": False}
        target.result = response
        target.event.set()
        return {"ok": True, "clarify_id": target.clarify_id}
