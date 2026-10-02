"""``process.*``: the Agent's background process registry (completion queue,
async delegation claims). The server keeps the WebUI session index and decides
routing; the sidecar drains and formats registry events."""

from __future__ import annotations

import logging
import queue

from ..errors import InvalidParams
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.process")


def _registry():
    try:
        from tools.process_registry import process_registry
    except Exception:  # noqa: BLE001
        return None
    return process_registry


def _event_row(evt: dict) -> dict:
    registry = _registry()
    row = {str(k): v for k, v in evt.items()} if isinstance(evt, dict) else {}
    process_id = str(row.get("delegation_id") or row.get("session_id") or row.get("task_id") or "") if row.get("type") == "async_delegation" else str(row.get("session_id") or "")
    row["process_id"] = process_id
    if registry is not None and process_id and (not row.get("session_key") or not row.get("origin_ui_session_id")):
        try:
            proc = registry.get(process_id)
        except Exception:  # noqa: BLE001
            proc = None
        if proc is not None:
            row.setdefault("session_key", str(getattr(proc, "session_key", "") or ""))
            if not row.get("origin_ui_session_id"):
                row["origin_ui_session_id"] = str(getattr(proc, "origin_ui_session_id", "") or "") or str(getattr(proc, "spawn_session_id", "") or "")
    try:
        row["consumed"] = bool(registry is not None and process_id and row.get("type") != "async_delegation" and registry.is_completion_consumed(process_id))
    except Exception:  # noqa: BLE001
        row["consumed"] = False
    return row


def drain(max_events: int) -> list[dict]:
    """Pop every queued completion event; the server requeues what it does not own."""
    registry = _registry()
    completion_queue = getattr(registry, "completion_queue", None) if registry is not None else None
    if completion_queue is None:
        return []
    out = []
    while len(out) < max_events:
        try:
            evt = completion_queue.get_nowait()
        except queue.Empty:
            break
        except Exception:  # noqa: BLE001
            log.debug("Failed to drain process completion queue", exc_info=True)
            break
        out.append(_event_row(evt))
    return out


def requeue(events: list[dict]) -> int:
    registry = _registry()
    completion_queue = getattr(registry, "completion_queue", None) if registry is not None else None
    if completion_queue is None:
        return 0
    count = 0
    for evt in events:
        try:
            completion_queue.put_nowait({k: v for k, v in evt.items() if k not in ("process_id", "consumed")})
            count += 1
        except Exception:  # noqa: BLE001
            log.debug("Failed to requeue process completion", exc_info=True)
    return count


def mark_consumed(process_id: str) -> bool:
    registry = _registry()
    if registry is None:
        return False
    try:
        with registry._lock:
            registry._completion_consumed.add(process_id)
        return True
    except Exception:  # noqa: BLE001
        return False


def _delivery_api():
    """The Agent's durable delivery ledger (``tools.async_delegation``), or None on an Agent without it."""
    try:
        from tools import async_delegation
    except Exception:  # noqa: BLE001
        return None
    names = ("claim_event_delivery", "complete_event_delivery", "release_event_delivery")
    return async_delegation if all(callable(getattr(async_delegation, n, None)) for n in names) else None


def _ledger_event(evt: dict) -> dict:
    return {k: v for k, v in evt.items() if k not in ("process_id", "consumed")}


def claim_delivery(evt: dict, consumer: str) -> str | None:
    """Claim a durable delegation completion before delivering it (TAL-459).

    ``None``: another consumer holds it, or the ledger already delivered or dropped it, so do not deliver.
    ``""``: nothing durable to acknowledge (interim notice, legacy event, or an Agent without the ledger)."""
    api = _delivery_api()
    if api is None:
        return ""
    claim_id = api.claim_event_delivery(_ledger_event(evt), consumer)
    return None if claim_id is None else str(claim_id)


def complete_delivery(evt: dict, claim_id: str) -> bool:
    api = _delivery_api()
    if api is None or not claim_id:
        return False
    api.complete_event_delivery(_ledger_event(evt), claim_id)
    return True


def release_delivery(evt: dict, claim_id: str) -> bool:
    api = _delivery_api()
    if api is None or not claim_id:
        return False
    api.release_event_delivery(_ledger_event(evt), claim_id)
    return True


def format_notification(evt: dict) -> str:
    if evt.get("type") == "async_delegation":
        try:
            from tools.process_registry import format_process_notification

            return format_process_notification(evt) or ""
        except Exception:  # noqa: BLE001
            return ""
    if evt.get("type") != "completion":
        return ""
    output = str(evt.get("output") or "")
    if len(output) > 4000:
        output = output[:4000] + "\n... (truncated)"
    return f"[IMPORTANT: Background process {evt.get('session_id', '')} completed (exit code {evt.get('exit_code', '')}).\nCommand: {evt.get('command', '')}\nOutput:\n{output}]"


def list_sessions() -> list[dict]:
    registry = _registry()
    if registry is None:
        return []
    out = []
    try:
        rows = registry.list_sessions()
    except Exception:  # noqa: BLE001
        return []
    for row in rows or []:
        if isinstance(row, dict):
            out.append({str(k): v for k, v in row.items()})
        elif hasattr(row, "__dict__"):
            out.append({k: v for k, v in vars(row).items() if not k.startswith("_") and isinstance(v, (str, int, float, bool, type(None)))})
    return out


def register(registry_) -> None:
    @registry_.method("process.drain")
    def drain_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"events": drain(int(params.get("max_events") or 256))}

    @registry_.method("process.requeue")
    def requeue_(ctx: CallContext, params: dict) -> dict:
        events = params.get("events")
        if not isinstance(events, list):
            raise InvalidParams("events must be a list")
        return {"requeued": requeue([e for e in events if isinstance(e, dict)])}

    @registry_.method("process.mark_consumed")
    def consumed(ctx: CallContext, params: dict) -> dict:
        process_id = str(params.get("process_id") or "").strip()
        if not process_id:
            raise InvalidParams("process_id is required")
        return {"ok": mark_consumed(process_id)}

    def _delivery_params(params: dict) -> dict:
        evt = params.get("event")
        if not isinstance(evt, dict):
            raise InvalidParams("event must be an object")
        return evt

    @registry_.method("process.claim_delivery")
    def claim_(ctx: CallContext, params: dict) -> dict:
        evt = _delivery_params(params)
        consumer = str(params.get("consumer") or "").strip()
        if not consumer:
            raise InvalidParams("consumer is required")
        with scoped_home(profile_home_param(params)):
            return {"claim_id": claim_delivery(evt, consumer)}

    @registry_.method("process.complete_delivery")
    def complete_(ctx: CallContext, params: dict) -> dict:
        evt = _delivery_params(params)
        with scoped_home(profile_home_param(params)):
            return {"ok": complete_delivery(evt, str(params.get("claim_id") or ""))}

    @registry_.method("process.release_delivery")
    def release_(ctx: CallContext, params: dict) -> dict:
        evt = _delivery_params(params)
        with scoped_home(profile_home_param(params)):
            return {"ok": release_delivery(evt, str(params.get("claim_id") or ""))}

    @registry_.method("process.format_notification")
    def format_(ctx: CallContext, params: dict) -> dict:
        evt = params.get("event")
        if not isinstance(evt, dict):
            raise InvalidParams("event must be an object")
        return {"text": format_notification(evt)}

    @registry_.method("process.list")
    def list_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"sessions": list_sessions()}
