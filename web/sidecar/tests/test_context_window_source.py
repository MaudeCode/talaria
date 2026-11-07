"""TAL-1908: a chat's window carries the Agent's own label when it is a pin or a default, on both read paths."""
from __future__ import annotations

from contextlib import nullcontext
import json
import subprocess
import sys
from types import ModuleType, SimpleNamespace

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent
from talaria_sidecar.methods import Registry, chat, providers

# Runs on the Agent interpreter with the real resolver and compressor; only its network lookups are stubbed.
PROBE = """
import json, os, sys
from pathlib import Path
from types import SimpleNamespace
sys.path.append(sys.argv[1])
import agent.model_metadata as metadata
from agent.context_compressor import ContextCompressor
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import Registry, chat, providers

metadata.fetch_model_metadata = lambda *a, **k: {}
metadata.fetch_endpoint_model_metadata = lambda *a, **k: {}
metadata.detect_local_server_type = lambda *a, **k: None
registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
providers.register(registry)
lookup = registry.methods["models.context_length"]
UNKNOWN, KNOWN = "synthetic-unlisted-model", "claude-sonnet-4-5"

def live(model, pin=None):
    compressor = ContextCompressor(model, config_context_length=pin, quiet_mode=True, provider="synthetic")
    return chat._context_length(SimpleNamespace(context_compressor=compressor)).get("context_window_source", "absent")

def route(model, pin=None):
    return lookup(None, {"profile_home": os.environ["HERMES_HOME"], "model": model, "provider": "synthetic", "config_context_length": pin}).get("context_window_source", "absent")

with scoped_home(Path(os.environ["HERMES_HOME"])):
    print(json.dumps({
        "live": {"pinned": live(UNKNOWN, 200000), "fallback": live(UNKNOWN), "detected": live(KNOWN)},
        "route": {"pinned": route(UNKNOWN, 200000), "fallback": route(UNKNOWN), "detected": route(KNOWN)},
    }))
"""


@requires_agent
def test_live_agent_and_lookup_report_the_agents_marker(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    assert out["live"] == {"pinned": "pinned", "fallback": "fallback", "detected": None}
    assert out["route"] == {"pinned": "pinned", "fallback": "fallback", "detected": None}


def test_an_agent_without_the_markers_gives_null_and_does_not_raise(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(providers, "scoped_home", lambda *a: nullcontext())
    monkeypatch.setattr(providers, "context_length", lambda *a, **k: 256_000)
    registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    providers.register(registry)
    agent = SimpleNamespace(context_compressor=SimpleNamespace(context_length=256_000))
    # A release with the module but not the functions, then one without the module.
    for module in (ModuleType("agent.context_pin"), None):
        monkeypatch.setitem(sys.modules, "agent.context_pin", module)
        reply = registry.methods["models.context_length"](None, {"profile_home": str(tmp_path), "model": "m"})
        assert reply == {"model": "m", "context_length": 256_000, "context_window_source": None}
        assert chat._context_length(agent) == {"context_length": 256_000, "context_window_source": None}


def test_a_marker_that_raises_or_answers_empty_gives_null(monkeypatch) -> None:
    def boom(_agent):
        raise RuntimeError("synthetic")
    module = ModuleType("agent.context_pin")
    monkeypatch.setitem(sys.modules, "agent.context_pin", module)
    agent = SimpleNamespace(context_compressor=SimpleNamespace(context_length=1))
    for marker in (boom, lambda _agent: ""):
        module.agent_context_marker = marker
        assert chat._context_length(agent) == {"context_length": 1, "context_window_source": None}
