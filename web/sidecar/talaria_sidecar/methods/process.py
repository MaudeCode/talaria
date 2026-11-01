"""``process.*``: the Agent's background process registry (completion queue,
async delegation claims). The server keeps the WebUI session index and decides
routing; the sidecar drains and formats registry events."""

from __future__ import annotations

import json
import logging
import queue
import re
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import _PROCESS_HOME, _is_named_profile, profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.process")


def _registry():
    try:
        from tools.process_registry import process_registry
    except Exception:  # noqa: BLE001
        return None
    return process_registry


def _is_child_process(row: dict) -> bool:
    """TAL-933: a subagent's own process notice, which the server surfaces only when the owning profile opts in."""
    try:
        from tools.process_registry_notifications import is_child_process_notification
    except Exception:  # noqa: BLE001 - before Agent 0.21.7, the same rule inline
        if row.get("type") in ("async_delegation", "async_delegation_work_closeout"):
            return False
        return str(row.get("owner_task_id") or row.get("task_id") or "").startswith("sa-")
    return bool(is_child_process_notification(row))


def _event_row(evt: dict) -> dict:
    registry = _registry()
    row = {str(k): v for k, v in evt.items()} if isinstance(evt, dict) else {}
    process_id = str(row.get("delegation_id") or row.get("session_id") or row.get("task_id") or "") if row.get("type") == "async_delegation" else str(row.get("session_id") or "")
    row["process_id"] = process_id
    row["child_process"] = _is_child_process(row)
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
        # Only the exit is consumed by the agent's wait or log; a watch notice from the same process still wakes (TAL-724).
        row["consumed"] = bool(registry is not None and process_id and row.get("type") in (None, "completion") and registry.is_completion_consumed(process_id))
    except Exception:  # noqa: BLE001
        row["consumed"] = False
    return row


# Recovered sessions, held so their exit is seen even when an Agent call other than drain prunes them first.
_RECOVERED: dict[str, object] = {}
_RECOVERED_LOCK = threading.Lock()


def _reports_recovered_exits(registry) -> bool:
    """Agent 0.21.6 (hermes-agent 7550800d) closes or prunes a recovered session whose PID is gone without queuing a
    completion, since it never collected an exit status. Talaria still wakes the session with an unknown exit code."""
    return callable(getattr(registry, "_detached_host_fate", None)) and callable(getattr(registry, "_publish_finished", None))


def track_recovered(registry) -> None:
    if not _reports_recovered_exits(registry):
        return
    try:
        with registry._lock:
            detached = [s for s in registry._running.values() if getattr(s, "detached", False)]
    except Exception:  # noqa: BLE001 - recovery itself succeeded; only the exit report is lost
        log.warning("Failed to track recovered processes", exc_info=True)
        return
    with _RECOVERED_LOCK:
        _RECOVERED.update((s.id, s) for s in detached)


def _publish_recovered_exits(registry) -> None:
    with _RECOVERED_LOCK:
        exited = [s for s in _RECOVERED.values() if s.exited]
        for session in exited:
            del _RECOVERED[session.id]
    for session in exited:
        # A kill (or any path that collected a status) already queued its own completion through _move_to_finished.
        if session.exit_code is not None or getattr(session, "_finish_claimed", False):
            continue
        try:
            # Best effort, as in the Agent: a durable result must not block the live completion.
            from tools.process_registry_results import save_completed_result

            save_completed_result(session)
        except Exception:  # noqa: BLE001
            log.debug("Failed to retain the result of recovered process %s", session.id, exc_info=True)
        try:
            with registry._lock:
                registry._running.pop(session.id, None)
                session.exited_at = session.exited_at or time.time()
                registry._finished[session.id] = session
            registry._publish_finished(session, True)
        except Exception:  # noqa: BLE001 - retried on the next drain
            log.warning("Failed to report the exit of recovered process %s", session.id, exc_info=True)
            with _RECOVERED_LOCK:
                _RECOVERED.setdefault(session.id, session)


_COMPLETION_BASE_HOME: Path | None = None
_RESTORED_COMPLETION_HOMES: set[Path] = set()


def _completion_homes() -> list[Path]:
    from hermes_constants import get_hermes_home
    from .profiles import named_profile_homes

    homes = [_PROCESS_HOME, Path(get_hermes_home())]
    if _COMPLETION_BASE_HOME is not None:
        # The server drains one global queue. Re-enumerate so new profiles join and removed/escaped ones leave.
        homes += [_COMPLETION_BASE_HOME, *(home for _, home in named_profile_homes(_COMPLETION_BASE_HOME))]
    return list(dict.fromkeys(home.resolve() for home in homes))


