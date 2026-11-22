"""``usage.*``: provider account usage through ``agent.account_usage``, the credential pool's local per-entry
state, and the key-based balance endpoints (TAL-548). Pool keys never leave the sidecar."""

from __future__ import annotations

import dataclasses
import hashlib
import hmac
import http.client
import json
import logging
import math
import secrets
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from typing import Any

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.usage")
_KEY_REVISION_SALT = secrets.token_bytes(32)


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


def _usable_key(value: Any) -> str:
    key = str(value or "").strip()
    return "" if key.startswith("op://") else key


def _configured_key(api_key: str | None, env_vars: list[str] | None) -> str:
    """Called only inside scoped_home: prefer an explicit key, else let the Agent resolve its secret sources."""
    if api_key:
        return _usable_key(api_key)
    if not env_vars:
        return ""
    from hermes_cli.config import get_env_value_prefer_dotenv as get_env

    for name in env_vars:
        key = _usable_key(get_env(name))
        if key:
            return key
    return ""


def pool(provider: str, *, api_key: str | None = None) -> list[dict]:
    """Python `_local_pool_snapshot` rows: one per pool entry with an id, its local status, whether it holds the
    profile-resolved configured key, and no secrets."""
    agent_pool, entries = _pool(provider)
    configured = _usable_key(api_key)
    rows = []
    for index, entry in enumerate(entries, start=1):
        credential_id = str(getattr(entry, "id", "") or "").strip()
        if not credential_id:
            continue
        row = {"credential_id": credential_id, "label": _label(entry, index), "status": "available", "unavailable_reason": None, "retry_after": None,
               "matches_api_key": bool(configured) and _entry_key(entry) == configured}
        status = str(getattr(entry, "last_status", "") or "").strip().lower()
        until = None
        if status == "exhausted":
            from agent.credential_pool import _exhausted_until

            until = _exhausted_until(entry, sole_credential=agent_pool._is_sole_credential())
        if status == "dead":
            row.update(status="dead", unavailable_reason="Credential permanently revoked or invalid.")
        elif until is not None and time.time() < until:
            retry_after = _iso(until)
            code = getattr(entry, "last_error_code", None)
            reason = "Credential pool marked this credential exhausted" + (f" after provider status {code}" if code else "") + (f"; retry after {retry_after}" if retry_after else "")
            row.update(status="exhausted", unavailable_reason=reason + ".", retry_after=retry_after)
        rows.append(row)
    return rows


def limits(providers: list[dict]) -> dict[str, dict]:
    """TAL-807: the Agent's ``CredentialPool.limit_state`` per pooled provider, ISO-dated, as its ``model.options`` attaches
    ``limit``: ``account`` when every live entry is benched, else ``models`` for the given models no usable entry can serve
    yet. A provider without a persisted pool or an unreadable pool says nothing."""
    try:
        from agent.credential_pool import load_pool
        from hermes_cli.auth import read_credential_pool
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"credential pool unavailable: {exc}", condition="usage_unavailable") from exc
    try:
        pooled = {str(slug) for slug, entries in (read_credential_pool() or {}).items() if entries}
    except Exception:  # noqa: BLE001
        log.debug("read_credential_pool() failed", exc_info=True)
        return {}
    out: dict[str, dict] = {}
    for row in providers:
        slug = str(row.get("slug") or "").strip()
        if slug not in pooled:
            continue
        try:
            state = load_pool(slug).limit_state([str(m) for m in row.get("models") or []])
        except Exception:  # noqa: BLE001 - one unreadable pool must not hide the others
            log.debug("limit_state(%r) failed", slug, exc_info=True)
            continue
        if not state:
            continue
        if state.get("scope") == "account":
            out[slug] = {"scope": "account", "resets_at": _iso(state["resets_at"])}
        elif state.get("models"):
            out[slug] = {"scope": "models", "models": {str(m): _iso(at) for m, at in state["models"].items()}}
    return out


