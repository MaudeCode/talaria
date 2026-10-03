"""``text.*``: pure helpers from the Agent that the server must match exactly
(image input routing, portal tags)."""

from __future__ import annotations

import logging

from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.text")


def image_mode(*, provider: str, model: str, cfg: dict | None, requested_provider: str) -> dict:
    """``native`` or ``text`` for current-turn image uploads, as the Agent decides it."""
    try:
        from agent.image_routing import decide_image_input_mode
    except Exception:  # noqa: BLE001
        return {"mode": "text", "reason": "image routing unavailable"}
    try:
        decision = decide_image_input_mode(provider, model, cfg, requested_provider=requested_provider)
    except TypeError:
        decision = decide_image_input_mode(provider, model, cfg)
    except Exception as exc:  # noqa: BLE001
        return {"mode": "text", "reason": f"{type(exc).__name__}: {exc}", "supports_vision": None}
    supports_vision = None
    try:
        from agent.image_routing import _lookup_supports_vision

        verdict = _lookup_supports_vision(provider, model, cfg, requested_provider=requested_provider)
        supports_vision = None if verdict is None else bool(verdict)
    except Exception:  # noqa: BLE001
        supports_vision = None
    return {"mode": str(decision or "text"), "reason": "", "supports_vision": supports_vision}


def portal_tags() -> dict:
    try:
        from agent.portal_tags import conversation_tag, hermes_client_tag, nous_portal_tags
    except Exception:  # noqa: BLE001
        return {"client_tag": None, "conversation_tag": None, "tags": []}
    out: dict = {}
    for key, func in (("client_tag", hermes_client_tag), ("conversation_tag", conversation_tag)):
        try:
            out[key] = func()
        except Exception:  # noqa: BLE001
            out[key] = None
    try:
        tags = nous_portal_tags()
        out["tags"] = [str(t) for t in (tags or [])] if not isinstance(tags, dict) else tags
    except Exception:  # noqa: BLE001
        out["tags"] = []
    return out


def register(registry) -> None:
    @registry.method("text.image_mode")
    def image_mode_(ctx: CallContext, params: dict) -> dict:
        cfg = params.get("cfg") if isinstance(params.get("cfg"), dict) else None
        with scoped_home(profile_home_param(params)):
            return image_mode(provider=str(params.get("provider") or ""), model=str(params.get("model") or ""), cfg=cfg, requested_provider=str(params.get("requested_provider") or ""))

    @registry.method("text.portal_tags")
    def tags(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return portal_tags()
