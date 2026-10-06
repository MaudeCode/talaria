"""``usage.*``: provider account usage through ``agent.account_usage``, the credential pool's local per-entry
state, and the key-based balance endpoints (TAL-548). Pool keys never leave the sidecar."""

from __future__ import annotations

import dataclasses
import json
import logging
import math
import time
import urllib.error
import urllib.request
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


def _iso(epoch: float | None) -> str | None:
    return None if epoch is None else datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


# Python `_is_ambient_gh_cli_entry`: a seeded `gh` CLI or GitHub env token is not an account the user added.
_AMBIENT_GH_SOURCES = frozenset({"gh_cli", "gh auth token", "env:github_token", "env:gh_token"})


def _is_ambient(entry) -> bool:
    return any(str((entry.get(k) if isinstance(entry, dict) else getattr(entry, k, "")) or "").strip().lower() in _AMBIENT_GH_SOURCES for k in ("source", "label", "key_source"))


def pool_providers() -> list[str]:
    """Providers whose persisted credential pool holds an account the user added; a read of ``auth.json`` with no seeding."""
    try:
        from hermes_cli.auth import read_credential_pool
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"credential pool unavailable: {exc}", condition="usage_unavailable") from exc
    try:
        pools = read_credential_pool()
    except Exception:  # noqa: BLE001
        log.debug("read_credential_pool() failed", exc_info=True)
        return []
    return sorted(str(pid) for pid, entries in (pools or {}).items()
                  if isinstance(entries, list) and any(isinstance(e, dict) and str(e.get("id") or "").strip() and not _is_ambient(e) for e in entries))


def _pool(provider: str) -> tuple[Any, list]:
    """The Agent's credential pool for the scoped profile and its non-ambient entries; ``(None, [])`` when unreadable."""
    try:
        from agent.credential_pool import load_pool
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"credential pool unavailable: {exc}", condition="usage_unavailable") from exc
    try:
        pool = load_pool(provider)
        entries = list(pool.entries()) if pool is not None else []
    except Exception:  # noqa: BLE001
        log.debug("load_pool(%r) failed", provider, exc_info=True)
        return None, []
    return pool, [e for e in entries if not _is_ambient(e)]


def _entry(provider: str, credential_id: str):
    return next((e for e in _pool(provider)[1] if str(getattr(e, "id", "") or "").strip() == credential_id), None)


def _entry_key(entry) -> str:
    """Python `_get_provider_api_key(provider, credential_id)`: the entry's runtime key."""
    for name in ("runtime_api_key", "agent_key", "access_token"):
        try:
            value = str(getattr(entry, name, "") or "").strip()
        except Exception:  # noqa: BLE001 - a runtime key property that cannot resolve
            value = ""
        if value:
            return value
    return ""


def _label(entry, index: int) -> str:
    """Python `_safe_entry_label`."""
    label = " ".join(str(getattr(entry, "label", "") or getattr(entry, "source", "") or f"Credential {index}").split())
    return label[:61].rstrip() + "..." if len(label) > 64 else label


def pool(provider: str) -> list[dict]:
    """Python `_local_pool_snapshot` rows: one per pool entry with an id, its local status, and no secrets."""
    agent_pool, entries = _pool(provider)
    try:
        from agent.credential_pool import _exhausted_until
    except Exception:  # noqa: BLE001 - an Agent without it cannot date an exhausted mark, so the entry reads as available
        def _exhausted_until(entry, *, sole_credential=False):
            return None
    sole_fn = getattr(agent_pool, "_is_sole_credential", None)
    sole = bool(sole_fn()) if callable(sole_fn) else len(entries) == 1
    rows = []
    for index, entry in enumerate(entries, start=1):
        credential_id = str(getattr(entry, "id", "") or "").strip()
        if not credential_id:
            continue
        row = {"credential_id": credential_id, "label": _label(entry, index), "status": "available", "unavailable_reason": None, "retry_after": None}
        status = str(getattr(entry, "last_status", "") or "").strip().lower()
        until = _exhausted_until(entry, sole_credential=sole) if status == "exhausted" else None
        if status == "dead":
            row.update(status="dead", unavailable_reason="Credential permanently revoked or invalid.")
        elif until is not None and time.time() < until:
            retry_after = _iso(until)
            code = getattr(entry, "last_error_code", None)
            reason = "Credential pool marked this credential exhausted" + (f" after provider status {code}" if code else "") + (f"; retry after {retry_after}" if retry_after else "")
            row.update(status="exhausted", unavailable_reason=reason + ".", retry_after=retry_after)
        rows.append(row)
    return rows


_BALANCE_URLS = {
    "openrouter": "https://openrouter.ai/api/v1/key",
    "deepseek": "https://api.deepseek.com/user/balance",
    "opencode-go": "https://opencode.ai/zen/go/v1/usage",
}
_BALANCE_TIMEOUT_SECONDS = 15.0
_BALANCE_MAX_BYTES = 256 * 1024


