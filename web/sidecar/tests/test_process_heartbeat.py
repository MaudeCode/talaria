"""Heartbeat notifications use the Agent's formatter without inventing exits on older Agents."""

import json
import subprocess
import sys
from types import ModuleType

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent
from talaria_sidecar.methods.process import format_notification


EVENT = {"type": "heartbeat", "session_id": "proc_1", "command": "npm test", "seq": 1, "interval": 60, "elapsed": 61, "output": "test passed", "started_at": 10}


@requires_agent
def test_heartbeat_matches_the_installed_agent_formatter(handshaken, hermes_home):
    code = """
import json, sys
sys.path.insert(0, sys.argv[1])
from tools.process_registry import ProcessRegistry, format_process_notification
event = json.loads(sys.argv[2])
print(json.dumps(format_process_notification(event) if hasattr(ProcessRegistry, '_emit_heartbeat') else ''))
"""
    expected = json.loads(subprocess.run([AGENT_PYTHON, "-c", code, str(AGENT_DIR), json.dumps(EVENT)], env=isolated_env(hermes_home), capture_output=True, text=True, check=True).stdout)
    assert handshaken.result("process.format_notification", {"event": EVENT}) == {"text": expected}
    if expected:
        assert "heartbeat #1" in expected and "test passed" in expected


def test_older_agent_never_formats_a_heartbeat_as_a_completion(monkeypatch):
    module = ModuleType("tools.process_registry")
    module.ProcessRegistry = type("ProcessRegistry", (), {})
    module.format_process_notification = lambda event: "[completed with exit code ?]"
    monkeypatch.setitem(sys.modules, "tools", ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.process_registry", module)
    assert format_notification(EVENT) == ""


@pytest.mark.parametrize("kind", ["watch_match", "watch_disabled", "watch_overflow_tripped", "watch_overflow_released"])
def test_other_progress_notices_use_the_agent_formatter(monkeypatch, kind):
    module = ModuleType("tools.process_registry")
    module.format_process_notification = lambda event: f"Agent notice: {event['type']}"
    monkeypatch.setitem(sys.modules, "tools", ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.process_registry", module)
    assert format_notification({"type": kind}) == f"Agent notice: {kind}"
