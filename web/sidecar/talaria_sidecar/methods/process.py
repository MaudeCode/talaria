"""``process.*``: the Agent's background process registry (completion queue,
async delegation claims). The server keeps the WebUI session index and decides
routing; the sidecar drains and formats registry events."""

from __future__ import annotations

import json
import logging
import queue
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from ..errors import InvalidParams, RpcError
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
    try:
        # A recovered process has no reader thread; only this probe notices its exit and queues its completion (TAL-533).
        with registry._lock:
            detached = [s for s in registry._running.values() if getattr(s, "detached", False)]
        for session in detached:
            registry._refresh_detached_session(session)
    except Exception:  # noqa: BLE001
        log.debug("Failed to reconcile recovered processes", exc_info=True)
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


def consumed_ids(process_ids: list[str]) -> list[str]:
    """The processes the agent already holds from its own turn: consumed via wait/log, or observed exiting via poll.
    Checked at wakeup delivery, since the completion is usually drained before the agent's wait returns (TAL-532)."""
    registry = _registry()
    if registry is None:
        return []
    out = []
    for process_id in process_ids:
        try:
            if registry.is_completion_consumed(process_id) or process_id in (getattr(registry, "_poll_observed", None) or ()):
                out.append(process_id)
        except Exception:  # noqa: BLE001
            log.debug("Completion consumed check failed for %r", process_id, exc_info=True)
    return out


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


def defer_delivery(evt: dict, claim_id: str) -> bool:
    """Hand back a claim the target never admitted (its session was busy) without spending a delivery attempt;
    the Agent drops a row for good after its attempt budget, so a busy session must not burn it."""
    api = _delivery_api()
    if api is None or not claim_id:
        return False
    defer = getattr(api, "defer_completion_delivery", None)
    if not callable(defer) or evt.get("type") != "async_delegation" or not evt.get("delegation_id"):
        api.release_event_delivery(_ledger_event(evt), claim_id)
        return True
    defer(str(evt["delegation_id"]), claim_id)
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


_LEDGER_COLUMNS = "delegation_id, origin_ui_session_id, state, dispatched_at, completed_at, updated_at, task_json, result_json, event_json IS NOT NULL"
_LEDGER_LIMIT = 200


def _json(text) -> dict:
    try:
        value = json.loads(text) if text else {}
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _unit_goals(task: dict) -> list[str]:
    goals = task.get("goals") if isinstance(task.get("goals"), list) else None
    indexes = task.get("task_indexes") if isinstance(task.get("task_indexes"), list) else None
    if goals and indexes:
        return [str(goals[i]) for i in indexes if isinstance(i, int) and 0 <= i < len(goals)]
    if goals:
        return [str(g) for g in goals]
    return [str(task.get("goal") or "")]


def _child_statuses(result: dict) -> list[str]:
    """Per-subagent outcome of a finished unit: a batch carries ``results``, a single task is its own result."""
    if isinstance(result.get("results"), list):
        return [str(r.get("status") or "") for r in result["results"] if isinstance(r, dict)]
    return [str(result.get("status") or "")] if result else []


def _ledger_rows(home: Path, session_ids: list[str]) -> list[dict]:
    db_path = home / "state.db"
    if not db_path.exists() or not session_ids:
        return []
    marks = ",".join("?" * len(session_ids))
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)) as conn:
        try:
            rows = conn.execute(f"SELECT {_LEDGER_COLUMNS} FROM async_delegations WHERE origin_ui_session_id IN ({marks}) ORDER BY dispatched_at DESC LIMIT ?", [*session_ids, _LEDGER_LIMIT]).fetchall()
        except sqlite3.OperationalError:  # an Agent that never delegated has no ledger table yet
            return []
    out = []
    for delegation_id, origin, state, dispatched_at, completed_at, updated_at, task_json, result_json, has_event in rows:
        task, result = _json(task_json), _json(result_json)
        goals = _unit_goals(task)
        out.append({
            "delegation_id": delegation_id, "origin_ui_session_id": origin, "state": state, "dispatched_at": dispatched_at,
            "completed_at": completed_at, "updated_at": updated_at, "goals": goals,
            "child_statuses": _child_statuses(result), "has_result": bool(has_event),
        })
    return out


def _live_delegations() -> dict[str, dict]:
    try:
        from tools.async_delegation import list_async_delegations
        items = list_async_delegations()
    except Exception:  # noqa: BLE001 - an Agent without the live registry reports from the ledger alone
        return {}
    return {str(i.get("delegation_id")): {"status": str(i.get("status") or "")} for i in items if isinstance(i, dict) and i.get("delegation_id")}


