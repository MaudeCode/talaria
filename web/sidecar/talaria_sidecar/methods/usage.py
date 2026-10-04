"""``usage.*``: provider account usage through ``agent.account_usage``."""

from __future__ import annotations

import dataclasses
import logging
from datetime import date, datetime, timezone
from typing import Any

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.usage")


def _plain(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {k: _plain(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_plain(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if hasattr(value, "__dict__"):
        return {k: _plain(v) for k, v in vars(value).items() if not k.startswith("_")}
    return str(value)


def account(provider: str, *, base_url: str | None, api_key: str | None) -> dict | None:
    try:
        from agent.account_usage import fetch_account_usage
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"account usage unavailable: {exc}", condition="usage_unavailable") from exc
    try:
        snapshot = fetch_account_usage(provider, base_url=base_url, api_key=api_key)
    except Exception as exc:  # noqa: BLE001
        log.debug("fetch_account_usage(%r) failed", provider, exc_info=True)
        return {"provider": provider, "available": False, "unavailable_reason": f"{type(exc).__name__}: {exc}", "windows": [], "details": []}
    if snapshot is None:
        return None
    row = _plain(snapshot)
    if not isinstance(row, dict):
        return None
    row.setdefault("provider", provider)
    row["windows"] = [w for w in (row.get("windows") or []) if isinstance(w, dict)]
    row["details"] = list(row.get("details") or [])
    row["available"] = bool(row.get("available"))
    return row


def register(registry) -> None:
    @registry.method("usage.account")
    def account_(ctx: CallContext, params: dict) -> dict:
        provider = str(params.get("provider") or "").strip()
        if not provider:
            raise InvalidParams("provider is required")
        with scoped_home(profile_home_param(params)):
            return {"snapshot": account(provider, base_url=params.get("base_url"), api_key=params.get("api_key"))}
