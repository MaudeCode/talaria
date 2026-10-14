"""``aux.*``: auxiliary LLM calls through ``agent.auxiliary_client``."""

from __future__ import annotations

import contextlib
import contextvars
import inspect
import logging
import threading
import uuid

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.aux")


_RUNTIME_FIELDS = ("provider", "model", "base_url", "api_key", "api_mode", "acp_command", "acp_args", "credential_pool")


def resolve_main_runtime(hint: dict | None) -> dict | None:
    """Expand a ``{model, provider}`` hint into the resolved main-model runtime (predecessor ``_auxiliary_main_runtime``).

    A hint that already carries a credential is passed through untouched."""
    if not isinstance(hint, dict):
        return None
    if hint.get("api_key") or hint.get("base_url"):
        return hint
    from .chat import _resolve_runtime

    model = str(hint.get("model") or "").strip()
    provider = str(hint.get("provider") or "").strip() or None
    try:
        runtime = _resolve_runtime(provider, model)
    except RpcError:
        return hint
    out = {field: runtime.get(field) for field in _RUNTIME_FIELDS if runtime.get(field) is not None}
    out["model"] = model or str(runtime.get("model") or "")
    out["provider"] = provider or runtime.get("provider")
    return out


def _main_model_completion(messages: list, runtime: dict, *, task: str) -> dict:
    """Predecessor fallback: run the main model through ``AIAgent`` with no tools when no auxiliary client answers.

    The throwaway agent never touches long-term memory (the prompt is a raw git diff) and is always closed."""
    from .chat import _agent_class, _supported

    AIAgent = _agent_class()

    system = "\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "system") or None
    user = "\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "user")
    kwargs = dict(model=runtime.get("model"), provider=runtime.get("provider"), base_url=runtime.get("base_url"), api_key=runtime.get("api_key"),
                  platform="webui", quiet_mode=True, enabled_toolsets=[], session_id=f"{task}-{uuid.uuid4().hex[:8]}")
    for name in ("api_mode", "acp_command", "acp_args", "credential_pool"):
        if runtime.get(name) is not None:
            kwargs[name] = runtime[name]
    for name in ("skip_memory", "skip_background_review"):
        if _supported(AIAgent, name):
            kwargs[name] = True
    agent = AIAgent(**kwargs)
    try:
        result = agent.run_conversation(user_message=user, system_message=system, conversation_history=[], task_id=kwargs["session_id"])
    finally:
        with contextlib.suppress(Exception):
            agent._end_session_on_close = False
        close = getattr(agent, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001
                log.debug("%s fallback agent close failed", task, exc_info=True)
    return {"model": str(runtime.get("model") or ""), "text": str((result or {}).get("final_response") or "").strip(), "usage": None, "finish_reason": None}


def _model_completion(task: str, messages: list, *, model: str, provider: str | None, max_tokens: int | None, temperature: float | None, ctx: CallContext) -> dict:
    """TAL-258 (predecessor ``_agent_text_completion``): the named model answers itself through the Agent's ``call_llm``,
    reasoning off and no tools, so the caller sees its ``finish_reason``. ``max_tokens`` reaches the provider on the routes
    the Agent forwards a cap on. ``credential_missing`` when the model has no credential."""
    from .chat import _resolve_runtime

    runtime = _resolve_runtime(provider, model)
    if not runtime.get("api_key"):
        raise RpcError(f"no credential for model {model or 'default'!r}", condition="credential_missing")
    resolved = model or str(runtime.get("model") or "")
    response = _call_llm(
        task, ctx, provider=provider or runtime.get("provider"), model=resolved, base_url=runtime.get("base_url"), api_key=runtime.get("api_key"),
        api_mode=runtime.get("api_mode"), messages=messages, max_tokens=int(max_tokens) if max_tokens else None,
        temperature=float(temperature) if temperature is not None else None, reasoning_config={"enabled": False}, timeout=30.0,
    )
    return _response_result(resolved, response)


def _response_result(model: str, response) -> dict:
    """The ``aux.complete`` result for one complete (non-streamed) chat response; a response without a choice raises."""
    choice = response.choices[0]
    reason = getattr(choice, "finish_reason", None)
    return {"model": str(model), "text": str(choice.message.content or "").strip(), "usage": _usage_dict(getattr(response, "usage", None)),
            "finish_reason": str(reason) if reason else None}


def complete(task: str, messages: list, *, main_runtime: dict | None, max_tokens: int | None, temperature: float | None, ctx: CallContext, main_fallback: bool = False,
             model: str | None = None, provider: str | None = None) -> dict:
    """One auxiliary completion; streams ``token`` frames when the client supports it.

    With ``main_fallback`` the main model answers (through ``AIAgent``) when no auxiliary client is configured or the
    auxiliary call fails, as the predecessor's git commit-message route did. An explicit ``model`` skips the auxiliary
    route: that model answers (``_model_completion``)."""
    if model is not None:
        return _model_completion(task, messages, model=model, provider=provider, max_tokens=max_tokens, temperature=temperature, ctx=ctx)
    try:
        from agent.auxiliary_client import get_text_auxiliary_client
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"auxiliary client unavailable: {exc}", condition="aux_unavailable") from exc
    main_runtime = resolve_main_runtime(main_runtime)
    try:
        client, model = get_text_auxiliary_client(task, main_runtime=main_runtime)
    except TypeError:
        client, model = get_text_auxiliary_client(task)
    if client is None or not model:
        if main_fallback and main_runtime and main_runtime.get("model"):
            return _main_model_completion(messages, main_runtime, task=task)
        raise RpcError(f"no auxiliary model configured for task {task!r}", condition="aux_unconfigured")
    create, stream = _aux_request(task, client, model, messages, main_runtime=main_runtime, max_tokens=max_tokens, temperature=temperature, ctx=ctx)
    if main_fallback and main_runtime and main_runtime.get("model"):
        try:
            return _stream_completion(create, model, stream=stream, ctx=ctx)
        except RpcError:
            raise
        except Exception as exc:  # noqa: BLE001 - predecessor fell back to the main model
            log.debug("auxiliary %s call failed; falling back to the main model: %s", task, exc)
            return _main_model_completion(messages, main_runtime, task=task)
    return _stream_completion(create, model, stream=stream, ctx=ctx)