_BALANCE_URLS = {
    "openrouter": "https://openrouter.ai/api/v1/key",
    "deepseek": "https://api.deepseek.com/user/balance",
    "opencode-go": "https://opencode.ai/zen/go/v1/usage",
    # TAL-1657: the Agent's commandcode-anthropic profile bills the same CommandCode account.
    "commandcode": "https://api.commandcode.ai/alpha/billing/credits",
    "commandcode-anthropic": "https://api.commandcode.ai/alpha/billing/credits",
}
_BALANCE_TIMEOUT_SECONDS = 15.0
_BALANCE_MAX_BYTES = 256 * 1024
# TAL-2188: a refusal's `error.code` the server can act on. Only these names leave the sidecar; the body never does.
_BALANCE_ERROR_CODES = frozenset({"api_key_expired"})
_BALANCE_ERROR_MAX_BYTES = 4 * 1024


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """A 3xx surfaces as an HTTPError: a bearer-authenticated quota read never resends its key to another URL."""

    def redirect_request(self, *args, **kwargs):
        return None


_open_balance = urllib.request.build_opener(_RefuseRedirects()).open


def _number(value: Any) -> int | float | None:
    """Python `_quota_number`, finite only: a NaN or infinity is not JSON, and an integer past float range reaches the
    server's `JSON.parse` as Infinity."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if abs(value) <= sys.float_info.max else None
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
        windows.append({"key": key, "used_percent": used, "reset_at": _iso(reset_at.timestamp()), "rate_limited": window["status"] == "rate-limited", "used": None, "limit": None})
    return {"windows": windows}


def _reset_at(value: Any) -> str | None:
    """Python `_usage_api_reset_at`: an ISO-8601 string (naive reads as UTC) or epoch seconds or milliseconds, else None,
    so a response never echoes free text."""
    try:
        if isinstance(value, str):
            moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00").replace("z", "+00:00"))
            return _iso((moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)).timestamp())
        epoch = _number(value) if isinstance(value, (int, float)) else None
        return None if epoch is None or epoch <= 0 else _iso(epoch / 1000 if epoch >= 1e12 else epoch)
    except (ValueError, OverflowError, OSError):
        return None


def _commandcode(payload: Any) -> dict | None:
    """Python `_sanitize_commandcode_quota`: each usable `windowLimits` window (a non-negative spend under a positive cap)
    and the remaining credits, else nothing."""
    limits = payload.get("windowLimits") if isinstance(payload, dict) else None
    if not isinstance(limits, dict):
        return None
    amount = lambda value: number if (number := _number(value)) is not None and number >= 0 else None  # noqa: E731
    windows = []
    for source, key in (("fiveHour", "five_hour"), ("weekly", "weekly")):
        window = limits.get(source)
        if not isinstance(window, dict):
            continue
        used, limit = amount(window.get("used", window.get("used_amount"))), amount(window.get("limit", window.get("limit_amount", window.get("cap"))))
        if used is None or not limit:
            continue
        windows.append({"key": key, "used_percent": min(100.0, used / limit * 100), "reset_at": _reset_at(window.get("reset_at", window.get("resetAt"))), "rate_limited": False, "used": used, "limit": limit})
    if not windows:
        return None
    credits = payload.get("credits") if isinstance(payload.get("credits"), dict) else {}
    parts = [part for key in ("monthlyCredits", "purchasedCredits", "freeCredits") if (part := amount(credits.get(key))) is not None]
    return {"windows": windows, "credits_remaining": _number(sum(parts)) if parts else None}  # a sum past float range is dropped


_BALANCE_PARSERS = {"openrouter": _openrouter, "deepseek": _deepseek, "opencode-go": _opencode_go, "commandcode": _commandcode, "commandcode-anthropic": _commandcode}


def _error_code(exc: urllib.error.HTTPError) -> str | None:
    """The allowlisted `error.code` of a small JSON refusal body, read under the request's socket deadline; else None."""
    try:
        raw = exc.read(_BALANCE_ERROR_MAX_BYTES + 1)
        payload = json.loads(raw.decode("utf-8")) if len(raw) <= _BALANCE_ERROR_MAX_BYTES else None
    except (OSError, ValueError, RecursionError, http.client.HTTPException):
        return None
    error = payload.get("error") if isinstance(payload, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    return code if isinstance(code, str) and code in _BALANCE_ERROR_CODES else None


def balance(provider: str, *, credential_id: str | None, api_key: str | None, env_vars: list[str] | None = None) -> dict:
    """One key-based balance read. A pool credential's key resolves here; otherwise resolve the configured key inside the profile scope."""
    result = {"status": "unavailable", "http_status": None, "error_code": None, "quota": None, "label": None, "is_available": None, "balances": [], "windows": [], "credits_remaining": None}
    key = ""
    if credential_id:
        entry = _entry(provider, credential_id)
        key = _usable_key(_entry_key(entry)) if entry is not None else ""
    else:
        key = _configured_key(api_key, env_vars)
    if not key:
        return {**result, "status": "no_key"}
    request = urllib.request.Request(_BALANCE_URLS[provider], headers={"Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": "Talaria-Web/1.0"})
    try:
        with _open_balance(request, timeout=_BALANCE_TIMEOUT_SECONDS) as response:
            raw = response.read(_BALANCE_MAX_BYTES + 1)
        if len(raw) > _BALANCE_MAX_BYTES:
            raise ValueError("oversized balance response")
        parsed = _BALANCE_PARSERS[provider](json.loads(raw.decode("utf-8")))
    except urllib.error.HTTPError as exc:
        with exc:
            return {**result, "status": "http_error", "http_status": exc.code, "error_code": _error_code(exc) if exc.code == 401 else None}
    except (OSError, ValueError, RecursionError, http.client.HTTPException):  # URLError and timeouts are OSErrors; malformed JSON or UTF-8 are ValueErrors; a non-HTTP or truncated answer is an HTTPException
        log.debug("%s balance read failed", provider, exc_info=True)
        return result
    return {**result, **parsed, "status": "ok"} if parsed is not None else result


# The Agent's Codex window order and labels (`agent.account_usage._codex_window_labels`): a published duration names the
# window, else its position does.
_CODEX_WINDOWS = (("primary_window", "Session"), ("secondary_window", "Weekly"))
_CODEX_LABELS_BY_SECONDS = {18000: "Session", 604800: "Weekly"}


def _duration(value: Any) -> int | float | None:
    """A provider-published window length: a finite positive JSON number, never a boolean or a numeric string."""
    seconds = _number(value) if isinstance(value, (int, float)) else None  # `_number` drops booleans, NaN and past-float integers
    return seconds if seconds is not None and seconds > 0 else None


def _backfill_codex_durations(windows: list[dict], raw: Any) -> None:
    """TAL-1125: give each Codex window the ``limit_window_seconds`` of its counterpart in the same usage response.

    The Agent's windows carry no duration, and it labels one it does not recognise (a 24-hour limit) by position, so
    both windows can read "Session". Rebuild the Agent's window list from ``raw`` and join by position, only where the
    labels agree; a mismatch leaves the duration unknown rather than handing one window's duration to another.
    """
    rate_limit = raw.get("rate_limit") if isinstance(raw, dict) else None
    if not isinstance(rate_limit, dict):
        return
    counterparts = []
    for key, positional in _CODEX_WINDOWS:
        window = rate_limit.get(key)
        if not isinstance(window, dict) or window.get("used_percent") is None:
            continue  # the Agent skips a window without usage
        seconds = _duration(window.get("limit_window_seconds"))
        counterparts.append((_CODEX_LABELS_BY_SECONDS.get(int(seconds), positional) if seconds is not None else positional, seconds))
    for window, (label, seconds) in zip(windows, counterparts):
        if _duration(window.get("limit_window_seconds")) is None and seconds is not None and str(window.get("label") or "").strip().lower() == label.lower():
            window["limit_window_seconds"] = seconds


def _own_plugin(provider: str) -> bool:
    """Whether the Agent's ``provider`` is an enabled plugin installed in the scoped home, so a process-wide registry never
    lends another profile's usage hook (and its sign-in) to this one. Listing first loads a plugin the launch skipped."""
    try:
        import providers as agent_providers

        from .providers import installed_plugin_profiles

        installed = [profile for _name, profile in installed_plugin_profiles() if profile is not None]
        profile = agent_providers.get_provider_profile(provider)
        return profile is not None and any(p is profile for p in installed)
    except Exception:  # noqa: BLE001 - an unverified owner cannot authorize a read
        log.debug("plugin ownership check for %r failed", provider, exc_info=True)
        return False


def account(provider: str, *, base_url: str | None, api_key: str | None, credential_id: str | None = None) -> dict | None:
    entry = None
    if credential_id:
        # One pool account's usage, read with that account's own key.
        entry = _entry(provider, credential_id)
        if entry is None:
            return None
        api_key = _entry_key(entry)
        if not api_key:
            return {"provider": provider, "available": False, "unavailable_reason": "No runtime token available.", "windows": [], "details": []}
        base_url = str(getattr(entry, "runtime_base_url", None) or getattr(entry, "base_url", None) or "").strip() or base_url
    try:
        from agent import account_usage as agent_usage
        from agent.account_usage import fetch_account_usage
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"account usage unavailable: {exc}", condition="usage_unavailable") from exc
    # The Agent's built-in fetchers skip the plugin owner check.
    if provider not in agent_usage._USAGE_FETCHERS and not _own_plugin(provider):
        # TAL-2187: any other provider reads through its plugin's own hook, and only this profile's plugin answers.
        return {"provider": provider, "available": False, "unavailable_reason": f"{provider} is not an enabled provider plugin in this profile.", "windows": [], "details": []}
    try:
        if entry is not None:
            # A display read never repairs the account: a rejected key reads as unavailable, never as a credential refresh.
            from agent.account_usage_cache import _identity_id_for

            snapshot = fetch_account_usage(provider, base_url=base_url, api_key=api_key, read_only=True, identity_id=_identity_id_for(provider, entry))
        else:
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
    # The provider's response body serves only the duration backfill; it never leaves the sidecar.
    raw = row.pop("raw", None)
    if provider == "openai-codex":
        _backfill_codex_durations(row["windows"], raw)
    row["details"] = list(row.get("details") or [])
    # A hosted plugin's snapshot crosses the Agent's plugin-host wire as a plain record (TAL-2187): its datetimes arrive
    # as opaque placeholders and its `available` property is gone, so both are read as unknown and recomputed.
    for holder, key in ((row, "fetched_at"), *((w, "reset_at") for w in row["windows"])):
        if key in holder and not isinstance(holder[key], (str, type(None))):
            holder[key] = None
    # The Agent's `available` is a property, which `_plain` (asdict/vars) never sees; read it off the snapshot.
    available = getattr(snapshot, "available", None)
    row["available"] = available if isinstance(available, bool) else bool(row["windows"] or row["details"]) and not row.get("unavailable_reason")
    return row


