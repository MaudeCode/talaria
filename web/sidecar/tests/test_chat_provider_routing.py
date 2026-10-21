"""``chat.start`` hands the profile's OpenRouter ``provider_routing`` and ``openrouter.min_coding_score`` to ``AIAgent``
with the Agent CLI's mapping, and a routing edit rebuilds the cached agent like the fallback chain does (TAL-976)."""

from __future__ import annotations

import json
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

ROUTING = ("providers_allowed", "providers_ignored", "providers_order", "provider_sort", "provider_require_parameters",
           "provider_data_collection", "openrouter_min_coding_score")

# Runs on the Agent interpreter: real config loading, a stand-in AIAgent that records its kwargs.
PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

NAMES = %r
seen = []

class FakeAgent:
    def __init__(self, **kwargs):
        seen.append({name: kwargs.get(name, "<unset>") for name in NAMES})

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
config.write_text("provider_routing:\\n  sort: throughput\\n")
turn(2, "configured")
turn(3, "plain", root / "profiles" / "plain")
print(json.dumps(seen))
"""

CONFIG = """\
provider_routing:
  sort: price
  only: [anthropic, google]
  ignore: [deepinfra]
  order: [google, anthropic]
  require_parameters: true
  data_collection: deny
openrouter:
  min_coding_score: "0.8"
"""


@requires_agent
def test_turns_carry_the_profile_provider_routing_and_rebuild_when_it_changes(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "config.yaml").write_text(CONFIG)
    (root / "profiles" / "plain").mkdir(parents=True)
    (root / "profiles" / "plain" / "config.yaml").write_text("openrouter:\n  min_coding_score: 1.5\n")
    env = isolated_env(root)
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE % (ROUTING,), str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    seen = json.loads(run.stdout.strip().splitlines()[-1])
    assert seen[0] == {
        "providers_allowed": ["anthropic", "google"], "providers_ignored": ["deepinfra"], "providers_order": ["google", "anthropic"],
        "provider_sort": "price", "provider_require_parameters": True, "provider_data_collection": "deny",
        "openrouter_min_coding_score": 0.8,
    }, seen
    # The unchanged block reuses the cached agent; the edited one builds a new agent on the next turn.
    assert len(seen) == 3, seen
    assert seen[1]["provider_sort"] == "throughput" and seen[1]["providers_allowed"] is None, seen
    # A quoted score counts, as in the Agent CLI. A profile without ``provider_routing`` gets the Agent defaults, and an
    # out-of-range score stays unset.
    assert seen[2] == {name: False if name == "provider_require_parameters" else None for name in ROUTING}, seen
