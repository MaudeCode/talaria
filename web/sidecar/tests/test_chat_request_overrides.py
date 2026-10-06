"""``chat.start`` hands the profile's main-model ``service_tier`` and ``extra_body`` (written by ``/api/model/set``) to
``AIAgent(request_overrides=...)`` only when the turn runs on that main model, and an edit rebuilds the cached agent."""

from __future__ import annotations

import json
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

# Runs on the Agent interpreter: real config loading, a stand-in AIAgent that records its kwargs.
PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

seen = []

class FakeAgent:
    def __init__(self, **kwargs):
        seen.append(kwargs.get("request_overrides"))

    def run_conversation(self, **kwargs):
        return {"final_response": "ok", "messages": []}

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._agent_class = lambda: FakeAgent
chat._resolve_runtime = lambda provider, model: {"model": model, "provider": provider}
root = Path(os.environ["HERMES_HOME"])
config = root / "config.yaml"

def turn(i, session, model="gpt-5.4", provider="openai-codex"):
    params = {"profile_home": str(root), "session_id": session, "stream_id": f"st{i}", "user_message": "hi", "model": model, "model_provider": provider, "enabled_toolsets": ["memory"]}
    with scoped_home(root):
        result = chat.start(Ctx(), params)
    assert result["status"] == "completed", result

turn(0, "main")
turn(1, "main")
turn(2, "other", model="glm-5", provider="zai")
config.write_text(config.read_text() + "  extra_body:\\n    reasoning:\\n      summary: auto\\n")
turn(3, "main")
print(json.dumps(seen))
"""

CONFIG = """\
model:
  default: gpt-5.4
  provider: openai-codex
  service_tier: priority
"""


@requires_agent
def test_main_model_turns_carry_service_tier_and_extra_body(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "config.yaml").write_text(CONFIG)
    env = isolated_env(root)
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    seen = json.loads(run.stdout.strip().splitlines()[-1])
    # The main model gets its tier (the unchanged second turn reuses the cached agent), another model gets none, and
    # an ``extra_body`` edit builds a new agent carrying both.
    assert seen == [{"service_tier": "priority"}, None, {"service_tier": "priority", "extra_body": {"reasoning": {"summary": "auto"}}}], seen
