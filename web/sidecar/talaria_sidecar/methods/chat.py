"""``chat.*``, ``approval.*``, ``clarify.*``: one Agent turn per ``chat.start`` call.

The server owns the WebUI session (transcript merge, journals, SSE fan-out);
the sidecar owns the ``AIAgent`` instance. ``chat.start`` streams the Agent's
callbacks as frames and returns the settled result. Approval and clarify
prompts block the Agent thread until the server relays the user's answer
through ``approval.respond`` / ``clarify.respond``; ``rpc.cancel`` or
``chat.interrupt`` stop the turn (``api/streaming.py`` in the Python backend).
"""

from __future__ import annotations

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
_TOOL_ARG_CONTENT_KEYS = frozenset({"content", "text", "body", "data", "code", "command", "input", "query", "message", "prompt"})
_CLARIFY_FALLBACK = "The user did not provide a response within the time limit. Use your best judgement to make the choice and proceed."


class _Run:
    def __init__(self, stream_id: str, session_id: str, ctx: CallContext):
        self.stream_id = stream_id
        self.session_id = session_id
        self.ctx = ctx
        self.agent = None
        self.cancel = threading.Event()
        self.clarify_entries: dict[str, "_ClarifyEntry"] = {}
        self.lock = threading.Lock()


class _ClarifyEntry:
    def __init__(self, data: dict):
        self.clarify_id = uuid.uuid4().hex
        self.data = data
        self.event = threading.Event()
        self.result: str | None = None


_RUNS: dict[str, _Run] = {}
_RUNS_BY_SESSION: dict[str, str] = {}
_RUNS_LOCK = threading.Lock()
_AGENT_CACHE: "OrderedDict[str, tuple[Any, str]]" = OrderedDict()
_AGENT_CACHE_LOCK = threading.Lock()


def _snippet(raw: Any, limit: int = _TOOL_RESULT_SNIPPET_MAX) -> str:
    if isinstance(raw, (dict, list)):
        try:
            text = json.dumps(raw, ensure_ascii=False, default=str)
        except Exception:  # noqa: BLE001
            text = str(raw)
    else:
        text = str(raw or "")
    return text if len(text) <= limit else text[:limit] + "..."


def _args_snapshot(args: Any) -> dict:
    snap: dict = {}
    if isinstance(args, dict):
        for k, v in list(args.items())[:4]:
            s2 = str(v)
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


def _agent_class():
    try:
        from run_agent import AIAgent
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"AIAgent unavailable: {exc}", condition="agent_unavailable") from exc
    return AIAgent


def _supported(cls, name: str) -> bool:
    try:
        return name in inspect.signature(cls.__init__).parameters
    except (TypeError, ValueError):
        return False


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
        _RUNS[stream_id] = run
        _RUNS_BY_SESSION[session_id] = stream_id
    emit = ctx.emit
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
            emit("tool_complete", {"event_type": "tool.completed", "name": name, "preview": snippet, "args": _args_snapshot(args), "tid": tid, "is_error": False})

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

        def clarify_callback(question, choices, questions=None):
            choices_list = [str(c) for c in (choices or [])]
            data = {"question": str(question or ""), "choices_offered": choices_list, "session_id": session_id, "kind": "clarify", "requested_at": time.time()}
            if isinstance(questions, list) and questions:
                data["questions"] = questions
            entry = _ClarifyEntry(data)
            entry.data["clarify_id"] = entry.clarify_id
            with run.lock:
                run.clarify_entries[entry.clarify_id] = entry
            emit("clarify", dict(entry.data))
            timeout = float(params.get("clarify_timeout_seconds") or 3600)
            deadline = time.monotonic() + timeout
            while not entry.event.is_set():
                if run.cancel.is_set():
                    break
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
            register_gateway_notify(session_id, _approval_cb)

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
        signature = json.dumps({"model": resolved_model, "provider": resolved_provider, "base_url": runtime.get("base_url"), "toolsets": toolsets, "home": str(params.get("profile_home"))}, sort_keys=True, default=str)
        agent = None
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
                while len(_AGENT_CACHE) > _AGENT_CACHE_MAX:
                    _AGENT_CACHE.popitem(last=False)
        run.agent = agent
        compressions_before = int(getattr(getattr(agent, "context_compressor", None), "compression_count", 0) or 0)

        def _watch_cancel():
            while not run.cancel.wait(0.25):
                if ctx.cancelled:
                    run.cancel.set()
                    break
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
        emit("context_status", {"session_id": session_id, "model": resolved_model, "provider": resolved_provider, **_context_length(agent)})
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
            run.cancel.set()
            watcher.join(timeout=2)
            if unregister_gateway_notify is not None:
                try:
                    unregister_gateway_notify(session_id)
                except Exception:  # noqa: BLE001
                    pass
        cancelled = ctx.cancelled or bool(getattr(agent, "_interrupt_requested", False)) and (error is None and not result.get("final_response"))
        if ctx.cancelled:
            cancelled = True
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
        with scoped_home(profile_home_param(params)):
            return start(ctx, params)

    @registry.method("chat.interrupt", requires_agent=False)
    def interrupt_(ctx: CallContext, params: dict) -> dict:
        run = _run_for(params)
        if run is None:
            return {"ok": False, "reason": "not_running"}
        run.cancel.set()
        return {"ok": True}

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
        return {"accepted": accepted, "fallback": None if accepted else "not_running"}

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
                    approval_mod.save_permanent_allowlist(approval_mod._permanent_approved)
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
