"""``aux.*``: auxiliary LLM calls through ``agent.auxiliary_client``."""

from __future__ import annotations

import logging
import threading

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.aux")


def complete(task: str, messages: list, *, main_runtime: dict | None, max_tokens: int | None, temperature: float | None, ctx: CallContext) -> dict:
    """One auxiliary completion; streams ``token`` frames when the client supports it."""
    try:
        from agent.auxiliary_client import get_text_auxiliary_client
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"auxiliary client unavailable: {exc}", condition="aux_unavailable") from exc
    try:
        client, model = get_text_auxiliary_client(task, main_runtime=main_runtime)
    except TypeError:
        client, model = get_text_auxiliary_client(task)
    if client is None or not model:
        raise RpcError(f"no auxiliary model configured for task {task!r}", condition="aux_unconfigured")
    kwargs: dict = {"model": model, "messages": messages}
    if max_tokens:
        kwargs["max_tokens"] = int(max_tokens)
    if temperature is not None:
        kwargs["temperature"] = float(temperature)
    text_parts: list[str] = []
    usage = None
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
    return {"model": str(model), "text": "".join(text_parts).strip(), "usage": usage}


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
            return complete(task, messages, main_runtime=main_runtime, max_tokens=params.get("max_tokens"), temperature=params.get("temperature"), ctx=ctx)

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
                    client, model = get_text_auxiliary_client(task, main_runtime=main_runtime)
                except TypeError:
                    client, model = get_text_auxiliary_client(task)
            except Exception as exc:  # noqa: BLE001
                return {"configured": False, "model": None, "error": f"{type(exc).__name__}: {exc}"}
        return {"configured": bool(client is not None and model), "model": str(model) if model else None}
