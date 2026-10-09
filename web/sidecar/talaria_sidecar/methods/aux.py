"""``aux.*``: auxiliary LLM calls through ``agent.auxiliary_client``."""

from __future__ import annotations

import contextlib
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


def _model_completion(task: str, messages: list, *, model: str, provider: str | None, max_tokens: int | None, temperature: float | None) -> dict:
    """TAL-258 (predecessor ``_agent_text_completion``): the named model answers itself through the Agent's ``call_llm``,
    reasoning off and no tools, so the caller sees its ``finish_reason``. ``max_tokens`` reaches the provider on the routes
    the Agent forwards a cap on. ``credential_missing`` when the model has no credential."""
    from .chat import _resolve_runtime

    runtime = _resolve_runtime(provider, model)
    if not runtime.get("api_key"):
        raise RpcError(f"no credential for model {model or 'default'!r}", condition="credential_missing")
    from agent.auxiliary_client import call_llm

    resolved = model or str(runtime.get("model") or "")
    response = call_llm(
        task, provider=provider or runtime.get("provider"), model=resolved, base_url=runtime.get("base_url"), api_key=runtime.get("api_key"),
        api_mode=runtime.get("api_mode"), messages=messages, max_tokens=int(max_tokens) if max_tokens else None,
        temperature=float(temperature) if temperature is not None else None, reasoning_config={"enabled": False}, timeout=30.0,
    )
    choice = (getattr(response, "choices", None) or [None])[0]
    message = getattr(choice, "message", None)
    reason = getattr(choice, "finish_reason", None)
    return {"model": resolved, "text": str(getattr(message, "content", None) or "").strip(), "usage": _usage_dict(getattr(response, "usage", None)),
            "finish_reason": str(reason) if reason else None}


def complete(task: str, messages: list, *, main_runtime: dict | None, max_tokens: int | None, temperature: float | None, ctx: CallContext, main_fallback: bool = False,
             model: str | None = None, provider: str | None = None) -> dict:
    """One auxiliary completion; streams ``token`` frames when the client supports it.

    With ``main_fallback`` the main model answers (through ``AIAgent``) when no auxiliary client is configured or the
    auxiliary call fails, as the predecessor's git commit-message route did. An explicit ``model`` skips the auxiliary
    route: that model answers (``_model_completion``)."""
    if model is not None:
        return _model_completion(task, messages, model=model, provider=provider, max_tokens=max_tokens, temperature=temperature)
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
    if main_fallback and main_runtime and main_runtime.get("model"):
        try:
            return _stream_completion(client, model, messages, max_tokens=max_tokens, temperature=temperature, ctx=ctx)
        except RpcError:
            raise
        except Exception as exc:  # noqa: BLE001 - predecessor fell back to the main model
            log.debug("auxiliary %s call failed; falling back to the main model: %s", task, exc)
            return _main_model_completion(messages, main_runtime, task=task)
    return _stream_completion(client, model, messages, max_tokens=max_tokens, temperature=temperature, ctx=ctx)


def _stream_completion(client, model: str, messages: list, *, max_tokens: int | None, temperature: float | None, ctx: CallContext) -> dict:
    kwargs: dict = {"model": model, "messages": messages}
    if max_tokens:
        kwargs["max_tokens"] = int(max_tokens)
    if temperature is not None:
        kwargs["temperature"] = float(temperature)
    text_parts: list[str] = []
    usage = None
    finish_reason = None
    try:
        stream = client.chat.completions.create(stream=True, **kwargs)
        for chunk in stream:
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
    except RpcError:
        raise
    except Exception as exc:  # noqa: BLE001 - fall back to a non-streaming call
        log.debug("streaming auxiliary call failed (%s); retrying without stream", exc)
        response = client.chat.completions.create(**kwargs)
        text_parts = [str(response.choices[0].message.content or "")]
        usage = _usage_dict(getattr(response, "usage", None))
        finish_reason = str(response.choices[0].finish_reason) if getattr(response.choices[0], "finish_reason", None) else None
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
