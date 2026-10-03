"""TAL-372: the sidecar reports a WebUI session's background work from the pinned Agent's durable delegation ledger."""

from __future__ import annotations

import pathlib

from conftest import SidecarProcess
from test_process_delivery import _agent


def _dispatch(home: pathlib.Path, delegation_id: str, session: str, goals: str, indexes: str = "") -> None:
    """Record a dispatched unit the way the Agent does; ``goals`` is ``;``-separated, ``indexes`` the unit's share."""
    _agent(home, (
        "goals = sys.argv[4].split(';')\n"
        "record = {'delegation_id': sys.argv[2], 'dispatched_at': time.time(), 'session_key': sys.argv[3], 'origin_ui_session_id': sys.argv[3],"
        " 'goal': goals[0], **({'goals': goals, 'is_batch': True} if len(goals) > 1 else {})}\n"
        "if sys.argv[5]: record['task_indexes'] = [int(i) for i in sys.argv[5].split(',')]\n"
        "ad._persist_dispatch(record)\n"
    ), delegation_id, session, goals, indexes)


def _complete(home: pathlib.Path, delegation_id: str, statuses: str) -> None:
    _agent(home, (
        "results = [{'task_index': i, 'status': s, 'summary': 'done ' + s} for i, s in enumerate(sys.argv[3].split(','))]\n"
        "event = {'type': 'async_delegation', 'delegation_id': sys.argv[2], 'status': 'completed', 'goal': 'g', 'goals': ['a', 'b'], 'is_batch': True, 'results': results}\n"
        "ad._persist_completion(event, {'results': results})\n"
    ), delegation_id, statuses)


def test_lists_only_the_sessions_own_units_with_their_goals_and_outcomes(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    _dispatch(hermes_home, "call-1-1", "web-a", "Write docs;Write tests;Run tests", "0")
    _dispatch(hermes_home, "call-1-2", "web-a", "Write docs;Write tests;Run tests", "1,2")
    _dispatch(hermes_home, "solo", "web-a", "Check logs")
    _dispatch(hermes_home, "theirs", "web-b", "Not yours")
    _complete(hermes_home, "call-1-2", "completed,error")

    listed = handshaken.result("process.background_list", {"profile_home": str(hermes_home), "session_ids": ["web-a"]})
    units = {d["delegation_id"]: d for d in listed["delegations"]}
    assert set(units) == {"call-1-1", "call-1-2", "solo"}
    assert units["call-1-1"]["goals"] == ["Write docs"] and units["call-1-1"]["state"] == "running"
    assert units["call-1-2"]["goals"] == ["Write tests", "Run tests"]
    assert units["call-1-2"]["state"] == "completed" and units["call-1-2"]["child_statuses"] == ["completed", "error"] and units["call-1-2"]["has_result"]
    assert units["solo"]["goals"] == ["Check logs"] and units["solo"]["child_statuses"] == []
    assert listed["processes"] == []


def test_a_units_full_result_is_read_only_by_its_own_session(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    _dispatch(hermes_home, "done-1", "web-a", "Summarize;Review")
    _complete(hermes_home, "done-1", "completed,completed")
    own = handshaken.result("process.delegation_result", {"profile_home": str(hermes_home), "session_id": "web-a", "delegation_id": "done-1"})["text"]
    assert "done-1" in own
    assert handshaken.result("process.delegation_result", {"profile_home": str(hermes_home), "session_id": "web-b", "delegation_id": "done-1"})["text"] == ""


def test_an_agent_that_never_delegated_lists_nothing(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    assert handshaken.result("process.background_list", {"profile_home": str(hermes_home), "session_ids": ["web-a"]}) == {"delegations": [], "processes": []}
