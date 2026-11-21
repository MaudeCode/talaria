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
    expected = {"pinned": "pinned", "fallback": "fallback", "detected": None}
    assert out["live"] == expected
    assert out["route"] == expected


def test_a_marker_that_raises_or_answers_empty_gives_null(monkeypatch) -> None:
    def boom(_agent):
        raise RuntimeError("synthetic")
    module = ModuleType("agent.context_pin")
    monkeypatch.setitem(sys.modules, "agent.context_pin", module)
    agent = SimpleNamespace(context_compressor=SimpleNamespace(context_length=1))
    for marker in (boom, lambda _agent: ""):
        module.agent_context_marker = marker
        assert chat._context_length(agent) == {"context_length": 1, "context_window_source": None}


SELECTION_PROBE = """
import json, os, sys
from pathlib import Path
from types import SimpleNamespace
sys.path.append(sys.argv[1])
import agent.model_metadata as metadata
import hermes_cli.left_core_migration as left_core
from talaria_sidecar.methods import Registry, providers

home, lab, keyed = Path(os.environ["HERMES_HOME"]), sys.argv[2], sys.argv[3]
sent, delivered = [], []
metadata.get_model_context_length = lambda model, **kw: sent.append(kw) or 123456
left_core.recover_for_provider = lambda name: delivered.append(name)
registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
providers.register(registry)
lookup = registry.methods["models.context_length"]
pool = lambda: json.loads((home / "auth.json").read_text())["credential_pool"]
before = pool()
for provider, url in [("lab", lab)] * 3 + [("keyed", keyed)] * 2 + [("lab", "https://elsewhere.invalid/v1")]:
    reply = lookup(None, {"profile_home": str(home), "model": "synthetic-model", "provider": provider,
                          "base_url": url, "config_context_length": 64000})
    assert reply["context_length"] == 123456, reply
try:
    from hermes_cli.runtime_provider_custom import main_endpoint_key_for
    selector = True
except ImportError:
    selector = False
print(json.dumps({"sent": [[kw["base_url"], kw["api_key"], kw["config_context_length"]] for kw in sent],
                  "pool_unchanged": pool() == before, "delivered": delivered, "selector": selector}))
"""


@requires_agent
def test_repeated_lookups_leave_inference_credentials_untouched(tmp_path) -> None:
    """TAL-2595: a context-window read selects no pool row, mints no key_cmd token and delivers no plugin; it sends
    only the Agent's metadata selection for the configured main endpoint (0.23.3+), else nothing."""
    root, lab, keyed = tmp_path / ".hermes", "https://lab.invalid/v1", "https://keyed.invalid/v1"
    root.mkdir()
    minted = tmp_path / "minted"
    (root / "config.yaml").write_text(json.dumps({
        "model": {"provider": "lab", "default": "synthetic-model", "base_url": lab},
        "providers": {"lab": {"base_url": lab},
                      "keyed": {"base_url": keyed, "key_cmd": f"touch {minted} && echo sk-synthetic-minted"}},
        "credential_pool_strategies": {"lab": "round_robin"}}))
    rows = [{"id": f"k{i}", "label": f"row{i}", "auth_type": "api_key", "priority": i, "source": "manual",
             "access_token": f"sk-synthetic-pool-{i}", "base_url": lab} for i in (1, 2)]
    (root / "auth.json").write_text(json.dumps({"version": 1, "providers": {}, "credential_pool": {"lab": rows}}))
    run = subprocess.run([AGENT_PYTHON, "-c", SELECTION_PROBE, str(AGENT_DIR), lab, keyed],
                         env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    matched = "sk-synthetic-pool-1" if out["selector"] else ""
    assert out["sent"] == [[lab, matched, 64000]] * 3 + [[keyed, "", 64000]] * 2 + [["https://elsewhere.invalid/v1", "", 64000]]
    assert out["pool_unchanged"]
    assert not minted.exists()
    assert out["delivered"] == []


def _fail(exc):
    def selector(model_cfg, base_url):
        raise exc
    return selector


@pytest.mark.parametrize("selector,provider,expected", [
    (lambda cfg, url: f"sk-synthetic-{cfg['provider']}@{url}", "", "sk-synthetic-lab@https://lab.invalid/v1"),
    (lambda cfg, url: f"sk-synthetic-{cfg['provider']}@{url}", " LAB ", "sk-synthetic-lab@https://lab.invalid/v1"),
    (lambda cfg, url: "sk-synthetic-other", "custom:box", ""),
    (lambda cfg, url: lambda: "sk-synthetic-minted", "lab", ""),
    (_fail(RuntimeError("synthetic selector failure")), "lab", ""),
    (_fail(SystemExit("synthetic config backend outage")), "lab", ""),
    (None, "lab", ""),
], ids=["main-route", "same-provider", "other-route", "credential-source", "raises", "backend-exit", "older-agent"])
def test_lookup_sends_only_the_agents_main_endpoint_selection(monkeypatch, selector, provider, expected) -> None:
    custom = ModuleType("hermes_cli.runtime_provider_custom")
    if selector is not None:
        custom.main_endpoint_key_for = selector
    config = ModuleType("hermes_cli.config")
    config.load_config = lambda: {"model": {"provider": "lab", "base_url": "https://lab.invalid/v1"}}
    recorded = []
    metadata = ModuleType("agent.model_metadata")
    metadata.get_model_context_length = lambda model, **kw: recorded.append(kw) or 123456
    for name, module in {"hermes_cli": ModuleType("hermes_cli"), "hermes_cli.config": config,
                         "hermes_cli.runtime_provider_custom": custom, "agent": ModuleType("agent"),
                         "agent.model_metadata": metadata}.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(providers, "scoped_home", lambda *a: nullcontext())
    monkeypatch.setattr(providers, "context_window_source", lambda *a, **kw: None)
    registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    providers.register(registry)
    reply = registry.methods["models.context_length"](None, {
        "profile_home": "unused", "model": "synthetic-model", "provider": provider,
        "base_url": "https://lab.invalid/v1", "config_context_length": 64000,
    })
    assert reply["context_length"] == 123456
    assert (recorded[0]["base_url"], recorded[0]["api_key"], recorded[0]["config_context_length"]) == (
        "https://lab.invalid/v1", expected, 64000)