def _restore_and_sweep_completions(registry) -> None:
    from tools import async_delegation

    restore = getattr(registry, "restore_completions", None)
    if not callable(restore):
        return  # Older Agents already restore at registry import and have no orphan sweep.
    # The Agent binds the launch home itself, even when the first drain is in a named profile.
    restore()
    for home in _completion_homes():
        try:
            with scoped_home(home):
                if _is_named_profile(home) and home not in _RESTORED_COMPLETION_HOMES:
                    async_delegation.restore_undelivered_completions(registry.completion_queue)
                    _RESTORED_COMPLETION_HOMES.add(home)
                sweep = getattr(async_delegation, "maybe_sweep_orphaned_completions", None)
                if callable(sweep):
                    sweep(registry.completion_queue)
        except Exception:  # noqa: BLE001 - retry this home without blocking other profiles or queued events
            log.debug("Failed to restore or sweep delegation completions for %s", home, exc_info=True)


def _open_ledger(home: Path):
    """A read-only connection to the profile's ``state.db``, or None when it does not exist: a read never creates it.
    ``as_uri`` percent-encodes the path, so a ``%`` or ``#`` in a profile home cannot re-address the read."""
    db_path = home / "state.db"
    if not db_path.exists():
        return None
    return closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=5))


_DELIVERY_RECONCILE_INTERVAL_S = 30
_LAST_DELIVERY_RECONCILE: dict[Path, float] = {}
_DELIVERY_RECONCILE_CURSOR: dict[Path, str] = {}
_DELIVERY_RECONCILE_PAGE_SIZE = 200


def _delivered_notifications(home: Path, delegation_id: str | None = None, after: str = "") -> tuple[list[dict], str]:
    """Only typed transcript deliveries, never every delivered ledger row. No Agent state is changed."""
    ledger = _open_ledger(home)
    if ledger is None:
        return [], ""
    with ledger as conn:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"async_delegations", "messages", "sessions"} <= tables:
            return [], ""
        rows = conn.execute("""WITH RECURSIVE candidates AS (
            SELECT delegation_id, origin_ui_session_id, parent_session_id, origin_session_id, event_json
            FROM async_delegations WHERE delivery_state='delivered' AND state NOT IN ('running','finalizing')
            AND event_json IS NOT NULL AND origin_ui_session_id != '' AND delivered_at >= ?
            AND (? IS NULL OR delegation_id=?) AND delegation_id > ?
        ), lineage(delegation_id, id) AS (
            SELECT delegation_id, parent_session_id FROM candidates WHERE parent_session_id != ''
            UNION SELECT delegation_id, origin_session_id FROM candidates WHERE origin_session_id != ''
            UNION SELECT l.delegation_id, s.id FROM lineage l
                JOIN sessions parent ON parent.id=l.id AND parent.end_reason='compression'
                JOIN sessions s ON s.parent_session_id=l.id
        ) SELECT DISTINCT c.delegation_id, c.origin_ui_session_id, c.event_json
        FROM candidates c JOIN lineage l ON l.delegation_id=c.delegation_id
        JOIN messages m ON m.session_id=l.id
        WHERE m.role='user' AND m.display_kind='async_delegation_complete'
        AND json_valid(m.display_metadata)
        AND json_extract(m.display_metadata, '$.delegation_id')=c.delegation_id
        AND coalesce(json_extract(m.display_metadata, '$.delivery_notice'), '')=''
        AND coalesce(json_extract(m.display_metadata, '$.presentation_suppressed'), 0)=0
        ORDER BY c.delegation_id LIMIT ?""", (time.time() - 48 * 3600, delegation_id, delegation_id, after, _DELIVERY_RECONCILE_PAGE_SIZE)).fetchall()
    events = []
    for did, owner, payload in rows:
        event = _json(payload)
        if event.get("type") != "async_delegation" or event.get("delegation_id") != did or event.get("origin_ui_session_id") != owner or event.get("task_failure_notice"):
            continue
        events.append({**event, "reconciliation_profile_home": str(home.resolve())})
    return events, rows[-1][0] if len(rows) == _DELIVERY_RECONCILE_PAGE_SIZE else ""


