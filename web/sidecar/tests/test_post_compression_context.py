"""TAL-539: a turn that auto-compressed mid-run can run more tools afterwards; their raw output is model context the
compressor never pruned. ``chat.start`` returns that context pruned (the compressor's own pass, then a hard cap) plus a
request-size estimate, and leaves the display ``messages`` untouched."""

from __future__ import annotations

import json
import os
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, requires_agent

# Runs on the Agent interpreter: a stand-in AIAgent holding the Agent's real ContextCompressor.
PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from agent.context_compressor import ContextCompressor
from agent.model_metadata import estimate_tokens_rough
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

RAW = "line of tool output\\n" * 20000
DENSE = "漢字" * 20000

class NoPrune(ContextCompressor):
    def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None, **kwargs):
        return messages, 0

def agent_class(compressor, compress, raw=RAW):
    class FakeAgent:
        tools = [{"type": "function", "function": {"name": "read_file", "parameters": {}}}]

        def __init__(self, **kwargs):
            self.context_compressor = compressor

        def run_conversation(self, **kwargs):
            if compress:
                self.context_compressor.compression_count += 1
            return {
                "final_response": "Done.",
                "messages": [
                    {"role": "user", "content": "[CONTEXT COMPACTION] summary"},
                    {"role": "user", "content": "read it"},
                    {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
                    {"role": "tool", "tool_call_id": "c1", "content": raw},
                    {"role": "assistant", "content": "Done."},
                ],
            }
    return lambda: FakeAgent

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
home = Path(os.environ["HERMES_HOME"])
out = {}
cases = [
    ("agent_prune", ContextCompressor, True, RAW, ""),
    ("hard_cap", NoPrune, True, RAW, ""),
    ("dense", NoPrune, True, DENSE, ""),
    ("ephemeral", ContextCompressor, True, RAW, "Personality. " * 8000),
    ("uncompressed", ContextCompressor, False, RAW, ""),
]
for i, (name, cls, compress, raw, ephemeral) in enumerate(cases):
    compressor = cls("m", config_context_length=100000, quiet_mode=True, provider="p")
    chat._agent_class = agent_class(compressor, compress, raw)
    params = {"profile_home": str(home), "session_id": f"s{i}", "stream_id": f"st{i}", "user_message": "read it", "model": "m", "model_provider": "p", "enabled_toolsets": ["memory"], "system_message": "You are helpful.", "ephemeral_system_prompt": ephemeral}
    with scoped_home(home):
        result = chat.start(Ctx(), params)
    context = result.get("context_messages")
    out[name] = {
        "display_raw": result["messages"][3]["content"] == raw,
        "within_budget": estimate_tokens_rough(context[3]["content"]) <= compressor.tail_token_budget if context else None,
        "context_len": len(context[3]["content"]) if context else None,
        "context_roles": [m["role"] for m in context] if context else None,
        "estimate": result.get("post_compression_context_tokens_estimate"),
        "marker": "[Talaria context budget:" in (context[3]["content"] if context else ""),
    }
print(json.dumps(out))
"""


@requires_agent
def test_an_auto_compressed_turn_returns_pruned_context_and_its_estimate(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "HERMES_HOME": str(root), "PYTHONPATH": str(SIDECAR_ROOT), "HERMES_STATE_DB_GUARD_BYPASS": "1"}
    if os.environ.get("LD_LIBRARY_PATH"):  # relocated actions/setup-python interpreter
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    raw_len = len("line of tool output\n" * 20000)
    roles = ["user", "user", "assistant", "tool", "assistant"]
    # The Agent's own pruning shrinks the tail tool result; the visible transcript keeps it whole.
    agent_prune = out["agent_prune"]
    assert agent_prune["display_raw"] and agent_prune["context_roles"] == roles
    assert agent_prune["context_len"] < 4000
    # The estimate is the pruned request's size, far below the raw output's ~100k rough tokens.
    assert isinstance(agent_prune["estimate"], int) and 0 < agent_prune["estimate"] < 10000
    # A compressor that prunes nothing still leaves the result under the hard cap, with a note naming what was cut.
    hard_cap = out["hard_cap"]
    assert hard_cap["display_raw"] and hard_cap["context_roles"] == roles and hard_cap["marker"]
    assert hard_cap["context_len"] < raw_len // 4
    assert isinstance(hard_cap["estimate"], int) and hard_cap["estimate"] > 0
    assert hard_cap["within_budget"]
    # Token-dense output (CJK) is measured with the Agent's estimator, so the cap holds in tokens, not just characters.
    assert out["dense"]["marker"] and out["dense"]["within_budget"]
    # The next request also carries the ephemeral system prompt, so the estimate counts it (~26k rough tokens here).
    assert out["ephemeral"]["estimate"] > agent_prune["estimate"] + 20000
    # Without a compression the turn reports neither.
    assert out["uncompressed"] == {"display_raw": True, "within_budget": None, "context_len": None, "context_roles": None, "estimate": None, "marker": False}