def _permit_limited(task: str) -> bool:
    """Whether ``auxiliary.<task>.max_concurrency`` limits the task, so the Agent's ``call_llm`` may wait for a permit."""
    from agent import auxiliary_client

    acquire = getattr(auxiliary_client, "_acquire_sync_aux_semaphore", None)
    return callable(acquire) and acquire(task) is not None


def _call_llm(task: str, ctx: CallContext, **kwargs):
    """The Agent's ``call_llm``. For a permit-limited task ``call_llm`` waits for the permit uncancellably, so the call
    runs on a helper thread under the Agent's interrupt protection: a cancelled call returns at once and frees its
    worker, and the Agent's protected provider call drops the request before dispatch once the permit comes."""
    from agent import auxiliary_client

    if not _permit_limited(task):
        return auxiliary_client.call_llm(task, **kwargs)
    outcome: dict = {}
    done = threading.Event()

    def run() -> None:
        try:
            with auxiliary_client.aux_interrupt_protection(cancel_event=ctx.cancel_event):
                outcome["response"] = auxiliary_client.call_llm(task, **kwargs)
        except BaseException as exc:  # noqa: BLE001 - handed to the waiting worker
            outcome["error"] = exc
        finally:
            done.set()

    threading.Thread(target=contextvars.copy_context().run, args=(run,), daemon=True, name=f"aux-{task}").start()
    while not done.wait(0.25):
        ctx.check_cancelled()
    ctx.check_cancelled()
    if "error" in outcome:
        raise outcome["error"]
    return outcome["response"]


def _call_llm_streams() -> bool:
    """Whether the Agent's ``call_llm`` streams with a caller's main runtime (older Agents cannot)."""
    try:
        from agent.auxiliary_client import call_llm
    except ImportError:
        return False
    return {"stream", "main_runtime"} <= inspect.signature(call_llm).parameters.keys()


def _aux_request(task: str, client, model: str, messages: list, *, main_runtime: dict | None, max_tokens: int | None, temperature: float | None, ctx: CallContext):
    """``(create(**stream), stream)`` for one auxiliary request. TAL-823: through the Agent's ``call_llm`` funnel (plugin
    hooks, a custom provider's ``extra_body``, watchdogs, response unwrap, fallbacks) when it streams; else the raw
    client. ``stream`` is False for a permit-limited task (its call must stay cancellable, see ``_call_llm``) and for
    the Agent's Codex, Anthropic and Bedrock shims, which answer ``stream=True`` whole."""
    kwargs: dict = {"messages": messages}
    if max_tokens:
        kwargs["max_tokens"] = int(max_tokens)
    if temperature is not None:
        kwargs["temperature"] = float(temperature)
    stream = hasattr(client.chat.completions, "with_streaming_response")
    if _call_llm_streams():
        return (lambda **stream: _call_llm(task, ctx, main_runtime=main_runtime, **kwargs, **stream)), stream and not _permit_limited(task)
    return (lambda **stream: client.chat.completions.create(model=model, **kwargs, **stream)), stream