def _reconcile_delivered_notifications() -> list[dict]:
    out = []
    for home in _completion_homes():
        now = time.monotonic()
        if now - _LAST_DELIVERY_RECONCILE.get(home, -float("inf")) < _DELIVERY_RECONCILE_INTERVAL_S:
            continue
        try:
            events, cursor = _delivered_notifications(home, after=_DELIVERY_RECONCILE_CURSOR.get(home, ""))
            out.extend(events)
            _DELIVERY_RECONCILE_CURSOR[home] = cursor
            _LAST_DELIVERY_RECONCILE[home] = now
        except Exception:  # retry unreadable homes; never block live queue delivery
            log.warning("Failed to reconcile typed delegation deliveries for %s", home, exc_info=True)
    return out


def drain(max_events: int) -> list[dict]:
    """Pop every queued completion event; the server requeues what it does not own."""
    registry = _registry()
    completion_queue = getattr(registry, "completion_queue", None) if registry is not None else None
    if completion_queue is None:
        return []
    try:
        _restore_and_sweep_completions(registry)
    except Exception:  # noqa: BLE001 - maintenance must not prevent delivery of live queued events
        log.debug("Failed to reconcile delegation completions", exc_info=True)
    try:
        # A recovered process has no reader thread; only this probe notices its exit and queues its completion (TAL-533).
        with registry._lock:
            detached = [s for s in registry._running.values() if getattr(s, "detached", False)]
        for session in detached:
            registry._refresh_detached_session(session)
        _publish_recovered_exits(registry)
    except Exception:  # noqa: BLE001
        log.debug("Failed to reconcile recovered processes", exc_info=True)
    # Use the existing queue and its bound, so reconciliation cannot starve live or foreign events.
    try:
        for event in _reconcile_delivered_notifications():
            completion_queue.put_nowait(event)
    except Exception:
        log.warning("Failed to offer typed delegation deliveries", exc_info=True)
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
            completion_queue.put_nowait({k: v for k, v in evt.items() if k not in ("process_id", "consumed", "child_process")})
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
    """The processes whose full result the agent already consumed via wait/log in its own turn.
    Checked at wakeup delivery, since the completion is usually drained before the agent's wait returns (TAL-532).
    A poll preview carries only a short tail, so it leaves the full completion to the wakeup (TAL-1560)."""
    registry = _registry()
    if registry is None:
        return []
    out = []
    for process_id in process_ids:
        try:
            if registry.is_completion_consumed(process_id):
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
    if claim_id is None and consumer == "webui" and evt.get("origin_ui_session_id"):
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home()).resolve()
        if evt.get("reconciliation_profile_home", str(home)) == str(home):
            # A live queue copy can race the transcript-only consumer too. Recheck the same proof here.
            transport = {"process_id", "consumed", "child_process", "restored", "startup_replay", "reconciliation_profile_home"}
            for candidate in _delivered_notifications(home, str(evt.get("delegation_id") or ""))[0]:
                if {k: v for k, v in candidate.items() if k not in transport} == {k: v for k, v in evt.items() if k not in transport}:
                    return ""  # Web's session receipt acknowledges this admission, not the Agent ledger.
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
    if evt.get("type") in ("async_delegation", "heartbeat", "watch_match", "watch_disabled", "watch_overflow_tripped", "watch_overflow_released"):
        try:
            from tools import process_registry

            # Older formatters fall through unknown events to an exit notification.
            if evt.get("type") == "heartbeat" and not callable(getattr(getattr(process_registry, "ProcessRegistry", None), "_emit_heartbeat", None)):
                return ""
            return process_registry.format_process_notification(evt) or ""
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
    ledger = _open_ledger(home) if session_ids else None
    if ledger is None:
        return []
    marks = ",".join("?" * len(session_ids))
    with ledger as conn:
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
    return {str(i.get("delegation_id")): i for i in items if isinstance(i, dict) and i.get("delegation_id")}


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


