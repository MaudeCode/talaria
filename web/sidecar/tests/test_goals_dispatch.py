"""TAL-882: ``/goal`` runs through the Agent's ``dispatch_goal_command``, and goal gates run in the session workspace.
Real sidecar on the supported Agent release; each test owns a disposable home and workspace."""

from __future__ import annotations

import os
import pathlib

import pytest

from conftest import AGENT_DIR, SidecarProcess, requires_agent

pytestmark = requires_agent

# Agent v0.21.6 runs gates in the session workspace and lets control verbs keep trailing words.
GATES_IN_WORKSPACE = AGENT_DIR is not None and "_gate_workspace" in (AGENT_DIR / "hermes_cli" / "goals.py").read_text()
BARE_CONTROL_VERBS = AGENT_DIR is not None and "_BARE_CONTROL_VERBS" in (AGENT_DIR / "hermes_cli" / "goal_command.py").read_text()


@pytest.fixture
def goal(tmp_path, hermes_home):
    elsewhere = tmp_path / "terminal-cwd"
    elsewhere.mkdir()
    proc = SidecarProcess(hermes_home, env={"TERMINAL_CWD": str(elsewhere)})

    def command(args: str, **extra) -> dict:
        return proc.result("goals.command", {"session_id": "s1", "profile_home": str(hermes_home), "args": args, **extra})

    def evaluate(**extra) -> dict:
        return proc.result("goals.evaluate", {"session_id": "s1", "profile_home": str(hermes_home), "last_response": "worked on it", **extra})

    command.evaluate = evaluate
    yield command
    proc.close()


@pytest.mark.skipif(not GATES_IN_WORKSPACE, reason="this Agent runs gates outside the session workspace")
def test_gate_runs_in_the_session_workspace(goal, tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    goal("ship the release notes", workspace=str(workspace))
    added = goal("gate add pwd > gate-ran.txt", workspace=str(workspace))
    assert added["ok"] and added["goal"]["goal"] == "ship the release notes", added
    goal.evaluate(workspace=str(workspace))
    marker = workspace / "gate-ran.txt"
    assert marker.exists(), "the gate ran outside the session workspace"
    assert pathlib.Path(marker.read_text().strip()).resolve() == workspace.resolve()


@pytest.mark.skipif(not GATES_IN_WORKSPACE, reason="this Agent runs gates outside the session workspace")
def test_missing_workspace_pauses_with_the_agents_message(goal, tmp_path):
    goal("ship the release notes")
    goal("gate add true")
    decision = goal.evaluate(workspace=str(tmp_path / "deleted"))
    assert decision["status"] == "paused" and "quality gates not run" in decision["message"], decision
    assert "message_key" not in decision, "a gate pause is not a budget pause"


@pytest.mark.skipif(GATES_IN_WORKSPACE, reason="this Agent runs gates in the session workspace")
def test_gate_add_is_refused_where_gates_would_leave_the_workspace(goal):
    goal("ship the release notes")
    refused = goal("gate add pwd")
    assert refused["ok"] is False and refused["error"] == "gates_unsupported", refused
    assert goal("gate list")["ok"], "listing and clearing gates still work"


@pytest.mark.skipif(not GATES_IN_WORKSPACE, reason="this Agent refuses gate add")
def test_gate_list_and_clear(goal):
    goal("ship the release notes")
    goal("gate add true")
    listed = goal("gate list")
    assert listed["ok"] and listed["action"] == "gate" and "$ true" in listed["message"], listed
    cleared = goal("gate clear")
    assert cleared["ok"] and "Cleared 1 gate" in cleared["message"], cleared
    assert cleared["goal"]["goal"] == "ship the release notes"


def test_wait_parks_the_goal_without_replacing_it(goal):
    goal("ship the release notes")
    parked = goal(f"wait {os.getpid()} build running")
    assert parked["ok"] and parked["action"] == "wait" and f"pid {os.getpid()}" in parked["message"], parked
    assert parked["goal"]["goal"] == "ship the release notes"
    assert goal("unwait")["ok"]


@pytest.mark.skipif(not BARE_CONTROL_VERBS, reason="this Agent treats a control verb with trailing words as goal text")
def test_control_verbs_with_trailing_words_keep_the_goal(goal):
    goal("ship the release notes")
    paused = goal("pause for now")
    assert paused["action"] == "pause" and paused["goal"] == {**paused["goal"], "goal": "ship the release notes", "status": "paused"}, paused
    for verb in ("resume last goal", "continue", "unpause"):
        goal("pause")
        resumed = goal(verb)
        assert resumed["action"] == "resume" and resumed["goal"]["status"] == "active", (verb, resumed)
        assert resumed["goal"]["goal"] == "ship the release notes"
    shown = goal("show")
    assert shown["action"] == "show" and "ship the release notes" in shown["message"], shown
    escaped = goal("-- pause the cron")
    assert escaped["action"] == "set" and escaped["goal"]["goal"] == "pause the cron", escaped


def test_running_turn_refuses_only_goal_setting_text(goal):
    goal("ship the release notes")
    assert goal("gate list", stream_running=True)["ok"]
    assert goal("pause", stream_running=True)["goal"]["status"] == "paused"
    # The running turn's judge continues a resumed goal; idle, resume starts the Agent's continuation turn.
    assert "kickoff_prompt" not in goal("resume", stream_running=True)
    goal("pause")
    assert "ship the release notes" in goal("resume")["kickoff_prompt"]
    refused = goal("something else", stream_running=True)
    assert refused["ok"] is False and refused["error"] == "agent_running", refused
    assert goal("status")["goal"]["goal"] == "ship the release notes"
