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


def test_tasks_with_the_same_goal_each_keep_their_own_child() -> None:
    twins = {"delegation_id": "call-2", "goals": ["Check a shard", "Check a shard"], "dispatched_at": 100.0, "completed_at": 150.0}
    assert unit_children(twins, "web-a", [live("Check a shard", "c1", call="call-2"), live("Check a shard", "c2", call="call-2")], [], now=200.0) == [
        {"goal": "Check a shard", "session_id": "c1"}, {"goal": "Check a shard", "session_id": "c2"}]
    # Finished: as many sessions as tasks with that goal is unambiguous; one too many or too few is not.
    both = [finished("Check a shard", "c1", started_at=110.0), finished("Check a shard", "c2", started_at=112.0)]
    assert [c["session_id"] for c in unit_children(twins, "web-a", [], both, now=200.0)] == ["c1", "c2"]
    assert unit_children(twins, "web-a", [], both[:1], now=200.0) == []
    assert unit_children(twins, "web-a", [], [*both, finished("Check a shard", "c3", started_at=114.0)], now=200.0) == []


def test_an_image_tasks_stored_first_message_still_reads_as_its_goal() -> None:
    from talaria_sidecar.methods.process import _goal_text
    assert _goal_text("Describe it\n\n[Image attached at: /tmp/a.png]\nUse vision_analyze to inspect these images.") == "Describe it"
    assert _goal_text('\x00json:[{"type": "text", "text": "Describe it"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}}]') == "Describe it"
    assert _goal_text("Plain goal") == "Plain goal"
    assert _goal_text(None) == ""
