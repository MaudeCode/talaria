"""TAL-978: ``chat.start`` names the route that served the turn. A provider fallback swaps ``agent.model`` and
``agent.provider`` until the next turn starts; the result carries that served route and the primary model the Agent
requested, so the server can tell a fallback answered."""

from __future__ import annotations

import json
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

# Runs on the Agent interpreter: a stand-in AIAgent whose first turn fails over the way the pinned Agent does.
PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

class FakeAgent:
    turns = 0

    def __init__(self, **kwargs):
        self.model, self.provider = kwargs["model"], kwargs["provider"]

    def run_conversation(self, **kwargs):
        FakeAgent.turns += 1
        requested = self.model = "m"
        self.provider = "p"
        if FakeAgent.turns == 1:
            self.model, self.provider = "fallback-model", "fallback-provider"
        return {"final_response": "ok", "messages": [], "model": self.model, "provider": self.provider, "requested_model": requested}

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._agent_class = lambda: FakeAgent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
root = Path(os.environ["HERMES_HOME"])
results = []
for i in range(2):
    params = {"profile_home": str(root), "session_id": "served", "stream_id": f"st{i}", "user_message": "hi", "model": "m", "model_provider": "p", "enabled_toolsets": ["memory"]}
    with scoped_home(root):
        result = chat.start(Ctx(), params)
    results.append({key: result.get(key) for key in ("status", "model", "provider", "requested_model")})
print(json.dumps(results))
"""


@requires_agent
def test_start_returns_the_fallback_route_and_the_requested_model(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    fallback, primary = json.loads(run.stdout.strip().splitlines()[-1])
    assert fallback == {"status": "completed", "model": "fallback-model", "provider": "fallback-provider", "requested_model": "m"}
    assert primary == {"status": "completed", "model": "m", "provider": "p", "requested_model": "m"}
