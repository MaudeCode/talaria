"""TAL-2664: plugin idle tasks (``ctx.register_idle_task``, Agent v0.23.2+): list them and pause or resume one from Web.

``plugins.idle_tasks`` reads the active profile's tasks through the Agent's own enumeration: the persisted state
``hermes plugins idle-tasks`` lists, plus each task the profile's loaded plugins registered that no owner has seeded yet.
``plugins.idle_task_set_paused`` finds the task in that same enumeration (never a caller's path), writes ``paused``
through the Agent's ``set_paused`` and reads the file back, because the Agent's save swallows its own errors. Nothing
here runs a task: the Agent's hosts (gateway housekeeping, CLI startup, ``hermes serve``) own execution.
"""

from __future__ import annotations

import math

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

MAX_TASKS = 200
_TEXT_LIMIT = 300


def _agent():
    try:
        from hermes_cli import plugins_idle_tasks
    except ImportError:
        return None
    return plugins_idle_tasks


def _text(value) -> str | None:
    """Bounded, key-masked text for a summary or error a plugin wrote."""
    if not isinstance(value, str) or not value.strip():
        return None
    from ..redaction import redact_key_shapes
    from .commands import _clean_text

    return _clean_text(redact_key_shapes(value), _TEXT_LIMIT) or None


def _next_due(native, state: dict) -> str | None:
    """The Agent's next due time; none for a state it cannot read one from."""
    try:
        due = native.next_due(state)
    except (TypeError, ValueError):
        return None
    return due if isinstance(due, str) else None


def _row(native, state: dict, *, seeded: bool, interval=None) -> dict:
    interval = state.get("interval_hours") if interval is None else interval
    last_run = state.get("last_run_at")
    status = state.get("last_status")
    return {
        "plugin": str(state.get("plugin") or ""), "task": str(state.get("task") or ""), "seeded": seeded,
        "paused": state.get("paused") is True,
        "run_count": state["run_count"] if isinstance(state.get("run_count"), int) and state["run_count"] >= 0 else 0,
        "last_run_at": last_run if isinstance(last_run, str) and last_run else None,
        "next_due_at": _next_due(native, state) if seeded else None,
        "interval_hours": float(interval) if isinstance(interval, (int, float)) and not isinstance(interval, bool) and math.isfinite(interval) else None,
        "last_status": status if status in ("ok", "error") else None,
        "last_result": _text(state.get("last_error")) or _text(state.get("last_summary")),
    }


def _registered(native) -> list:
    """The profile's loaded plugin manager's registered tasks; none when it cannot load or belongs to another profile."""
    try:
        from hermes_cli.plugins import get_plugin_manager
        from hermes_constants import hermes_home_key

        manager = get_plugin_manager()
        if manager.scope_key != hermes_home_key():
            return []
        manager.discover_and_load(force=False)
        return list(native.registered_idle_tasks(manager).values())
    except Exception:  # noqa: BLE001 - the persisted list stays readable
        return []


def idle_tasks() -> dict:
    native = _agent()
    if native is None:
        return {"supported": False, "tasks": []}
    rows = [row for _path, state in native.iter_state_files() if (row := _row(native, state, seeded=True))["plugin"] and row["task"]]
    seen = {(row["plugin"], row["task"]) for row in rows}
    for spec in _registered(native):
        if (spec.plugin_id, spec.name) not in seen:
            rows.append(_row(native, {"plugin": spec.plugin_id, "task": spec.name}, seeded=False, interval=spec.interval_hours))
    rows.sort(key=lambda row: (row["plugin"], row["task"]))
    return {"supported": True, "tasks": rows[:MAX_TASKS]}


def set_paused(key: str, task: str, paused) -> dict:
    """``hermes plugins idle-tasks <key> --pause|--resume <task>``, confirmed by reading the state back."""
    if not key or not task or not isinstance(paused, bool):
        raise InvalidParams("plugins.idle_task_set_paused requires key, task and boolean paused")
    native = _agent()
    if native is None:
        raise RpcError("This Hermes Agent has no plugin idle tasks", condition="idle_tasks_unsupported")
    path = next((path for path, state in native.iter_state_files(key) if state.get("task") == task), None)
    if path is None:
        raise RpcError(f"No idle task {task!r} of plugin {key!r} has run or been seeded in this profile", condition="idle_task_not_found")
    native.set_paused(path, paused)
    state = native.load_state(path, key, task)
    if state.get("paused") is not paused:
        raise RpcError(f"The idle task {task!r} could not be {'paused' if paused else 'resumed'}", condition="idle_task_not_saved")
    return _row(native, state, seeded=True)


def register(reg) -> None:
    @reg.method("plugins.idle_tasks")
    def list_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return idle_tasks()

    @reg.method("plugins.idle_task_set_paused")
    def set_paused_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return set_paused(str(params.get("key") or "").strip(), str(params.get("task") or "").strip(), params.get("paused"))