def _ledger_children(home: Path, owners: list[str], dispatched_at: float) -> list[dict]:
    """Finished subagents' own sessions in state.db: ``source = subagent`` rows tagged ``_delegate_from`` with their
    parent's session, each with its start time and first user message (the child's goal, sent verbatim)."""
    ledger = _open_ledger(home) if owners else None
    if ledger is None:
        return []
    marks = ",".join("?" * len(owners))
    with ledger as conn:
        try:
            # Bound history before parsing owner JSON; allow 60 seconds of dispatch/start clock skew.
            rows = conn.execute(
                "SELECT s.id, s.model_config, s.started_at, (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id LIMIT 1)"
                f" FROM sessions s WHERE s.source = 'subagent' AND s.started_at >= ? AND json_extract(s.model_config, '$._delegate_from') IN ({marks})",
                [dispatched_at - 60, *owners]).fetchall()
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
            from hermes_state import SessionDB
            decode = getattr(SessionDB, "_decode_content", None)
        except ImportError:
            decode = None
        if callable(decode):
            content = decode(content)
        else:
            try:
                content = json.loads(content[len(_CONTENT_JSON_PREFIX):])
            except ValueError:
                pass  # Legacy malformed marker rows remain literal text, as in the Agent.
    if isinstance(content, list):
        texts = [p.get("text") for p in content if isinstance(p, dict) and p.get("type") == "text"]
        return str(texts[0]) if texts and texts[0] else ""
    return content.split(_IMAGE_HINTS, 1)[0] if isinstance(content, str) else ""


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
    finished = _ledger_children(home, session_ids, min(row["dispatched_at"] for row in delegations)) if delegations else []
    now = time.time()
    for row in delegations:
        row["live_status"] = live.get(row["delegation_id"], {}).get("status")
        row["children"] = unit_children(row, row["origin_ui_session_id"], live_children, finished, now)
    return {"delegations": delegations, "processes": _owned_processes(set(session_ids))}


def delegation_result(home: Path, session_id: str, delegation_id: str) -> str:
    """The full result of a finished delegation unit, as the Agent words it for its own notification."""
    ledger = _open_ledger(home)
    if ledger is None:
        return ""
    with ledger as conn:
        try:
            row = conn.execute("SELECT event_json FROM async_delegations WHERE delegation_id = ? AND origin_ui_session_id = ?", (delegation_id, session_id)).fetchone()
        except sqlite3.OperationalError:
            return ""
    event = _json(row[0]) if row else {}
    return format_notification(event) if event else ""


_DELEGATION_LIVE = ("running", "stalling", "finalizing")
# Every state the Agent finalizes a unit into; each keeps delivery_state='pending' until its completion is delivered.
_DELEGATION_TERMINAL = ("completed", "error", "interrupted", "cancelled", "stalled", "unknown")


def _delegation_counts(home: Path, session_id: str) -> tuple[int, int] | None:
    """``(running, awaiting_delivery)`` over every ledger row of this WebUI session, independent of the listed-row cap.
    None when the ledger cannot be read (unreadable, corrupt, no ledger table): unknown, never zero. No state.db at all
    is a truthful zero: this profile never recorded a delegation."""
    try:
        # Path.exists() also hides a permission error; only a definitely absent file is a zero.
        (home / "state.db").stat()
    except FileNotFoundError:
        return 0, 0
    except OSError:
        log.debug("Delegation ledger inaccessible for %s", home, exc_info=True)
        return None
    try:
        ledger = _open_ledger(home)
        if ledger is None:  # removed since the stat: unknown rather than a guess
            return None
        with ledger as conn:
            live, terminal = ",".join("?" * len(_DELEGATION_LIVE)), ",".join("?" * len(_DELEGATION_TERMINAL))
            running, awaiting = conn.execute(
                f"SELECT count(*) FILTER (WHERE state IN ({live})), count(*) FILTER (WHERE state IN ({terminal}) AND delivery_state = 'pending')"
                " FROM async_delegations WHERE origin_ui_session_id = ?", [*_DELEGATION_LIVE, *_DELEGATION_TERMINAL, session_id]).fetchone()
    except (OSError, sqlite3.Error):
        log.debug("Delegation ledger unreadable for %s", home, exc_info=True)
        return None
    return int(running), int(awaiting)


def _memory_live(session_id: str) -> bool | None:
    """Whether this process's live delegation registry holds running work for the session; None when it cannot say."""
    try:
        from tools.async_delegation import has_live_for_session
        return bool(has_live_for_session(origin_ui_session_id=session_id))
    except Exception:  # noqa: BLE001 - an absent or failing registry is unknown, never "nothing running"
        log.debug("Live delegation probe failed", exc_info=True)
        return None


def delegation_status(home: Path, session_id: str) -> dict:
    """TAL-1579: counts only (no goals, results or events) of one WebUI session's delegations: still running, and finished
    with a completion not yet delivered. Read-only: nothing is claimed, consumed or acknowledged."""
    counts = _delegation_counts(home, session_id)
    return {
        "ledger": "unknown" if counts is None else "available",
        "running_count": None if counts is None else counts[0],
        "awaiting_delivery_count": None if counts is None else counts[1],
        "memory_live": _memory_live(session_id),
    }