# TAL-2681: banked Codex usage-limit resets, read and spent through the Codex backend the Agent's `/usage reset` uses
# (`agent.account_usage._codex_backend_urls`), one chosen grant at a time, the way the Codex CLI's
# `consume_rate_limit_reset_credit_by_id` redeems one.
_CODEX = "openai-codex"
_CONSUME_CODES = frozenset({"reset", "nothing_to_reset", "no_credit", "already_redeemed"})


def _codex_account(credential_id: str | None):
    """``(token, base_url, account_id)`` of one Codex account: a pool account's own key and route, as its usage read uses
    them, else the account the Agent's own usage resolver picks. None when the account has no usable token."""
    from agent import account_usage as agent_usage

    if credential_id:
        entry = _entry(_CODEX, credential_id)
        key = _entry_key(entry) if entry is not None else ""
        if not key:
            return None
        base_url = str(getattr(entry, "runtime_base_url", None) or getattr(entry, "base_url", None) or "").strip() or None
        return agent_usage._resolve_codex_usage_credentials(base_url, key)
    try:
        return agent_usage._resolve_codex_usage_credentials(None, None)
    except Exception:  # noqa: BLE001 - no signed-in Codex account
        log.debug("Codex credential resolution failed", exc_info=True)
        return None


def _codex_json(url: str, headers: dict, body: dict | None = None) -> dict:
    """One bounded Codex backend call that never follows a redirect; raises like `balance` reads do."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method="GET" if data is None else "POST",
                                     headers={**headers, **({} if data is None else {"Content-Type": "application/json"})})
    with _open_balance(request, timeout=_BALANCE_TIMEOUT_SECONDS) as response:
        raw = response.read(_BALANCE_MAX_BYTES + 1)
    if len(raw) > _BALANCE_MAX_BYTES:
        raise ValueError("oversized Codex response")
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Codex response is not an object")
    return payload


def _text(value: Any, limit: int) -> str | None:
    return " ".join(value.split())[:limit] or None if isinstance(value, str) else None


def _reset_credit(row: Any) -> dict | None:
    """One provider grant with only its documented fields (`RateLimitResetCreditDetails`), times as ISO-8601 UTC."""
    credit_id = row.get("id") if isinstance(row, dict) else None
    if not isinstance(credit_id, str) or not credit_id.strip() or len(credit_id) > 256:
        return None
    return {"id": credit_id, "reset_type": _text(row.get("reset_type"), 64), "status": _text(row.get("status"), 32),
            "granted_at": _reset_at(row.get("granted_at")), "expires_at": _reset_at(row.get("expires_at")), "redeemed_at": _reset_at(row.get("redeemed_at")),
            "title": _text(row.get("title"), 200), "description": _text(row.get("description"), 500)}


def _credit_list(url: str, headers: dict) -> dict:
    payload = _codex_json(url, headers)
    rows = payload.get("credits") if isinstance(payload.get("credits"), list) else []
    count = payload.get("available_count")
    return {"available_count": count if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else None,
            "credits": [credit for credit in map(_reset_credit, rows) if credit is not None]}


def _redeemable(credit: dict) -> bool:
    expires = credit.get("expires_at")
    return credit.get("status") == "available" and (expires is None or datetime.fromisoformat(expires.replace("Z", "+00:00")).timestamp() > time.time())


def reset_credits(credential_id: str | None) -> dict:
    """The account's banked reset grants. A read: nothing is redeemed, refreshed or rotated."""
    result = {"status": "unavailable", "http_status": None, "available_count": None, "credits": []}
    account = _codex_account(credential_id)
    if account is None:
        return {**result, "status": "no_credentials"}
    from agent.account_usage import _codex_backend_urls, _codex_headers

    token, base_url, account_id = account
    try:
        return {**result, **_credit_list(_codex_backend_urls(base_url)[1], _codex_headers(token, account_id)), "status": "ok"}
    except urllib.error.HTTPError as exc:
        with exc:
            return {**result, "status": "http_error", "http_status": exc.code}
    except (OSError, ValueError, RecursionError, http.client.HTTPException):
        log.debug("Codex reset credit list failed", exc_info=True)
        return result


