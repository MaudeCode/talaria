"""One route-aware speed gate for the model catalog and chat request overrides."""

from __future__ import annotations


def fast_overrides(model: str, provider: str, base_url: str, tier: str) -> dict | None:
    if tier not in ("priority", "ultrafast"):
        return None
    from hermes_cli.models import resolve_fast_mode_overrides

    return resolve_fast_mode_overrides(model, provider=provider, base_url=base_url, tier=tier)


def supported_speed_tiers(model: str, provider: str, base_url: str) -> list[dict]:
    tiers = []
    for tier in ("priority", "ultrafast"):
        override = fast_overrides(model, provider, base_url, tier)
        if override and (tier != "ultrafast" or ultrafast_offered(model, provider, base_url)):
            tiers.append({"id": "fast" if override.get("speed") == "fast" else tier, "service_tier": tier})
    return [{"id": "standard", "service_tier": "default"}, *tiers] if tiers else []


def ultrafast_offered(model: str, provider: str, base_url: str) -> bool:
    """The Agent's account check: a Codex plan without Ultrafast accepts the tier and silently serves default."""
    from agent.codex_service_tiers import ultrafast_offered as offered

    return bool(offered(model, provider=provider, base_url=base_url))
