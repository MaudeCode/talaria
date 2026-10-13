"""One route-aware speed gate for the model catalog and chat request overrides."""

from __future__ import annotations

import inspect
import re
from urllib.parse import urlparse


def fast_overrides(model: str, provider: str, base_url: str, tier: str) -> dict | None:
    if tier not in ("priority", "ultrafast"):
        return None
    from hermes_cli import models

    resolver = getattr(models, "resolve_fast_mode_overrides", None)
    if resolver is not None:
        if "tier" in inspect.signature(resolver).parameters:
            return resolver(model, provider=provider, base_url=base_url, tier=tier)
        return resolver(model, provider=provider, base_url=base_url) if tier == "priority" else None
    # Older Agents have no resolver. Keep the former GPT-5/o-series gate, restricted to first-party routes.
    hosts = {"openai": "api.openai.com", "openai-api": "api.openai.com", "openai-codex": "chatgpt.com"}
    model = model.strip().lower().removeprefix("openai/")
    host = urlparse(base_url).hostname if base_url else None
    if tier == "priority" and provider in hosts and (not host or host == hosts[provider]) and (model.startswith("gpt-5") or re.match(r"o[0-9]", model)):
        return {"service_tier": "priority"}
    return None


def supported_speed_tiers(model: str, provider: str, base_url: str) -> list[dict]:
    tiers = []
    for tier in ("priority", "ultrafast"):
        override = fast_overrides(model, provider, base_url, tier)
        if override:
            tiers.append({"id": "fast" if override.get("speed") == "fast" else tier, "service_tier": tier})
    return [{"id": "standard", "service_tier": "default"}, *tiers] if tiers else []
