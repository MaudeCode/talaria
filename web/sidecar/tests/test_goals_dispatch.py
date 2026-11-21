"""TAL-882: ``/goal`` runs through the Agent's ``dispatch_goal_command``, and goal gates run in the session workspace.
Real sidecar on the supported Agent release; each test owns a disposable home and workspace."""

from __future__ import annotations

import json
import os
import pathlib
import time

import pytest

from conftest import SidecarProcess, requires_agent

pytestmark = requires_agent

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
    command.proc = proc
    yield command
    proc.close()


def test_gate_runs_in_the_session_workspace(goal, tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    goal("ship the release notes", workspace=str(workspace))
    added = goal("gate add pwd > gate-ran.txt", workspace=str(workspace), authorize_gate=True)
    assert added["ok"] and added["goal"]["goal"] == "ship the release notes", added
    goal.evaluate(workspace=str(workspace))
    marker = workspace / "gate-ran.txt"
    assert marker.exists(), "the gate ran outside the session workspace"
    assert pathlib.Path(marker.read_text().strip()).resolve() == workspace.resolve()


def test_missing_workspace_pauses_with_the_agents_message(goal, tmp_path):
    goal("ship the release notes")
    goal("gate add true", authorize_gate=True)
    decision = goal.evaluate(workspace=str(tmp_path / "deleted"))
    assert decision["status"] == "paused" and "quality gates not run" in decision["message"], decision
    assert "message_key" not in decision, "a gate pause is not a budget pause"


def test_gate_list_and_clear(goal):
    goal("ship the release notes")
    goal("gate add true", authorize_gate=True)
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


def test_get_reports_the_parked_barrier(goal, hermes_home):
    """TAL-808: ``goals.get`` names a live wait barrier's reason and, for a timed wait, its deadline."""
    def get() -> dict:
        return goal.proc.result("goals.get", {"session_id": "s1", "profile_home": str(hermes_home)})

    goal("ship the release notes")
    assert get().get("parked") is None
    goal(f"wait {os.getpid()} build running")
    assert get().get("parked") == {"reason": "build running", "until": None}
    goal("unwait")
    assert get().get("parked") is None
    snap = json.loads(goal.proc.result("goals.snapshot", {"session_id": "s1", "profile_home": str(hermes_home)})["snapshot"])
    until = time.time() + 600
    goal.proc.result("goals.restore", {"session_id": "s1", "profile_home": str(hermes_home), "snapshot": json.dumps({**snap, "waiting_until": until, "waiting_reason": "CI running"})})
    assert get().get("parked") == {"reason": "CI running", "until": until}
    goal("pause")
    assert get().get("parked") is None, "a paused goal is paused, not parked"


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


def test_kickoff_carries_the_completion_contract(goal):
    """TAL-2315: the first turn's input names the parsed contract; the explanatory message alone never reaches the model."""
    fields = {"outcome": "widget shipped", "verify": "fixture check passes", "must not": "break the old widget",
              "scope": "widgets/ only", "stop when": "the fixture is missing"}
    started = goal("Ship synthetic widget\n" + "\n".join(f"{key}: {value}" for key, value in fields.items()))
    assert started["ok"] and started["goal"]["goal"] == "Ship synthetic widget", started
    block = goal("show")["message"].split("\n", 1)[1]
    assert all(value in block for value in fields.values()), block
    assert started["kickoff_prompt"] == f"Ship synthetic widget\n\nCompletion contract:\n{block}"
    # The Agent's own resume continuation already renders the contract; it is not repeated.
    goal("pause")
    assert goal("resume")["kickoff_prompt"].count(block) == 1
    assert goal("ship the release notes")["kickoff_prompt"] == "ship the release notes"
