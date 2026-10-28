"""Safe, read-only account/handoff projection shared by OAuth and provider status.

The Agent owns the record and retry worker. This bounded display cache only retains a
confirmed view across read failures, keyed by the current profile and account.
"""
from __future__ import annotations

import hashlib
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

_LAST: OrderedDict[str, dict] = OrderedDict()
_LOCK = threading.RLock()
_STATES = {"idle", "pending", "retrying", "claimed", "gone", "failed", "paused"}
_ERRORS = {"client_not_allowed", "account_locked", "invalid_request", "retry_window_ended"}


def _identity(home: Path) -> tuple[str, str | None] | None:
    from hermes_cli.anon_auth import is_guest_state
    from hermes_cli.auth import get_provider_auth_state

    state = get_provider_auth_state("nous")
    if not isinstance(state, dict) or is_guest_state(state):
        return None
    return _token_identity(home, state.get("access_token"))


def _token_identity(home: Path, token: Any) -> tuple[str, str | None] | None:
    from hermes_cli.auth_constants import _decode_jwt_claims

    claims = _decode_jwt_claims(token)
    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject:
        return None
    identity = hashlib.sha256(f"{home.resolve()}\0{subject}".encode()).hexdigest()
    email = claims.get("email")
    if not isinstance(email, str) or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(email) > 254:
        return identity, None
    local, domain = email.rsplit("@", 1)
    return identity, f"{local[0]}***@{domain}"


def _apps(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return list(dict.fromkeys(v for v in value[:100] if isinstance(v, str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", v)))


def read(home: Path, completed: Any = None) -> dict | None:
    """One sequential read owner for flow/provider consumers, called under scoped_home."""
    with _LOCK:
        return _read(home, completed)


def _read(home: Path, completed: Any = None) -> dict | None:
    """No provisioning, refresh, drain, or retry dispatch."""
    try:
        from hermes_cli import guest_handoff as native
    except ImportError:
        return None  # older Agents keep generic success
    try:
        identity = _identity(home)
    except Exception:  # no current identity proof means no cached account may be displayed
        return None
    if identity is None:
        return None
    account_id, email = identity
    try:
        status = native.handoff_status()
        if status.get("state") == "idle" and completed is not None:
            status = getattr(completed, "handoff_status", None) or status
        state = status.get("state") if status.get("state") in _STATES else "unknown"
        # The public native read only fences *active* records. Prove terminal ownership
        # with the same native selector/binding helper before exposing any old app names.
        if state not in {"idle", "unknown", "paused"}:
            records = native._load(native._records_path())["records"].values()
            mine = [r for r in records if native._home_key() in r.get("profiles", ())]
            record = max(mine, key=lambda r: str(r.get("updated_at") or "")) if mine else None
            if record is not None and native._status_of(record) != status:
                raise RuntimeError("Native handoff changed during read")
            if record is None or native._account_bound_to(record) is None:
                state = "paused" if record else "unknown"
        safe = {"state": state, "account_email": email,
                "connectors_kind": status.get("connectors_kind") if status.get("connectors_kind") in {"moved", "swapped", "none", "conflict"} else None,
                "moved_toolkits": _apps(status.get("moved_toolkits")) if state == "claimed" else [],
                "dropped_toolkits": _apps(status.get("dropped_toolkits")) if state == "claimed" else [],
                "probably_moved": status.get("probably_moved") is True,
                "error": status.get("error") if status.get("error") in _ERRORS else None}
        lines = native.wire_status(safe)["lines"] if state != "unknown" else ["Connected-app transfer status is unknown."]
        if _identity(home) != identity:
            return None
        view = {"account_id": account_id, "email": email, "state": state, "lines": lines,
                "moved": safe["moved_toolkits"], "dropped": safe["dropped_toolkits"],
                "reconnect": safe["dropped_toolkits"],
                "poll_after": 5 if state in {"pending", "retrying", "unavailable"} else None}
        with _LOCK:
            _LAST[account_id] = view
            _LAST.move_to_end(account_id)
            while len(_LAST) > 32:
                _LAST.popitem(last=False)
        return view
    except Exception:  # raw native records and exception details never cross this boundary
        try:
            if _identity(home) != identity:
                return None
        except Exception:
            return None
        with _LOCK:
            previous = _LAST.get(account_id)
        return {**(previous or {"account_id": account_id, "email": email, "moved": [], "dropped": [], "lines": []}),
                "state": "unavailable", "reconnect": [], "poll_after": 5,
                "lines": [*(previous or {}).get("lines", []), "Connected-app transfer status is unavailable."]}


def connector_headers(home: Path, account_id: str, url: str) -> dict:
    """The native connector client reads this on every request, never provisioning or refreshing."""
    from tools.managed_gateway_auth import managed_gateway_auth_headers
    from tools.managed_tool_gateway import peek_nous_access_token

    def token():
        value = peek_nous_access_token()
        current, bearer = _identity(home), _token_identity(home, value)
        if current is None or bearer is None or current[0] != account_id or bearer[0] != account_id:
            return None
        return value

    return managed_gateway_auth_headers(url, token_reader=token)
