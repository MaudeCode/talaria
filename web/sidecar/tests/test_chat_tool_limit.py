"""TAL-537: the pinned Agent ends an exhausted tool budget with ``turn_exit_reason = "max_iterations_reached(n/n)"`` and
appends its summary request as a user row; ``chat.start`` reports ``tool_limit_reached`` and forwards that request text so
the server can drop the row."""

from __future__ import annotations

import json
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

# Runs on the Agent interpreter: the Agent's own summary-request constant, a stand-in AIAgent returning its exit shape.
PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from agent.context_compressor import MAX_ITERATIONS_SUMMARY_REQUEST
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

class FakeAgent:
    def __init__(self, **kwargs):
        pass

    def run_conversation(self, **kwargs):
        return {
            "final_response": "I reached the iteration limit and couldn't generate a summary.",
            "turn_exit_reason": "max_iterations_reached(3/3)",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "c1", "content": "x"},
                {"role": "user", "content": MAX_ITERATIONS_SUMMARY_REQUEST},
            ],
        }

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._agent_class = lambda: FakeAgent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
home = Path(os.environ["HERMES_HOME"])
params = {"profile_home": str(home), "session_id": "s1", "stream_id": "st1", "user_message": "hi", "model": "m", "model_provider": "p", "enabled_toolsets": ["memory"]}
with scoped_home(home):
    result = chat.start(Ctx(), params)
print(json.dumps({"status": result["status"], "tool_limit_reached": result["tool_limit_reached"], "request_matches": result.get("max_iterations_summary_request") == MAX_ITERATIONS_SUMMARY_REQUEST}))
"""


@requires_agent
def test_an_exhausted_tool_budget_reports_the_limit_and_the_agents_summary_request(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    env = isolated_env(root)
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    assert json.loads(run.stdout.strip().splitlines()[-1]) == {"status": "completed", "tool_limit_reached": True, "request_matches": True}
