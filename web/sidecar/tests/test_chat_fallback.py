"""``chat.start`` hands the profile's fallback chain (``fallback_providers`` first, then legacy ``fallback_model``,
deduplicated by the pinned Agent's own resolver) to ``AIAgent(fallback_model=...)``, and a chain edit rebuilds the
cached agent like it does for the CLI and gateway."""

from __future__ import annotations

import json
import os
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, requires_agent

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
        seen.append(kwargs.get("fallback_model"))

    def run_conversation(self, **kwargs):
        return {"final_response": "ok", "messages": []}

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._agent_class = lambda: FakeAgent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
root = Path(os.environ["HERMES_HOME"])
config = root / "config.yaml"

def turn(i, session, home=root):
    params = {"profile_home": str(home), "session_id": session, "stream_id": f"st{i}", "user_message": "hi", "model": "m", "model_provider": "p", "enabled_toolsets": ["memory"]}
    with scoped_home(home):
        result = chat.start(Ctx(), params)
    assert result["status"] == "completed", result

turn(0, "configured")
turn(1, "configured")
config.write_text("fallback_providers:\\n  - provider: openrouter\\n    model: z-ai/glm-5\\n")
turn(2, "configured")
turn(3, "plain", root / "profiles" / "plain")
print(json.dumps(seen))
"""

CONFIG = """\
fallback_providers:
  - provider: openrouter
    model: anthropic/claude-sonnet-4
  - provider: nous
    model: hermes-4
fallback_model:
  - provider: OpenRouter
    model: anthropic/claude-sonnet-4
  - provider: zai
    model: glm-5
"""


@requires_agent
def test_turns_carry_the_profile_fallback_chain_and_rebuild_when_it_changes(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "config.yaml").write_text(CONFIG)
    (root / "profiles" / "plain").mkdir(parents=True)
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "HERMES_HOME": str(root), "PYTHONPATH": str(SIDECAR_ROOT), "HERMES_STATE_DB_GUARD_BYPASS": "1"}
    if os.environ.get("LD_LIBRARY_PATH"):  # relocated actions/setup-python interpreter
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    seen = json.loads(run.stdout.strip().splitlines()[-1])
    routes = [[(entry["provider"], entry["model"]) for entry in chain or []] for chain in seen]
    # ``fallback_providers`` first, then legacy ``fallback_model`` minus the route it repeats; the unchanged chain
    # reuses the cached agent, and the edited chain builds a new one.
    assert routes[0] == [("openrouter", "anthropic/claude-sonnet-4"), ("nous", "hermes-4"), ("zai", "glm-5")], seen
    assert routes[1:] == [[("openrouter", "z-ai/glm-5")], []], seen
    # A profile without a chain constructs the agent without one.
    assert seen[-1] is None, seen
