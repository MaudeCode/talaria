"""TAL-494: which subagent sessions a delegation unit ran — exact from the live registry, else unambiguous in state.db."""

from __future__ import annotations

from talaria_sidecar.methods.process import unit_children

UNIT = {"delegation_id": "call-1-2", "goals": ["Write tests", "Run tests"], "dispatched_at": 100.0, "completed_at": None}


def live(goal: str, session_id: str, *, call: str = "call-1", owner: str = "web-a") -> dict:
    return {"delegation_id": call, "goal": goal, "owner": owner, "session_id": session_id}


def finished(goal: str, session_id: str, *, owner: str = "web-a", started_at: float = 120.0) -> dict:
    return {"owner": owner, "session_id": session_id, "started_at": started_at, "goal": goal}


def test_a_running_child_is_linked_exactly_by_owner_call_and_goal() -> None:
    children = unit_children(UNIT, "web-a", [live("Write tests", "c1"), live("Run tests", "c2"), live("Write tests", "other-owner", owner="web-b"), live("Run tests", "other-call", call="call-2")], [], now=200.0)
    assert children == [{"goal": "Write tests", "session_id": "c1"}, {"goal": "Run tests", "session_id": "c2"}]


def test_a_finished_child_is_linked_only_when_one_session_matches_in_the_units_window() -> None:
    assert unit_children(UNIT, "web-a", [], [finished("Write tests", "c1")], now=200.0) == [{"goal": "Write tests", "session_id": "c1"}]
    # Two sessions with the same goal: ambiguous, so no link rather than a guess.
    assert unit_children(UNIT, "web-a", [], [finished("Write tests", "c1"), finished("Write tests", "c3")], now=200.0) == []
    # Started long before the unit was dispatched, or for another chat: not this unit's child.
    assert unit_children(UNIT, "web-a", [], [finished("Write tests", "old", started_at=10.0), finished("Run tests", "theirs", owner="web-b")], now=200.0) == []


def test_the_live_registry_wins_over_the_state_db_match() -> None:
    children = unit_children(UNIT, "web-a", [live("Write tests", "exact")], [finished("Write tests", "guess"), finished("Run tests", "c2")], now=200.0)
    assert children == [{"goal": "Write tests", "session_id": "exact"}, {"goal": "Run tests", "session_id": "c2"}]
