"""``usage.*``: provider account usage through ``agent.account_usage``, the credential pool's local per-entry
state, and the key-based balance endpoints (TAL-548). Pool keys never leave the sidecar."""

from __future__ import annotations

import dataclasses
import functools
import hashlib
import hmac
import http.client
import inspect
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
    try:
        from hermes_cli.config import get_env_value_prefer_dotenv as get_env
    except ImportError:  # older Agents still resolve through the installed profile secret scope
        try:
            from agent.secret_scope import get_secret as get_env
        except ImportError:
            return ""
    for name in env_vars or []:
        key = _usable_key(get_env(name))
        if key:
            return key
    return ""


def pool(provider: str, *, api_key: str | None = None) -> list[dict]:
    """Python `_local_pool_snapshot` rows: one per pool entry with an id, its local status, whether it holds the
    profile-resolved configured key, and no secrets."""
    agent_pool, entries = _pool(provider)
    configured = _usable_key(api_key)
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
        row = {"credential_id": credential_id, "label": _label(entry, index), "status": "available", "unavailable_reason": None, "retry_after": None,
               "matches_api_key": bool(configured) and _entry_key(entry) == configured}
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


def limits(providers: list[dict]) -> dict[str, dict]:
    """TAL-807: the Agent's ``CredentialPool.limit_state`` per pooled provider, ISO-dated, as its ``model.options`` attaches
    ``limit``: ``account`` when every live entry is benched, else ``models`` for the given models no usable entry can serve
    yet. A provider without a persisted pool, an unreadable pool, or an Agent before v0.21.6 says nothing."""
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
            limit_state = getattr(load_pool(slug), "limit_state", None)
            state = limit_state([str(m) for m in row.get("models") or []]) if callable(limit_state) else None
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
}
_BALANCE_TIMEOUT_SECONDS = 15.0
_BALANCE_MAX_BYTES = 256 * 1024


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
        windows.append({"key": key, "used_percent": used, "reset_at": _iso(reset_at.timestamp()), "rate_limited": window["status"] == "rate-limited"})
    return {"windows": windows}


_BALANCE_PARSERS = {"openrouter": _openrouter, "deepseek": _deepseek, "opencode-go": _opencode_go}


def balance(provider: str, *, credential_id: str | None, api_key: str | None, env_vars: list[str] | None = None) -> dict:
    """One key-based balance read. A pool credential's key resolves here; otherwise resolve the configured key inside the profile scope."""
    result = {"status": "unavailable", "http_status": None, "quota": None, "label": None, "is_available": None, "balances": [], "windows": []}
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
        exc.close()
        return {**result, "status": "http_error", "http_status": exc.code}
    except (OSError, ValueError, http.client.HTTPException):  # URLError and timeouts are OSErrors; malformed JSON or UTF-8 are ValueErrors; a non-HTTP or truncated answer is an HTTPException
        log.debug("%s balance read failed", provider, exc_info=True)
        return result
    return {**result, **parsed, "status": "ok"} if parsed is not None else result


_ANTHROPIC_WINDOWS = (("five_hour", "Current session"), ("seven_day", "Current week"), ("seven_day_opus", "Opus week"), ("seven_day_sonnet", "Sonnet week"))


def _anthropic_usage(token: str):
    """The Agent's Anthropic account-usage read for one given token. An Agent before v0.21.6 reads only the ambient token,
    so a pool account would otherwise report the active account's limits."""
    # ponytail: mirrors agent.account_usage._fetch_anthropic_account_usage on the Agent's own helpers; TAL-351 drops it
    # once v0.21.6 is the oldest supported Agent.
    from agent import account_usage as agent_usage

    if not agent_usage._is_oauth_token(token):
        return agent_usage._snapshot("anthropic", "oauth_usage_api", [], [], unavailable_reason="Anthropic account limits are only available for OAuth-backed Claude accounts.")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json",
               "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0"}
    payload = agent_usage._get_json("https://api.anthropic.com/api/oauth/usage", headers, timeout=15.0)
    windows = agent_usage._usage_windows(payload, _ANTHROPIC_WINDOWS, "utilization", "resets_at", fraction=True)
    extra = payload.get("extra_usage") or {}
    used, limit = extra.get("used_credits"), extra.get("monthly_limit")
    details = [f"Extra usage: {used:.2f} / {limit:.2f} {extra.get('currency') or 'USD'}"] if extra.get("is_enabled") and agent_usage._is_num(used) and agent_usage._is_num(limit) else []
    return agent_usage._snapshot("anthropic", "oauth_usage_api", windows, details)


@functools.cache
def _reads_read_only(fetch) -> bool:
    """Agent v0.21.6+: ``fetch_account_usage(read_only=, identity_id=)`` reads one pool account without refreshing or
    rotating its credential, and every fetcher honours the explicit key. TAL-351 drops the check with the mirror."""
    try:
        return {"read_only", "identity_id"} <= inspect.signature(fetch).parameters.keys()
    except (TypeError, ValueError):
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
        from agent.account_usage import fetch_account_usage
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"account usage unavailable: {exc}", condition="usage_unavailable") from exc
    try:
        if entry is not None and _reads_read_only(fetch_account_usage):
            # A display read never repairs the account: a rejected key reads as unavailable, never as a credential refresh.
            from agent.account_usage_cache import _identity_id_for

            snapshot = fetch_account_usage(provider, base_url=base_url, api_key=api_key, read_only=True, identity_id=_identity_id_for(provider, entry))
        elif entry is not None and provider == "anthropic":
            snapshot = _anthropic_usage(api_key)
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

    @registry.method("usage.balance")
    def balance_(ctx: CallContext, params: dict) -> dict:
        provider = str(params.get("provider") or "").strip()
        if provider not in _BALANCE_URLS:
            raise InvalidParams(f"provider must be one of {sorted(_BALANCE_URLS)}")
        credential_id = str(params.get("credential_id") or "").strip() or None
        with scoped_home(profile_home_param(params)):
            return balance(provider, credential_id=credential_id, api_key=params.get("api_key"), env_vars=params.get("env_vars"))
