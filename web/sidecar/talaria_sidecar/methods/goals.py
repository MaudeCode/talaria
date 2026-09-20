"""``goals.*``: Hermes persistent session goals (ported from api/goals.py).

The server passes the session's ``profile_home`` and the configured turn
budget; the sidecar never reads WebUI settings itself.
"""

from __future__ import annotations

import copy
import logging
import re
import time
from pathlib import Path
from typing import Any

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.goals")


def _native():
    try:
        from hermes_cli.goals import CONTINUATION_PROMPT_TEMPLATE, DEFAULT_MAX_TURNS, GoalManager, GoalState, judge_goal
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"Hermes goals unavailable: {exc}", condition="goals_unavailable")
    return CONTINUATION_PROMPT_TEMPLATE, DEFAULT_MAX_TURNS, GoalManager, GoalState, judge_goal


class _Manager:
    """Native GoalManager scoped to one profile home."""

    def __init__(self, session_id: str, profile_home: Path, default_max_turns: int):
        _, default, GoalManager, _, _ = _native()
        self.session_id = session_id
        self.profile_home = profile_home
        with scoped_home(profile_home):
            self._manager = GoalManager(session_id=session_id, default_max_turns=int(default_max_turns or default or 20))

    def scoped(self, func, *args, **kwargs):
        with scoped_home(self.profile_home):
            return func(*args, **kwargs)

    @property
    def state(self):
        return self._manager.state

    def __getattr__(self, name):
        value = getattr(self._manager, name)
        if not callable(value):
            return value
        return lambda *a, **k: self.scoped(value, *a, **k)

    def restore(self, snapshot) -> None:
        from hermes_cli.goals import save_goal

        self._manager._state = snapshot
        self.scoped(save_goal, self.session_id, snapshot)


def _state_payload(state: Any) -> dict | None:
    if state is None:
        return None
    return {
        "goal": getattr(state, "goal", "") or "",
        "status": getattr(state, "status", "") or "",
        "turns_used": int(getattr(state, "turns_used", 0) or 0),
        "max_turns": int(getattr(state, "max_turns", 0) or 0),
        "last_verdict": getattr(state, "last_verdict", None),
        "last_reason": getattr(state, "last_reason", None),
        "paused_reason": getattr(state, "paused_reason", None),
    }


def _payload(*, ok: bool = True, action: str, message: str, state: Any = None, error: str | None = None, kickoff_prompt: str | None = None,
             message_key: str | None = None, message_args: list | None = None) -> dict:
    body: dict[str, Any] = {"ok": bool(ok), "action": action, "message": message, "goal": _state_payload(state)}
    if error:
        body["error"] = error
    if kickoff_prompt:
        body["kickoff_prompt"] = kickoff_prompt
    if message_key:
        body["message_key"] = message_key
    if message_args is not None:
        body["message_args"] = [a for a in message_args if a is not None]
    return body


def _status_payload(state: Any) -> dict:
    default_message = "No active goal. Set one with /goal <text>."
    if state is None:
        return {"message": default_message, "message_key": "goal_status_none"}
    status = str(getattr(state, "status", "") or "").strip()
    if status == "cleared":
        return {"message": default_message, "message_key": "goal_status_none"}
    turns_used = int(getattr(state, "turns_used", 0) or 0)
    max_turns = int(getattr(state, "max_turns", 0) or 0)
    goal = str(getattr(state, "goal", "") or "")
    if status == "active":
        return {"message": f"⊙ Goal (active, {turns_used}/{max_turns} turns): {goal}", "message_key": "goal_status_active", "message_args": [turns_used, max_turns, goal]}
    if status == "paused":
        reason = str(getattr(state, "paused_reason", "") or "")
        return {"message": f"⏸ Goal (paused, {turns_used}/{max_turns}{' — ' + reason if reason else ''}): {goal}", "message_key": "goal_status_paused", "message_args": [turns_used, max_turns, reason, goal]}
    if status == "done":
        return {"message": f"✓ Goal done ({turns_used}/{max_turns}): {goal}", "message_key": "goal_status_done", "message_args": [turns_used, max_turns, goal]}
    return {"message": f"Goal ({status}, {turns_used}/{max_turns}): {goal}", "message_args": [status, turns_used, max_turns, goal]}


def _turns_from_message(message: str) -> tuple[int, int]:
    match = re.search(r"\((\d+)\s*/\s*(\d+)\)", message or "")
    if not match:
        return 0, 0
    return int(match.group(1)), int(match.group(2))


def _decision_payload(decision: dict, state: Any) -> dict:
    status = str(decision.get("status") or "").strip()
    reason = str(decision.get("reason") or "").strip()
    turns_used = int(getattr(state, "turns_used", 0) or 0)
    max_turns = int(getattr(state, "max_turns", 0) or 0)
    if (turns_used, max_turns) == (0, 0):
        turns_used, max_turns = _turns_from_message(str(decision.get("message") or ""))
    if status == "done":
        return {**decision, "message_key": "goal_achieved", "message_args": [reason]}
    if status == "paused":
        return {**decision, "message_key": "goal_paused_budget_exhausted", "message_args": [turns_used, max_turns]}
    if decision.get("should_continue"):
        return {**decision, "message_key": "goal_continuing", "message_args": [turns_used, max_turns, reason]}
    return decision


