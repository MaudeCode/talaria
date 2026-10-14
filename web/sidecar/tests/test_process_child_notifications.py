"""TAL-933: drained events mark a subagent's own process notices; the server decides whether they surface."""

import json
import pathlib
import subprocess
import sys
from types import ModuleType

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent
from talaria_sidecar.methods import process

SIDECAR_DIR = pathlib.Path(__file__).resolve().parents[1]
SUBAGENT = "sa-0-1a2b3c"
# name: (event, child_process)
EVENTS = {
    "subagent completion": ({"session_id": "proc_c", "type": "completion", "owner_task_id": SUBAGENT, "session_key": "s"}, True),
    "subagent watch match": ({"session_id": "proc_c", "type": "watch_match", "owner_task_id": SUBAGENT, "session_key": "s"}, True),
    "untyped subagent exit": ({"session_id": "proc_c", "task_id": SUBAGENT}, True),
    "top-level completion": ({"session_id": "proc_t", "type": "completion", "owner_task_id": "", "task_id": "s", "session_key": "s"}, False),
    "async delegation": ({"type": "async_delegation", "delegation_id": "deleg_1", "owner_task_id": SUBAGENT}, False),
    "work closeout": ({"type": "async_delegation_work_closeout", "owner_task_id": SUBAGENT}, False),
}


@requires_agent
def test_the_installed_agent_classifies_drained_events(hermes_home: pathlib.Path) -> None:
    code = """
import json, sys
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from talaria_sidecar.methods.process import _event_row
print(json.dumps({name: _event_row(evt).get("child_process") for name, evt in json.loads(sys.argv[3]).items()}))
"""
    events = {name: evt for name, (evt, _) in EVENTS.items()}
    out = subprocess.run([AGENT_PYTHON, "-c", code, str(AGENT_DIR), str(SIDECAR_DIR), json.dumps(events)], env=isolated_env(hermes_home), capture_output=True, text=True, check=True).stdout
    assert json.loads(out.splitlines()[-1]) == {name: child for name, (_, child) in EVENTS.items()}


@pytest.mark.parametrize("name", EVENTS)
def test_older_agents_apply_the_same_rule(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    # Agents before 0.21.7 have no is_child_process_notification.
    monkeypatch.setitem(sys.modules, "tools", ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.process_registry_notifications", ModuleType("tools.process_registry_notifications"))
    monkeypatch.setattr(process, "_registry", lambda: None)
    evt, child = EVENTS[name]
    assert process._event_row(evt).get("child_process") is child


def test_requeue_drops_the_classification(monkeypatch: pytest.MonkeyPatch) -> None:
    queued: list[dict] = []
    monkeypatch.setattr(process, "_registry", lambda: type("Registry", (), {"completion_queue": type("Q", (), {"put_nowait": staticmethod(queued.append)})()})())
    assert process.requeue([{"type": "async_delegation", "delegation_id": "d", "process_id": "d", "consumed": False, "child_process": False}]) == 1
    assert queued == [{"type": "async_delegation", "delegation_id": "d"}]
