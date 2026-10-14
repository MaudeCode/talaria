"""TAL-1005: ``chat.start`` reports ``next_turn_threshold_tokens``, the compression threshold the next turn runs under.
A turn that ended on a fallback leaves the fallback's threshold on the compressor, but the Agent restores the primary
runtime when the next turn starts, so the server compacts against the primary's threshold."""

from __future__ import annotations

import json
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

# Runs on the Agent interpreter: a stand-in AIAgent holding the Agent's real ContextCompressor, which a fallback
# switches to a larger window mid-turn the way ``_try_activate_fallback`` does.
PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from agent.context_compressor import ContextCompressor
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

def agent_class(fallback):
    class FakeAgent:
        def __init__(self, **kwargs):
            self.context_compressor = ContextCompressor("primary-model", config_context_length=200000, quiet_mode=True, provider="primary")
            cc = self.context_compressor
            self._fallback_activated = False
            # The Agent's ``_snapshot_primary_runtime`` compressor fields.
            self._primary_runtime = {"compressor_model": cc.model, "compressor_provider": cc.provider, "compressor_context_length": cc.context_length, "compressor_threshold_tokens": cc.threshold_tokens}

        def run_conversation(self, **kwargs):
            if fallback:
                self.context_compressor.update_model(model="fallback-model", context_length=1000000, provider="fallback")
                self._fallback_activated = True
            return {"final_response": "ok", "messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "ok"}]}
    return FakeAgent

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._resolve_runtime = lambda provider, model: {"model": "primary-model", "provider": "primary"}
home = Path(os.environ["HERMES_HOME"])
primary = ContextCompressor("primary-model", config_context_length=200000, quiet_mode=True, provider="primary").threshold_tokens
out = {"primary": primary}
for i, fallback in enumerate((False, True)):
    cls = agent_class(fallback)
    chat._agent_class = lambda: cls
    params = {"profile_home": str(home), "session_id": f"s{i}", "stream_id": f"st{i}", "user_message": "hi", "model": "primary-model", "model_provider": "primary", "enabled_toolsets": ["memory"]}
    with scoped_home(home):
        result = chat.start(Ctx(), params)
    out["fallback" if fallback else "primary_turn"] = result["context"]
print(json.dumps(out))
"""


@requires_agent
def test_next_turn_threshold_is_the_primary_runtimes_after_a_fallback_turn(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    primary = out["primary"]
    # A turn on the primary: the next turn's threshold is the one it ran under.
    assert out["primary_turn"]["threshold_tokens"] == primary, out
    assert out["primary_turn"].get("next_turn_threshold_tokens") == primary, out
    # A turn that ended on the larger-window fallback reports the fallback's threshold, and the primary's for the next turn.
    assert out["fallback"]["threshold_tokens"] > primary, out
    assert out["fallback"].get("next_turn_threshold_tokens") == primary, out