def _owned_processes(session_ids: set[str]) -> list[dict]:
    """Notified or watched processes a WebUI session started (``session_key`` is the WebUI session id)."""
    registry = _registry()
    if registry is None:
        return []
    try:
        with registry._lock:
            sessions = [*registry._running.values(), *registry._finished.values()]
    except Exception:  # noqa: BLE001
        return []
    out = []
    for proc in sessions:
        if str(getattr(proc, "session_key", "") or "") not in session_ids:
            continue
        watched = bool(getattr(proc, "watch_patterns", None))
        if not (getattr(proc, "notify_on_complete", False) or watched):
            continue
        exited = bool(getattr(proc, "exited", False))
        out.append({
            "process_id": str(proc.id), "session_key": str(proc.session_key), "command": str(getattr(proc, "command", "") or "")[:200],
            "started_at": float(getattr(proc, "started_at", 0) or 0) or None, "exited": exited,
            "exited_at": float(getattr(proc, "exited_at", 0) or 0) or None, "exit_code": getattr(proc, "exit_code", None),
            "completion_reason": str(getattr(proc, "completion_reason", "") or ""), "watched": watched,
        })
    return out


_CHILD_WINDOW_S = 5


def _live_children() -> list[dict]:
    """Running subagents from the Agent's in-process registry: the only place a child's session id sits next to its
    delegation id. An Agent without the registry reports none."""
    try:
        from tools.delegate_tool_registry import _active_subagents, _active_subagents_lock
        with _active_subagents_lock:
            records = list(_active_subagents.values())
    except Exception:  # noqa: BLE001
        return []
    out = []
    for r in records:
        sid = getattr(r.get("agent"), "session_id", None)
        if isinstance(sid, str) and sid:
            out.append({"delegation_id": str(r.get("delegation_id") or ""), "goal": str(r.get("goal") or ""), "owner": str(r.get("owner_agent_session_id") or ""), "session_id": sid})
    return out


def _ledger_children(home: Path, owners: list[str]) -> list[dict]:
    """Finished subagents' own sessions in state.db: ``source = subagent`` rows tagged ``_delegate_from`` with their
    parent's session, each with its start time and first user message (the child's goal, sent verbatim)."""
    db_path = home / "state.db"
    if not db_path.exists() or not owners:
        return []
    marks = ",".join("?" * len(owners))
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)) as conn:
        try:
            # Only these chats' children: a long-lived profile keeps every subagent session it ever ran.
            rows = conn.execute(
                "SELECT s.id, s.model_config, s.started_at, (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id LIMIT 1)"
                f" FROM sessions s WHERE s.source = 'subagent' AND json_extract(s.model_config, '$._delegate_from') IN ({marks})", owners).fetchall()
        except sqlite3.OperationalError:
            return []
    out = []
    for sid, model_config, started_at, first in rows:
        owner = _json(model_config).get("_delegate_from")
        goal = _goal_text(first)
        if owner in owners and goal:
            out.append({"owner": owner, "session_id": sid, "started_at": started_at, "goal": goal})
    return out


_CONTENT_JSON_PREFIX = "\x00json:"
_IMAGE_HINTS = "\n\n[Image attached"


def _goal_text(content) -> str:
    """The goal a child was sent, from its stored first message: a task with images is stored as multimodal parts
    (native image input; the goal is the text part) or as the goal followed by image hints (text input)."""
    if not isinstance(content, str):
        return ""
    if content.startswith(_CONTENT_JSON_PREFIX):
        try:
            parts = json.loads(content[len(_CONTENT_JSON_PREFIX):])
        except ValueError:
            return ""
        texts = [p.get("text") for p in parts if isinstance(p, dict) and p.get("type") == "text"] if isinstance(parts, list) else []
        return str(texts[0]) if texts and texts[0] else ""
    return content.split(_IMAGE_HINTS, 1)[0]


def unit_children(unit: dict, owner: str, live: list[dict], finished: list[dict], now: float) -> list[dict]:
    """The subagent sessions one delegation unit ran, as ``{goal, session_id}`` per task, in task order. A live registry
    record is exact (same owner, the unit's call id, the task's goal) and is used once. Without one, finished sessions
    of that owner whose goal matches, started in the unit's window, count only when there are exactly as many as tasks
    with that goal; anything else stays unlinked rather than guessed."""
    unit_id, goals = unit["delegation_id"], [g for g in unit["goals"] if g]
    pool = [r for r in live if r["owner"] == owner and r["delegation_id"] and (unit_id == r["delegation_id"] or unit_id.startswith(f"{r['delegation_id']}-"))]
    linked: list[str | None] = []
    used: set[str] = set()
    for goal in goals:
        record = next((r for r in pool if r["goal"] == goal and r["session_id"] not in used), None)
        if record:
            used.add(record["session_id"])
        linked.append(record["session_id"] if record else None)
    start = (unit.get("dispatched_at") or 0) - _CHILD_WINDOW_S
    end = (unit.get("completed_at") or now) + _CHILD_WINDOW_S
    for goal in {g for g, sid in zip(goals, linked) if sid is None}:
        slots = [i for i, (g, sid) in enumerate(zip(goals, linked)) if g == goal and sid is None]
        matches = sorted((c for c in finished if c["owner"] == owner and c["goal"] == goal and c["session_id"] not in used and start <= (c["started_at"] or 0) <= end), key=lambda c: c["started_at"] or 0)
        if len(matches) == len(slots):
            for i, c in zip(slots, matches):
                linked[i] = c["session_id"]
    return [{"goal": g, "session_id": sid} for g, sid in zip(goals, linked) if sid]


