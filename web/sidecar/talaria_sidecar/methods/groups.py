"""Closed native room operations. Attach only, with the Web principal's own grant."""
from __future__ import annotations

import asyncio
import json
from contextlib import suppress

from ..errors import InvalidParams
from ..home import profile_home_param
from .gateway_sessions import _connect, _owner_refusal, _with_owner

_FIELDS = {
    "capabilities": set(), "list": {"offset", "limit"}, "state": {"room_id", "include_disbanded"},
    "log": {"room_id", "since_seq", "limit"}, "create": {"room_id", "name", "members"},
    "rename": {"room_id", "event_id", "name"}, "disband": {"room_id", "cancel_id"},
    "send": {"room_id", "event_id", "payload"}, "stop": {"room_id", "cancel_id"},
    "retry": {"room_id", "member_id", "task_id", "execution_generation"},
    "discard": {"room_id", "member_id", "task_id", "execution_generation"},
    "approve": {"room_id", "member_id", "task_id", "execution_generation", "request_id", "choice"},
    "attachment.upload": {"room_id", "upload_id", "kind", "name", "mime", "data_base64"},
    "attachment.download": {"room_id", "event_id", "attachment_id"},
}
_READS = {"capabilities", "list", "state", "log", "attachment.download"}
_REFUSALS = {"permission_denied", "profile_mismatch", "invalid_params", "stale_generation", "unknown_execution",
             "unsupported_operation", "session_busy", "runtime_coordination_required"}


def _result(state, reason=None, value=None):
    return {"state": state, "reason": reason, "value": value}


async def _run(home, subject, operation, discovery, expected_room=None):
    from hermes_cli.gateway_client import GatewayRPCError
    action = operation["action"]
    method = "groups." + action
    dispatched = False
    try:
        if discovery.state != "ready":
            return _result("unavailable", "stopped")
        principal = 'auth:v1:' + json.dumps(['talaria', '', subject], separators=(',', ':'))
        async with _connect(home, discovery.endpoint, subject=principal) as (client, _):
            # A native 15 MB attachment expands to 20 MB on the wire. Keep the shared native client,
            # with a bounded receiver large enough for the owner's supported attachment envelope.
            client.websocket.protocol.max_size = 24 * 1024 * 1024
            described = await client.rpc("runtime.describe")
            if _owner_refusal(described, discovery.endpoint):
                return _result("unavailable", "unsupported")
            caps = await client.rpc("groups.capabilities")
            if (not isinstance(caps, dict) or type(caps.get("driver")) is not bool
                    or not isinstance(caps.get("methods"), list) or method not in caps["methods"]):
                return _result("unavailable", "unsupported")
            if not caps["driver"]:
                return _result("unavailable", "driver_inactive")
            if action == "capabilities":
                return _result("available", value=caps)
            if expected_room is not None:
                current = await client.rpc("groups.state", room_id=expected_room["room_id"], include_disbanded=True)
                room = current.get("room", {})
                if (room.get("room_id") != expected_room["room_id"]
                        or room.get("authority_gateway_id") != expected_room["gateway_id"]
                        or room.get("authority_epoch") != expected_room["authority_epoch"]):
                    return _result("refused", "refused")
            if action == "send":
                operation = {**operation, "payload": {**operation["payload"], "thread_id": operation["event_id"]}}
            dispatched = True
            value = await client.rpc(method, **{k: v for k, v in operation.items() if k != "action"}, _timeout=25)
            if not isinstance(value, dict) or len(json.dumps(value).encode()) > 24 * 1024 * 1024:
                return _result("unknown" if action not in _READS else "unavailable", "unknown")
            return _result("available", value=value)
    except GatewayRPCError as exc:
        reason = str(exc)
        # Native errors are data, never public diagnostics. Only fixed refusals prove non-admission.
        if reason in _REFUSALS:
            return _result("refused", "refused")
        if "method" in reason.lower() and not dispatched:
            return _result("unavailable", "unsupported")
        return _result("unknown" if dispatched and action not in _READS else "unavailable", "unknown")
    except Exception:  # noqa: BLE001 - a transport loss never authorizes automatic replay
        return _result("unknown" if dispatched and action not in _READS else "unavailable", "unknown")


async def _read(ctx, coroutine):
    task = asyncio.create_task(coroutine)
    try:
        while not task.done():
            await asyncio.wait({task}, timeout=.1)
            ctx.check_cancelled()
        return await task
    finally:
        if not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


def groups(ctx, params):
    operation, subject = params.get("operation"), params.get("subject")
    if (set(params) - {"profile_home", "subject", "operation", "expected_room"}
            or not {"profile_home", "subject", "operation"} <= set(params)
            or not isinstance(subject, str) or not 0 < len(subject) <= 128
            or not isinstance(operation, dict) or operation.get("action") not in _FIELDS
            or set(operation) - (_FIELDS[operation["action"]] | {"action"})):
        raise InvalidParams("invalid room operation")
    expected = params.get("expected_room")
    if expected is not None and (not isinstance(expected, dict)
            or set(expected) != {"room_id", "gateway_id", "authority_epoch"}
            or expected.get("room_id") != operation.get("room_id")
            or not isinstance(expected.get("gateway_id"), str)
            or type(expected.get("authority_epoch")) is not int):
        raise InvalidParams("invalid room authority fence")
    home = profile_home_param(params).resolve()
    ctx.check_cancelled()
    def run(discovery):
        coroutine = _run(home, subject, operation, discovery, expected)
        return _read(ctx, coroutine) if operation["action"] in _READS else coroutine
    result = _with_owner(home, run)
    if "value" not in result:
        return _result("unavailable", "stopped" if result["state"] == "stopped" else "unsupported"
                       if result["state"] == "incompatible" else "unavailable")
    return result