def _stream_completion(create, model: str, *, stream: bool, ctx: CallContext) -> dict:
    if not stream:
        return _response_result(model, create())
    text_parts: list[str] = []
    usage = None
    finish_reason = None
    try:
        chunks = create(stream=True)
        try:
            for chunk in chunks:
                ctx.check_cancelled()
                choices = getattr(chunk, "choices", None) or []
                delta = getattr(choices[0], "delta", None) if choices else None
                piece = getattr(delta, "content", None) if delta is not None else None
                if piece:
                    text_parts.append(piece)
                    ctx.emit("token", {"text": piece})
                if choices and getattr(choices[0], "finish_reason", None):
                    finish_reason = str(choices[0].finish_reason)
                chunk_usage = getattr(chunk, "usage", None)
                if chunk_usage is not None:
                    usage = _usage_dict(chunk_usage)
        finally:
            # Releases the connection and the Agent's per-task concurrency permit on cancel or failure, too.
            close = getattr(chunks, "close", None)
            if callable(close):
                with contextlib.suppress(Exception):
                    close()
    except RpcError:
        raise
    except Exception as exc:  # noqa: BLE001 - fall back to a non-streaming call
        log.debug("streaming auxiliary call failed (%s); retrying without stream", exc)
        return _response_result(model, create())
    return {"model": str(model), "text": "".join(text_parts).strip(), "usage": usage, "finish_reason": finish_reason}


def _usage_dict(usage) -> dict | None:
    if usage is None:
        return None
    out = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = getattr(usage, key, None)
        if isinstance(value, int):
            out[key] = value
    return out or None


def _effort_word(task_cfg: dict) -> str:
    """Agent ``_aux_effort_word``: the resolved ``reasoning_effort`` ("" = provider default; YAML False = "none")."""
    raw = task_cfg.get("reasoning_effort")
    return "none" if raw is False else str(raw or "").strip().lower()


def aux_tasks() -> dict:
    """TAL-800: the home's auxiliary slots in Agent order, the ``hermes model`` picker's built-ins then the home's plugin
    tasks, each with its resolved reasoning effort and, for a task that inherits another slot, its effective route.
    ``reserved`` names the Agent's other ``auxiliary.*`` keys (settings and unlisted routes), which are never slots."""
    from agent.auxiliary_client import _get_auxiliary_task_config
    from hermes_cli.config import DEFAULT_CONFIG
    from hermes_cli.main_provider_setup import _AUX_TASKS

    rows = [{"key": key, "label": label, "description": description, "inherit_from": None} for key, label, description in _AUX_TASKS]
    builtin = {row["key"] for row in rows}
    try:
        from hermes_cli.plugins import get_plugin_auxiliary_tasks

        plugin_tasks = [entry for entry in get_plugin_auxiliary_tasks() if entry.get("key") and entry["key"] not in builtin]
    except Exception:  # noqa: BLE001 - plugin discovery must never hide the built-in slots (the Agent's own rule)
        log.debug("plugin auxiliary task lookup failed", exc_info=True)
        plugin_tasks = []
    rows += [{"key": str(entry["key"]), "label": str(entry.get("display_name") or entry["key"]), "description": str(entry.get("description") or ""),
              "inherit_from": str(entry.get("inherit_from") or "") or None} for entry in plugin_tasks]
    for row in rows:
        resolved = _get_auxiliary_task_config(row["key"])
        row["reasoning_effort"] = _effort_word(resolved)
        row["effective"] = {field: str(resolved.get(field) or "") for field in ("provider", "model", "base_url")} if row["inherit_from"] else None
    listed = {row["key"] for row in rows}
    return {"tasks": rows, "reserved": sorted(key for key in (DEFAULT_CONFIG.get("auxiliary") or {}) if key not in listed)}


def register(registry) -> None:
    @registry.method("aux.complete")
    def complete_(ctx: CallContext, params: dict) -> dict:
        task = str(params.get("task") or "").strip()
        messages = params.get("messages")
        if not task:
            raise InvalidParams("task is required")
        if not isinstance(messages, list) or not messages:
            raise InvalidParams("messages must be a non-empty list")
        main_runtime = params.get("main_runtime") if isinstance(params.get("main_runtime"), dict) else None
        with scoped_home(profile_home_param(params)):
            model = params.get("model")
            return complete(task, messages, main_runtime=main_runtime, max_tokens=params.get("max_tokens"), temperature=params.get("temperature"), ctx=ctx, main_fallback=bool(params.get("main_fallback")),
                            model=str(model).strip() if isinstance(model, str) else None, provider=str(params.get("provider") or "").strip() or None)

    @registry.method("aux.tasks")
    def tasks(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return aux_tasks()

    @registry.method("aux.resolve")
    def resolve(ctx: CallContext, params: dict) -> dict:
        """Which model would serve ``task`` (no call made)."""
        task = str(params.get("task") or "").strip()
        if not task:
            raise InvalidParams("task is required")
        main_runtime = params.get("main_runtime") if isinstance(params.get("main_runtime"), dict) else None
        with scoped_home(profile_home_param(params)):
            try:
                from agent.auxiliary_client import get_text_auxiliary_client

                try:
                    client, model = get_text_auxiliary_client(task, main_runtime=resolve_main_runtime(main_runtime))
                except TypeError:
                    client, model = get_text_auxiliary_client(task)
            except Exception as exc:  # noqa: BLE001
                return {"configured": False, "model": None, "error": f"{type(exc).__name__}: {exc}"}
        return {"configured": bool(client is not None and model), "model": str(model) if model else None}