def background_list(home: Path, session_ids: list[str]) -> dict:
    """TAL-372: what the Agent knows about the background work of these WebUI sessions: delegations from the durable
    ledger (with the live registry's status while they run) and notified processes from the process registry.
    TAL-494: each delegation also names the subagent sessions it ran."""
    live = _live_delegations()
    delegations = _ledger_rows(home, session_ids)
    live_children = _live_children()
    finished = _ledger_children(home, session_ids) if delegations else []
    now = time.time()
    for row in delegations:
        row["live_status"] = live.get(row["delegation_id"], {}).get("status")
        row["children"] = unit_children(row, row["origin_ui_session_id"], live_children, finished, now)
    return {"delegations": delegations, "processes": _owned_processes(set(session_ids))}


def delegation_result(home: Path, session_id: str, delegation_id: str) -> str:
    """The full result of a finished delegation unit, as the Agent words it for its own notification."""
    db_path = home / "state.db"
    if not db_path.exists():
        return ""
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)) as conn:
        try:
            row = conn.execute("SELECT event_json FROM async_delegations WHERE delegation_id = ? AND origin_ui_session_id = ?", (delegation_id, session_id)).fetchone()
        except sqlite3.OperationalError:
            return ""
    event = _json(row[0]) if row else {}
    return format_notification(event) if event else ""


def recover(base_home: Path) -> int:
    """TAL-533: re-adopt every profile's checkpointed processes when a sidecar starts, so a process in a profile nobody
    uses yet is watched (and its exit reported) from the start. Entering a home's scope recovers it once."""
    from hermes_cli.profiles import _PROFILE_ID_RE

    profiles_root = base_home / "profiles"
    named = sorted(p for p in profiles_root.iterdir() if p.is_dir() and _PROFILE_ID_RE.match(p.name)) if profiles_root.is_dir() else []
    for home in [base_home, *named]:
        try:
            with scoped_home(home):
                pass
        except RpcError:  # an Agent without profile isolation refuses named profiles; their processes stay unadopted
            log.warning("Background process recovery skipped for %s", home, exc_info=True)
    return 1 + len(named)


def register(registry_) -> None:
    @registry_.method("process.drain")
    def drain_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"events": drain(int(params.get("max_events") or 256))}

    @registry_.method("process.recover")
    def recover_(ctx: CallContext, params: dict) -> dict:
        return {"homes": recover(profile_home_param(params, "base_home"))}

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

    @registry_.method("process.consumed")
    def consumed_(ctx: CallContext, params: dict) -> dict:
        ids = params.get("process_ids")
        if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
            raise InvalidParams("process_ids must be a list of process ids")
        return {"consumed": consumed_ids(ids)}

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

    @registry_.method("process.defer_delivery")
    def defer_(ctx: CallContext, params: dict) -> dict:
        evt = _delivery_params(params)
        with scoped_home(profile_home_param(params)):
            return {"ok": defer_delivery(evt, str(params.get("claim_id") or ""))}

    @registry_.method("process.format_notification")
    def format_(ctx: CallContext, params: dict) -> dict:
        evt = params.get("event")
        if not isinstance(evt, dict):
            raise InvalidParams("event must be an object")
        return {"text": format_notification(evt)}

    def _session_ids(params: dict) -> list[str]:
        ids = params.get("session_ids")
        if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
            raise InvalidParams("session_ids must be a list of session ids")
        return ids

    @registry_.method("process.background_list")
    def background_list_(ctx: CallContext, params: dict) -> dict:
        ids = _session_ids(params)
        with scoped_home(profile_home_param(params)) as home:
            return background_list(home, ids)

    @registry_.method("process.delegation_result")
    def delegation_result_(ctx: CallContext, params: dict) -> dict:
        sid, did = str(params.get("session_id") or ""), str(params.get("delegation_id") or "")
        if not sid or not did:
            raise InvalidParams("session_id and delegation_id are required")
        with scoped_home(profile_home_param(params)) as home:
            return {"text": delegation_result(home, sid, did)}

    @registry_.method("process.list")
    def list_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"sessions": list_sessions()}