def recover(base_home: Path) -> int:
    """TAL-533: re-adopt every profile's checkpointed processes when a sidecar starts, so a process in a profile nobody
    uses yet is watched (and its exit reported) from the start. Entering a home's scope recovers it once; a failed
    recovery fails the call, so the server retries."""
    from .profiles import named_profile_homes

    global _COMPLETION_BASE_HOME
    _COMPLETION_BASE_HOME = base_home
    named = [home for _, home in named_profile_homes(base_home)]
    failed = []
    for home in [base_home, *named]:
        try:
            with scoped_home(home):
                pass
        except RpcError as exc:
            if exc.data.get("condition") != "agent_incompatible":
                failed.append(str(exc))
                continue
            # An Agent without profile isolation refuses named profiles for good; their processes stay unadopted.
            log.warning("Background process recovery skipped for %s", home, exc_info=True)
    if failed:
        raise RpcError("; ".join(failed))
    return 1 + len(named)


def stop(home: Path, session_id: str, process_id: str) -> str:
    """Request cancellation only for work this profile/session owns; let Agent completions settle its row."""
    registry = _registry()
    proc = registry.get(process_id) if registry is not None else None
    if proc is not None:
        if str(getattr(proc, "session_key", "") or "") != session_id:
            return "not_found"
        if proc.exited:
            return "not_running"
        # Keep the completion visible to the parent, just like other autonomous exits.
        result = registry.kill_process(process_id, consume_output=False)
        if result.get("status") == "error" or result.get("error"):
            raise RpcError(str(result.get("error") or "Process could not be stopped"))
        if result.get("status") == "killed":
            return "stopped"
        if result.get("completion_reason") == "already_exited" or result.get("status") == "already_exited":
            return "not_running"
        raise RpcError("Process stop was not confirmed")

    row = next((r for r in _ledger_rows(home, [session_id]) if r["delegation_id"] == process_id), None)
    if row is None:
        return "not_found"
    if row["state"] not in {"running", "stalling", "finalizing"}:
        return "not_running"
    from tools.delegate_tool_registry import interrupt_subagent, list_active_subagents

    live = _live_delegations().get(process_id)
    if not live or live.get("origin_ui_session_id") != session_id:
        return "not_running"
    indexes = live.get("task_indexes")
    # Independent-completion units are <call-id>-<unit-number>; slot_key is the first unit, not the call.
    split = re.fullmatch(r"(.+)-[1-9][0-9]*", process_id) if indexes is not None else None
    if indexes is not None and split is None:
        raise RpcError("Delegation unit identity could not be confirmed")
    call_id = split[1] if split else process_id
    # The dispatch parent is the Agent execution id; compression can rotate it away from the stable Web id.
    owner_id = live.get("parent_session_id") or session_id

    def belongs(child: dict) -> bool:
        if child.get("delegation_id") != call_id or child.get("owner_agent_session_id") != owner_id:
            return False
        # Split units share a call id; Agent subagent ids encode their original task index.
        index = re.fullmatch(r"sa-(\d+)-[a-zA-Z0-9]+", str(child.get("subagent_id") or ""))
        return indexes is None or (index is not None and int(index[1]) in indexes)

    children = [r for r in list_active_subagents() if belongs(r)]
    if not children:
        return "not_running"
    interrupted = [interrupt_subagent(r["subagent_id"]) for r in children]
    if not all(interrupted):
        raise RpcError("Some subagents could not be interrupted; refresh and retry")
    return "stopped"


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
            claim = claim_delivery(evt, consumer)
            result = {"claim_id": claim}
            if claim is None:
                api = _delivery_api()
                lookup = getattr(api, "get_durable_delegation", None)
                row = lookup(str(evt.get("delegation_id") or "")) if callable(lookup) else None
                if row and row.get("delivery_state") == "pending":
                    result["retryable"] = True
            return result

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

    @registry_.method("process.delegation_status")
    def delegation_status_(ctx: CallContext, params: dict) -> dict:
        sid = params.get("session_id")
        if not isinstance(sid, str) or not sid.strip():
            raise InvalidParams("session_id is required")
        # Read-only binding: no credential hydration, terminal defaults or process recovery for a status read.
        with scoped_home(profile_home_param(params), read_only=True) as home:
            return delegation_status(home, sid)

    @registry_.method("process.stop")
    def stop_(ctx: CallContext, params: dict) -> dict:
        sid, pid = params.get("session_id"), params.get("process_id")
        if not isinstance(sid, str) or not sid.strip() or not isinstance(pid, str) or not pid.strip():
            raise InvalidParams("session_id and process_id are required")
        with scoped_home(profile_home_param(params)) as home:
            return {"outcome": stop(home, sid, pid)}

    @registry_.method("process.list")
    def list_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"sessions": list_sessions()}
