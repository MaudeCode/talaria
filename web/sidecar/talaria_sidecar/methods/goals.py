"""``goals.*``: Hermes persistent session goals (ported from api/goals.py).

The server passes the session's ``profile_home``, its workspace and the configured
turn budget; the sidecar never reads WebUI settings itself. ``/goal`` parses through
the Agent's own ``dispatch_goal_command``, like its CLI, gateway and TUI.
"""

from __future__ import annotations

import copy
import logging
import re
import time
from pathlib import Path
from typing import Any

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home, session_workspace
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.goals")


def _native():
    try:
        from hermes_cli.goals import CONTINUATION_PROMPT_TEMPLATE, DEFAULT_MAX_TURNS, GoalManager, GoalState, judge_goal
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"Hermes goals unavailable: {exc}", condition="goals_unavailable")
    return CONTINUATION_PROMPT_TEMPLATE, DEFAULT_MAX_TURNS, GoalManager, GoalState, judge_goal


class _Manager:
    """Native GoalManager scoped to one profile home and the session's workspace, where its gates run."""

    def __init__(self, session_id: str, profile_home: Path, default_max_turns: int, workspace: str | None = None):
        _, default, GoalManager, _, _ = _native()
        self.session_id = session_id
        self.profile_home = profile_home
        self.workspace = workspace
        with scoped_home(profile_home):
            self._manager = GoalManager(session_id=session_id, default_max_turns=int(default_max_turns or default or 20))

    def scoped(self, func, *args, **kwargs):
        with scoped_home(self.profile_home), session_workspace(self.workspace):
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
    if status == "paused" and str(getattr(state, "paused_reason", "") or "").startswith("turn budget exhausted"):
        return {**decision, "message_key": "goal_paused_budget_exhausted", "message_args": [turns_used, max_turns]}
    if decision.get("should_continue"):
        return {**decision, "message_key": "goal_continuing", "message_args": [turns_used, max_turns, reason]}
    return decision


def _parked(mgr: _Manager) -> dict | None:
    """TAL-808: an active goal's live wait barrier, as the Agent's own ``is_waiting`` (which clears a satisfied one) sees it."""
    if not mgr.is_waiting():
        return None
    state = mgr.state
    until = float(getattr(state, "waiting_until", 0.0) or 0.0)
    return {"reason": getattr(state, "waiting_reason", None) or None, "until": until or None}


def _inactive(reason: str, status=None) -> dict:
    return {"status": status, "should_continue": False, "continuation_prompt": None, "verdict": "inactive", "reason": reason, "message": ""}


def _manager_from(params: dict) -> _Manager:
    session_id = str(params.get("session_id") or "").strip()
    if not session_id:
        raise InvalidParams("session_id is required")
    max_turns = params.get("default_max_turns") or 20
    return _Manager(session_id, profile_home_param(params), int(max_turns), str(params.get("workspace") or "") or None)


#: Older Agents run gates in their launch directory, where a gate checks another project and can pass for it.
_GATES_NEED_WORKSPACE = "Goal gates need Hermes Agent 0.21.6 or later, which runs them in the session workspace."


def _gates_run_in_workspace() -> bool:
    from hermes_cli import goals as agent_goals

    return hasattr(agent_goals, "_gate_workspace")


#: The response ``action`` of each control verb the Agent dispatches; any other command sets the goal.
_CONTROL_ACTIONS = {
    "": "status", "status": "status", "show": "show", "pause": "pause", "resume": "resume", "continue": "resume",
    "unpause": "resume", "clear": "clear", "stop": "clear", "done": "clear", "unwait": "unwait", "wait": "wait", "gate": "gate",
}


def _localized(action: str, state: Any, had_goal: bool) -> dict:
    """``message_key``/``message_args`` for the verbs Web already localizes; other verbs show the Agent's text."""
    status = str(getattr(state, "status", "") or "")
    goal = str(getattr(state, "goal", "") or "")
    if action == "status":
        return {k: v for k, v in _status_payload(state).items() if k != "message"}
    if action == "set":
        return {"message_key": "goal_set", "message_args": [int(getattr(state, "max_turns", 0) or 0), goal]}
    if action == "pause":
        return {"message_key": "goal_paused", "message_args": [goal]} if had_goal and status == "paused" else {"message_key": "goal_no_goal"}
    if action == "resume":
        return {"message_key": "goal_resumed", "message_args": [goal]} if had_goal and status == "active" else {"message_key": "goal_no_goal"}
    if action == "clear":
        return {"message_key": "goal_cleared" if had_goal else "goal_no_goal"}
    return {}


def register(registry) -> None:
    @registry.method("goals.get")
    def get(ctx: CallContext, params: dict) -> dict:
        mgr = _manager_from(params)
        state = mgr.state
        active = bool(state is not None and getattr(state, "status", None) == "active")
        return {"goal": _state_payload(state), "active": active, "parked": _parked(mgr) if active else None, **_status_payload(state)}

    @registry.method("goals.command")
    def command(ctx: CallContext, params: dict) -> dict:
        """/goal <args> through the Agent's ``dispatch_goal_command``, as its TUI runs it."""
        mgr = _manager_from(params)
        try:
            from hermes_cli import goals as agent_goals
            from hermes_cli.goal_command import dispatch_goal_command, is_goal_control
        except Exception as exc:  # noqa: BLE001
            raise RpcError(f"Hermes goals unavailable: {exc}", condition="goals_unavailable")
        text = str(params.get("args") or "").strip()
        tokens = text.lower().split()
        action = _CONTROL_ACTIONS.get(tokens[0] if tokens else "", "set") if is_goal_control(text) else "set"
        if action == "set" and params.get("stream_running"):
            return _payload(ok=False, action="set", error="agent_running", message="Agent is running — use /goal status / pause / clear mid-run, or /stop before setting a new goal.")
        if tokens[:2] == ["gate", "add"] and not _gates_run_in_workspace():
            return _payload(ok=False, action="gate", error="gates_unsupported", state=mgr.state, message=_GATES_NEED_WORKSPACE)
        had_goal = bool(mgr.has_goal())
        # Only goal-setting text reads it: a re-pasted goal kicks off without repeating itself.
        last_user_message = mgr.scoped(agent_goals.last_user_message_from_db, mgr.session_id) if action == "set" else None
        result = mgr.scoped(dispatch_goal_command, mgr._manager, text, authorize_gate=lambda: None, last_user_message=last_user_message)
        state = mgr.state
        if result.error:
            return _payload(ok=False, action=action, error="invalid_goal" if action == "set" else "invalid_command", message=result.output, state=state)
        # A running turn's judge continues a resumed goal itself.
        kickoff = result.prompt if result.prompt and not params.get("stream_running") else None
        return _payload(action=action, message=result.output, state=state, kickoff_prompt=kickoff, **_localized(action, state, had_goal))

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
            # Gates set on a newer Agent persist across a channel switch; this one would run them outside the workspace.
            if getattr(mgr.state, "gates", None) and not _gates_run_in_workspace():
                mgr.pause(reason="gates need Hermes Agent 0.21.6 or later")
                return {"status": "paused", "should_continue": False, "continuation_prompt": None, "verdict": "gate_failed", "reason": "gates not run",
                        "message": f"⏸ Goal paused — quality gates not run. {_GATES_NEED_WORKSPACE} /goal gate clear, then /goal resume."}
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