def redeem_reset_credit(credential_id: str | None, credit_id: str, redeem_request_id: str) -> dict:
    """Spend exactly ``credit_id`` of this account. The grant must be one of the account's own grants in a fresh list,
    so another account's grant is never sent, nor an unspent expired one. ``redeem_request_id`` is the caller's attempt
    id: retrying one attempt reuses it, and the backend answers ``already_redeemed`` instead of spending again. A grant
    the list already shows spent is sent only to replay its attempt this way: the pinned ``credit_id`` cannot spend
    another grant, and a confirmed replay still lifts the account's pool cooldown. An answer that never arrives (network
    loss, timeout, a 5xx) is ``unknown`` until the reread list shows the grant redeemed. ``credits`` is that reread, or
    null when it failed."""
    result = {"outcome": "unavailable", "http_status": None, "windows_reset": None, "credits": None}
    account = _codex_account(credential_id)
    if account is None:
        return {**result, "outcome": "no_credentials"}
    from agent.account_usage import _codex_backend_urls, _codex_headers

    token, base_url, account_id = account
    _usage, list_url, consume_url = _codex_backend_urls(base_url)
    headers = _codex_headers(token, account_id)
    try:
        before = _credit_list(list_url, headers)
    except urllib.error.HTTPError as exc:
        with exc:
            return {**result, "outcome": "refused", "http_status": exc.code}
    except (OSError, ValueError, RecursionError, http.client.HTTPException):
        log.debug("Codex reset credit list failed", exc_info=True)
        return result
    credit = next((c for c in before["credits"] if c["id"] == credit_id), None)
    if credit is None or not (_redeemable(credit) or credit.get("status") in {"redeeming", "redeemed"}):
        return {**result, "outcome": "not_found" if credit is None else "not_available", "credits": before}
    try:
        body = _codex_json(consume_url, headers, {"redeem_request_id": redeem_request_id, "credit_id": credit_id})
        code = str(body.get("code") or "").strip().lower()
        windows = body.get("windows_reset")
        result.update(outcome=code if code in _CONSUME_CODES else "unknown", windows_reset=windows if isinstance(windows, int) and not isinstance(windows, bool) and windows >= 0 else None)
    except urllib.error.HTTPError as exc:
        with exc:
            result.update(outcome="unknown" if exc.code >= 500 or exc.code == 408 else "refused", http_status=exc.code)
    except (OSError, ValueError, RecursionError, http.client.HTTPException):
        log.debug("Codex reset credit consume answer was lost", exc_info=True)
        result["outcome"] = "unknown"
    try:
        result["credits"] = _credit_list(list_url, headers)
    except (OSError, ValueError, RecursionError, http.client.HTTPException):  # an HTTPError is an OSError
        log.debug("Codex reset credit reread failed", exc_info=True)
    after = next((c for c in (result["credits"] or {}).get("credits", []) if c["id"] == credit_id), None)
    if result["outcome"] == "unknown" and after is not None and after.get("status") == "redeemed":
        result["outcome"] = "reset"
    if result["outcome"] in {"reset", "already_redeemed"}:
        # The Agent's own follow-up to a confirmed reset, this attempt's or a replayed one's: this account's pool entry
        # stops waiting out its old limit.
        try:
            from hermes_cli.auth import clear_codex_pool_quota_cooldowns

            clear_codex_pool_quota_cooldowns(token)
        except Exception:  # noqa: BLE001
            log.debug("clearing Codex pool cooldowns failed", exc_info=True)
    return result


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
            key = _configured_key(params.get("api_key"), params.get("env_vars"))
            return {"entries": pool(provider, api_key=key), "has_api_key": bool(key)}

    @registry.method("usage.pool_providers")
    def pool_providers_(ctx: CallContext, params: dict) -> dict:
        key_envs = params.get("key_envs") or {}
        if not isinstance(key_envs, dict) or not all(isinstance(pid, str) and isinstance(names, list) and all(isinstance(name, str) for name in names) for pid, names in key_envs.items()):
            raise InvalidParams("key_envs must map providers to environment variable names")
        with scoped_home(profile_home_param(params)):
            keys = {}
            for provider, names in key_envs.items():
                key = _configured_key(None, names)
                keys[provider] = {"present": bool(key), "revision": hmac.new(_KEY_REVISION_SALT, key.encode(), hashlib.sha256).hexdigest() if key else None}
            return {"providers": pool_providers(), "keys": keys}

    @registry.method("usage.limits")
    def limits_(ctx: CallContext, params: dict) -> dict:
        providers = params.get("providers")
        if not isinstance(providers, list) or not all(isinstance(p, dict) for p in providers):
            raise InvalidParams("providers must be a list of {slug, models}")
        with scoped_home(profile_home_param(params)):
            return {"limits": limits(providers)}

    @registry.method("usage.reset_credits")
    def reset_credits_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return reset_credits(str(params.get("credential_id") or "").strip() or None)

    @registry.method("usage.redeem_reset_credit")
    def redeem_reset_credit_(ctx: CallContext, params: dict) -> dict:
        credit_id = params.get("credit_id")
        request_id = params.get("redeem_request_id")
        if not isinstance(credit_id, str) or not credit_id.strip() or not isinstance(request_id, str) or not request_id.strip():
            raise InvalidParams("credit_id and redeem_request_id are required")
        with scoped_home(profile_home_param(params)):
            return redeem_reset_credit(str(params.get("credential_id") or "").strip() or None, credit_id, request_id)

    @registry.method("usage.balance")
    def balance_(ctx: CallContext, params: dict) -> dict:
        provider = str(params.get("provider") or "").strip()
        if provider not in _BALANCE_URLS:
            raise InvalidParams(f"provider must be one of {sorted(_BALANCE_URLS)}")
        credential_id = str(params.get("credential_id") or "").strip() or None
        with scoped_home(profile_home_param(params)):
            return balance(provider, credential_id=credential_id, api_key=params.get("api_key"), env_vars=params.get("env_vars"))
