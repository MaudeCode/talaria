"""TAL-1908: a chat's window carries the Agent's own label when it is a pin or a default, on both read paths."""
from __future__ import annotations

from contextlib import nullcontext
import json
import subprocess
import sys
from types import ModuleType, SimpleNamespace

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent
from talaria_sidecar.methods import Registry, chat, providers

# Runs on the Agent interpreter with the real resolver and compressor; only its network lookups are stubbed.
PROBE = """
import importlib, json, os, sys
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
        "has_markers": hasattr(importlib.import_module("agent.context_pin"), "agent_context_marker"),
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
    # Supported releases before v0.23.0 have no markers, so a real Agent without them shows no label.
    expected = {"pinned": "pinned", "fallback": "fallback", "detected": None} if out["has_markers"] else {"pinned": None, "fallback": None, "detected": None}
    assert out["live"] == expected
    assert out["route"] == expected


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


ROUTING_PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from hermes_cli.runtime_provider import resolve_runtime_provider
import agent.model_metadata as metadata
import agent.context_pin as context_pin
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import Registry, providers
from types import SimpleNamespace

home = Path(os.environ["HERMES_HOME"])
provider = json.loads((home / "config.yaml").read_text())["model"]["provider"]
with scoped_home(home):
    runtime = resolve_runtime_provider(requested=provider, target_model="synthetic-model")
recorded, marked = [], []
metadata.get_model_context_length = lambda model, **kw: recorded.append(kw) or 123456
context_pin.context_window_marker = lambda *a, **kw: marked.append(kw) or None
registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
providers.register(registry)
reply = registry.methods["models.context_length"](None, {
    "profile_home": str(home), "model": "synthetic-model", "provider": provider,
    "base_url": sys.argv[2], "api_key": sys.argv[3], "config_context_length": 123456,
})
print(json.dumps({"runtime": [runtime["base_url"], runtime["api_key"]],
                  "lookup": [recorded[0]["base_url"], recorded[0]["api_key"]],
                  "marker_url": marked[0]["base_url"], "reply": reply}))
"""


@requires_agent
@pytest.mark.parametrize("provider,config,env,server_url,expected", [
    ("custom:box", {"model": {"base_url": "https://modelblock.invalid/v1"}, "providers": {
        "custom:box": {"api": "https://box.invalid/v1", "api_key": "sk-synthetic-box"}}}, {},
     "https://modelblock.invalid/v1", ["https://box.invalid/v1", "sk-synthetic-box"]),
    ("openrouter", {"custom_providers": [{"name": "openrouter", "base_url": "https://legacy.invalid/v1"}]},
     {"OPENROUTER_API_KEY": "sk-synthetic-openrouter"}, "https://legacy.invalid/v1",
     ["https://openrouter.ai/api/v1", "sk-synthetic-openrouter"]),
    ("anthropic", {"model": {"base_url": "https://proxy.invalid/v1"}},
     {"ANTHROPIC_API_KEY": "sk-synthetic-anthropic"}, "https://proxy.invalid/v1",
     ["https://api.anthropic.com", "sk-synthetic-anthropic"]),
], ids=["custom-owner", "builtin-legacy-name", "anthropic-proxy"])
def test_lookup_keeps_the_agents_runtime_key_and_url_together(tmp_path, provider, config, env, server_url, expected) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    config.setdefault("model", {})["provider"] = provider
    (root / "config.yaml").write_text(json.dumps(config))
    run = subprocess.run([AGENT_PYTHON, "-c", ROUTING_PROBE, str(AGENT_DIR), server_url, expected[1]],
                         env=isolated_env(root, **env), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    assert out["runtime"] == expected
    assert out["lookup"] == out["runtime"]
    assert out["marker_url"] == out["lookup"][0]
    assert out["reply"]["context_length"] == 123456


@pytest.mark.parametrize("resolver", ["raises", "missing"])
def test_lookup_without_runtime_resolution_uses_a_keyless_fallback(tmp_path, monkeypatch, resolver) -> None:
    def fail(**kwargs):
        raise RuntimeError("synthetic resolver failure")

    module = ModuleType("hermes_cli.runtime_provider")
    if resolver == "raises":
        module.resolve_runtime_provider = fail
    monkeypatch.setitem(sys.modules, "hermes_cli", ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.runtime_provider", module)
    recorded = []
    metadata = ModuleType("agent.model_metadata")
    metadata.get_model_context_length = lambda model, **kw: recorded.append(kw) or 123456
    monkeypatch.setitem(sys.modules, "agent", ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.model_metadata", metadata)
    monkeypatch.setattr(providers, "scoped_home", lambda *a: nullcontext())
    monkeypatch.setattr(providers, "context_window_source", lambda *a, **kw: None)
    registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    providers.register(registry)
    reply = registry.methods["models.context_length"](None, {
        "profile_home": str(tmp_path), "model": "synthetic-model", "provider": "custom:box",
        "base_url": "https://fallback.invalid/v1", "api_key": "sk-synthetic-server",
    })
    assert reply["context_length"] == 123456
    assert (recorded[0]["base_url"], recorded[0]["api_key"]) == ("https://fallback.invalid/v1", "")