def _inactive(reason: str, status=None) -> dict:
    return {"status": status, "should_continue": False, "continuation_prompt": None, "verdict": "inactive", "reason": reason, "message": ""}


def _manager_from(params: dict) -> _Manager:
    session_id = str(params.get("session_id") or "").strip()
    if not session_id:
        raise InvalidParams("session_id is required")
    max_turns = params.get("default_max_turns") or 20
    return _Manager(session_id, profile_home_param(params), int(max_turns))


def register(registry) -> None:
    @registry.method("goals.get")
    def get(ctx: CallContext, params: dict) -> dict:
        mgr = _manager_from(params)
        state = mgr.state
        return {"goal": _state_payload(state), "active": bool(state is not None and getattr(state, "status", None) == "active"), **_status_payload(state)}

    @registry.method("goals.command")
    def command(ctx: CallContext, params: dict) -> dict:
        """/goal <args> with the same semantics as the gateway command."""
        mgr = _manager_from(params)
        text = str(params.get("args") or "").strip()
        lower = text.lower()
        stream_running = bool(params.get("stream_running", False))
        if not text or lower == "status":
            state = mgr.state
            return _payload(action="status", state=state, **_status_payload(state))
        if lower == "pause":
            state = mgr.pause(reason="user-paused")
            if state is None:
                return _payload(ok=False, action="pause", error="no_goal", message="No goal set.", message_key="goal_no_goal")
            return _payload(action="pause", message=f"⏸ Goal paused: {state.goal}", message_key="goal_paused", message_args=[str(state.goal)], state=state)
        if lower == "resume":
            state = mgr.resume()
            if state is None:
                return _payload(ok=False, action="resume", error="no_goal", message="No goal to resume.", message_key="goal_no_goal")
            return _payload(action="resume", message=f"▶ Goal resumed: {state.goal}\nSend a new message, or type continue, to kick it off.", message_key="goal_resumed", message_args=[str(state.goal)], state=state)
        if lower in ("clear", "stop", "done"):
            had = bool(mgr.has_goal())
            mgr.clear()
            return _payload(action="clear", message="Goal cleared." if had else "No active goal.", message_key="goal_cleared" if had else "goal_no_goal", state=mgr.state)
        if stream_running:
            return _payload(ok=False, action="set", error="agent_running", message="Agent is running — use /goal status / pause / clear mid-run, or /stop before setting a new goal.")
        try:
            state = mgr.set(text)
        except ValueError as exc:
            return _payload(ok=False, action="set", error="invalid_goal", message=f"Invalid goal: {exc}")
        return _payload(
            action="set",
            message=(f"⊙ Goal set ({state.max_turns}-turn budget): {state.goal}\n"
                     "I'll keep working until the goal is done, you pause/clear it, or the budget is exhausted.\n"
                     "Controls: /goal status · /goal pause · /goal resume · /goal clear"),
            message_key="goal_set", message_args=[state.max_turns, state.goal], state=state, kickoff_prompt=state.goal,
        )

    @registry.method("goals.snapshot")
    def snapshot(ctx: CallContext, params: dict) -> dict:
        """Deep-copied state for rollback before a kickoff turn; ``token`` restores it."""
        mgr = _manager_from(params)
        state = copy.deepcopy(mgr.state)
        return {"goal": _state_payload(state), "snapshot": state.to_json() if state is not None and hasattr(state, "to_json") else None}

    @registry.method("goals.restore")
    def restore(ctx: CallContext, params: dict) -> dict:
        mgr = _manager_from(params)
        raw = params.get("snapshot")
        if raw is None:
            mgr.clear()
            return {"goal": None}
        _, _, _, GoalState, _ = _native()
        state = GoalState.from_json(raw)
        mgr.restore(state)
        return {"goal": _state_payload(state)}

    @registry.method("goals.evaluate")
    def evaluate(ctx: CallContext, params: dict) -> dict:
        mgr = _manager_from(params)
        try:
            if not mgr.is_active():
                return _inactive("no active goal", getattr(mgr.state, "status", None) if mgr.state is not None else None)
            decision = mgr.evaluate_after_turn(str(params.get("last_response") or ""), user_initiated=bool(params.get("user_initiated", True)))
        except Exception as exc:  # noqa: BLE001 - never fail a turn on goal evaluation
            log.debug("goal evaluation failed", exc_info=True)
            return {"status": None, "should_continue": False, "continuation_prompt": None, "verdict": "error", "reason": f"goal evaluation failed: {type(exc).__name__}", "message": ""}
        if not isinstance(decision, dict):
            decision = {}
        decision = dict(decision)
        decision.setdefault("should_continue", False)
        decision.setdefault("continuation_prompt", None)
        decision.setdefault("message", "")
        return _decision_payload(decision, mgr.state)