def _number(value: Any) -> int | float | None:
    """Python `_quota_number`, finite only: a NaN or infinity is not JSON."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    try:
        number = float(value if isinstance(value, float) else str(value).strip())
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() and not isinstance(value, float) else number


def _openrouter(payload: Any) -> dict | None:
    data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else payload
    data = data if isinstance(data, dict) else {}
    return {"quota": {k: _number(data.get(k)) for k in ("limit_remaining", "usage", "limit")}, "label": str(data.get("label") or "").strip() or None}


def _deepseek(payload: Any) -> dict | None:
    """Python `_sanitize_deepseek_balances`: CNY/USD rows with a total, plus the account's `is_available`."""
    if not isinstance(payload, dict) or not isinstance(payload.get("is_available"), bool):
        return None
    balances = []
    for row in payload.get("balance_infos") or []:
        if not isinstance(row, dict):
            continue
        currency = str(row.get("currency") or "").strip().upper()
        total = _number(row.get("total_balance"))
        if currency in {"CNY", "USD"} and total is not None:
            balances.append({"currency": currency, "total": total, "granted": _number(row.get("granted_balance")), "topped_up": _number(row.get("topped_up_balance"))})
    return {"balances": balances, "is_available": payload["is_available"]} if balances else None


def _opencode_go(payload: Any) -> dict | None:
    """Python `_sanitize_opencode_go_account_limits`: all three windows, each well-formed, or nothing."""
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        return None
    windows = []
    for key in ("rolling", "weekly", "monthly"):
        window = usage.get(key)
        if not isinstance(window, dict) or window.get("status") not in {"ok", "rate-limited"}:
            return None
        used = _number(window.get("percent"))
        try:
            reset_at = datetime.fromisoformat(str(window.get("resetsAt") or "").strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        if used is None or not 0 <= used <= 100:
            return None
        reset_at = reset_at if reset_at.tzinfo else reset_at.replace(tzinfo=timezone.utc)
        windows.append({"key": key, "used_percent": used, "reset_at": _iso(reset_at.timestamp()), "rate_limited": window["status"] == "rate-limited"})
    return {"windows": windows}


_BALANCE_PARSERS = {"openrouter": _openrouter, "deepseek": _deepseek, "opencode-go": _opencode_go}


def balance(provider: str, *, credential_id: str | None, api_key: str | None) -> dict:
    """One key-based balance read. A pool credential's key resolves here; otherwise the server passes the configured key."""
    result = {"status": "unavailable", "http_status": None, "quota": None, "label": None, "is_available": None, "balances": [], "windows": [], "matches_api_key": False}
    configured = str(api_key or "").strip()
    key = configured
    if credential_id:
        entry = _entry(provider, credential_id)
        key = _entry_key(entry) if entry is not None else ""
        result["matches_api_key"] = bool(key) and key == configured
    if not key:
        return {**result, "status": "no_key"}
    request = urllib.request.Request(_BALANCE_URLS[provider], headers={"Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": "Talaria-Web/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=_BALANCE_TIMEOUT_SECONDS) as response:
            raw = response.read(_BALANCE_MAX_BYTES + 1)
        if len(raw) > _BALANCE_MAX_BYTES:
            raise ValueError("oversized balance response")
        parsed = _BALANCE_PARSERS[provider](json.loads(raw.decode("utf-8")))
    except urllib.error.HTTPError as exc:
        return {**result, "status": "http_error", "http_status": exc.code}
    except (OSError, ValueError):  # URLError and timeouts are OSErrors; malformed JSON or UTF-8 are ValueErrors
        log.debug("%s balance read failed", provider, exc_info=True)
        return result
    return {**result, **parsed, "status": "ok"} if parsed is not None else result


def account(provider: str, *, base_url: str | None, api_key: str | None, credential_id: str | None = None) -> dict | None:
    if credential_id:
        # One pool account's usage: the Agent reads the usage of the credential it is handed.
        entry = _entry(provider, credential_id)
        if entry is None:
            return None
        api_key = _entry_key(entry)
        if not api_key:
            return {"provider": provider, "available": False, "unavailable_reason": "No runtime token available.", "windows": [], "details": []}
        base_url = str(getattr(entry, "runtime_base_url", None) or getattr(entry, "base_url", None) or "").strip() or base_url
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
    # The Agent's `available` is a property, which `_plain` (asdict/vars) never sees; read it off the snapshot.
    row["available"] = bool(getattr(snapshot, "available", row.get("available")))
    return row


def register(registry) -> None:
    @registry.method("usage.account")
    def account_(ctx: CallContext, params: dict) -> dict:
        provider = str(params.get("provider") or "").strip()
        if not provider:
            raise InvalidParams("provider is required")
        credential_id = str(params.get("credential_id") or "").strip() or None
        with scoped_home(profile_home_param(params)):
            return {"snapshot": account(provider, base_url=params.get("base_url"), api_key=params.get("api_key"), credential_id=credential_id)}

    @registry.method("usage.pool")
    def pool_(ctx: CallContext, params: dict) -> dict:
        provider = str(params.get("provider") or "").strip()
        if not provider:
            raise InvalidParams("provider is required")
        with scoped_home(profile_home_param(params)):
            return {"entries": pool(provider)}

    @registry.method("usage.pool_providers")
    def pool_providers_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"providers": pool_providers()}

    @registry.method("usage.balance")
    def balance_(ctx: CallContext, params: dict) -> dict:
        provider = str(params.get("provider") or "").strip()
        if provider not in _BALANCE_URLS:
            raise InvalidParams(f"provider must be one of {sorted(_BALANCE_URLS)}")
        credential_id = str(params.get("credential_id") or "").strip() or None
        with scoped_home(profile_home_param(params)):
            return balance(provider, credential_id=credential_id, api_key=params.get("api_key"))
