"""Agent 0.21.3's auth registry snapshot precedes every Agent method, against stand-in Agent modules.

Agent 0.21.3 snapshots its provider registry, discovered plugins included, when ``hermes_cli.auth`` first imports.
A first import inside a named profile's scope would put that profile's plugins in a snapshot every profile reads.
"""

from __future__ import annotations

import importlib.util
import sys
import types

from talaria_sidecar.methods import Registry
from talaria_sidecar.runtime import AgentRuntime


def test_an_agent_method_runs_only_after_the_auth_snapshot(monkeypatch, tmp_path) -> None:
    order = []
    run_agent = types.ModuleType("run_agent")  # Unlike the real one, it does not import hermes_cli.auth itself.
    run_agent.AIAgent = object
    package = types.ModuleType("hermes_cli")
    package.__path__ = []
    monkeypatch.setitem(sys.modules, "run_agent", run_agent)
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.delitem(sys.modules, "hermes_cli.auth", raising=False)

    class AuthFinder:
        def find_spec(self, name, path=None, target=None):
            if name != "hermes_cli.auth":
                return None

            class Loader:
                def create_module(self, spec):
                    order.append("auth snapshot")
                    return types.ModuleType(name)

                def exec_module(self, module):
                    pass

            return importlib.util.spec_from_loader(name, Loader())

    monkeypatch.setattr(sys, "meta_path", [AuthFinder(), *sys.meta_path])
    runtime = AgentRuntime(tmp_path)
    monkeypatch.setattr(runtime, "ensure_current", lambda: None)
    registry = Registry(runtime)
    registry.method("plugins.providers")(lambda ctx, params: order.append("method body"))
    registry.methods["plugins.providers"](None, {})
    assert order == ["auth snapshot", "method body"]
