"""TAL-2684: the canonical Bot Chat's unsettled teammate deliveries, read through its profile's native owner.

Only the profile's own canonical Bot Chat gets an answer, and only from the Agent's read-only ``bot_delivery.list``
(v0.23.3), which lists the connection's own profile as the sender. Nothing here writes, dismisses or resends a delivery.
"""
from __future__ import annotations

from ..errors import InvalidParams
from ..home import profile_home_param
from .gateway_sessions import _connect, _owner_refusal, _served, _with_owner
from .groups import _read
from .profiles import canonical_bot_chat

# The native row states (``tui_gateway/contracts/groups_bot_relay.py::BotDeliveryState``); the server maps them.
_STATES = {"queued", "claimed", "working", "waiting_on_you", "failed"}
_UNKNOWN_METHOD = -32601


def _result(state: str, reason: str | None = None, deliveries: list | None = None) -> dict:
    return {"state": state, "reason": reason, "deliveries": deliveries or []}


def _text(value) -> str:
    return value if isinstance(value, str) else ""


def _rows(value) -> list[dict] | None:
    """The owner's rows through a closed allowlist; None when the answer is not a delivery list."""
    rows = value.get("deliveries") if isinstance(value, dict) else None
    if not isinstance(rows, list):
        return None
    out = []
    for row in rows:
        if not (isinstance(row, dict) and isinstance(row.get("delivery_id"), str) and row["delivery_id"]
                and row.get("state") in _STATES and type(row.get("since")) in (int, float)):
            return None
        waiting_on = row.get("waiting_on")
        out.append({"delivery_id": row["delivery_id"], "target": _text(row.get("target")), "target_handle": _text(row.get("target_handle")),
                    "state": row["state"], "since": float(row["since"]), "preview": _text(row.get("preview")),
                    "waiting_on": waiting_on if isinstance(waiting_on, str) and waiting_on else None})
    return out


async def _list(home, discovery) -> dict:
    from hermes_cli.gateway_client import GatewayRPCError

    endpoint = discovery.endpoint
    if discovery.state != "ready":
        return _result("unavailable", "gateway_restarting")
    if _served(home, endpoint, allow_verified=True):
        return _result("unsupported", "served_profile_unverified")
    try:
        async with _connect(home, endpoint) as (client, _):
            if _owner_refusal(await client.rpc("runtime.describe"), endpoint):
                return _result("unsupported", "owner_capabilities")
            value = await client.rpc("bot_delivery.list")
    except GatewayRPCError as exc:
        # An owner older than v0.23.3 has no such method; any other refusal (storage busy, restarting) is transient.
        if getattr(exc, "code", None) == _UNKNOWN_METHOD or str(exc) == "unknown_method":
            return _result("unsupported", "agent_unsupported")
        return _result("unavailable", "owner_refused")
    rows = _rows(value)
    return _result("available", deliveries=rows) if rows is not None else _result("unavailable", "owner_invalid")


def bot_deliveries(ctx, params: dict) -> dict:
    session_id = params.get("session_id")
    if set(params) - {"profile_home", "session_id"} or not isinstance(session_id, str) or not session_id:
        raise InvalidParams("profile_home and session_id are required")
    home = profile_home_param(params).resolve()
    canonical = canonical_bot_chat(home)
    if canonical is None or session_id not in {canonical["session_id"], canonical["tip_session_id"]}:
        return _result("not_bot_chat")
    ctx.check_cancelled()
    result = _with_owner(home, lambda discovery: _read(ctx, _list(home, discovery)))
    if "deliveries" not in result:  # ``_with_owner``'s own answer: no attachable owner, or the connection was lost
        return _result("stopped" if result["state"] == "stopped" else "unavailable", result.get("reason"))
    return result
