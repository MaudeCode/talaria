"""Startup applies the Agent's process resource limits before the RPC server starts any worker thread.

The sidecar is a long-lived multi-threaded server like ``hermes gateway`` / ``hermes serve``: glibc hands
contending threads new malloc arenas that are never unmapped, so ``apply_malloc_arena_max`` must run before
the first worker thread exists, and ``apply_nofile_soft_limit`` sits beside it. Older Agents lack the module;
non-Linux hosts make the helpers no-ops; neither may stop startup.
"""
from __future__ import annotations

import importlib
import sys
import types
from types import SimpleNamespace

import pytest

from talaria_sidecar import __main__ as main


@pytest.fixture
def startup(monkeypatch, tmp_path):
    """Run ``main()`` in-process with a fake transport and RPC server; returns the recorded startup events."""
    events: list[str] = []
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setenv("HERMES_EXEC_ASK", "1")
    monkeypatch.delenv("TALARIA_SIDECAR_AGENT_DIR", raising=False)
    monkeypatch.setenv("HERMES_WEBUI_AGENT_DIR", str(agent_dir))
    monkeypatch.setattr(main, "_claim_stdout", lambda: None)
    monkeypatch.setattr(main, "AgentRuntime", lambda home, agent_dir=None: SimpleNamespace(agent_dir=agent_dir, retire=lambda: None))
    monkeypatch.setattr(main, "build_methods", lambda runtime: {})
    for module, name in (("talaria_sidecar.methods.chat", "drain_agents"), ("talaria_sidecar.agent_mutation", "close_all"),
                         ("talaria_sidecar.methods.dashboard_plugins", "close_dashboard_sources")):
        monkeypatch.setattr(importlib.import_module(module), name, lambda: None)

    class Server:
        def __init__(self, methods, *, stdout=None, max_calls=None):
            events.append("server-constructed")

        def serve_forever(self):
            events.append("serve_forever")
            return 7

    monkeypatch.setattr(main, "RpcServer", Server)

    def install(**helpers):
        module = types.ModuleType("hermes_cli.resource_limits")
        for name, outcome in helpers.items():
            def helper(_name=name, _outcome=outcome):
                assert str(agent_dir) in sys.path, "the Agent checkout must be importable before its helper runs"
                events.append(_name)
                if isinstance(_outcome, Exception):
                    raise _outcome
                return _outcome
            setattr(module, name, helper)
        package = types.ModuleType("hermes_cli")
        package.resource_limits = module
        monkeypatch.setitem(sys.modules, "hermes_cli", package)
        monkeypatch.setitem(sys.modules, "hermes_cli.resource_limits", module)

    return SimpleNamespace(events=events, install=install)


def test_resource_limits_apply_once_before_the_server_starts(startup):
    startup.install(apply_malloc_arena_max=True, apply_nofile_soft_limit=True)
    assert main.main() == 7
    assert startup.events == ["apply_malloc_arena_max", "apply_nofile_soft_limit", "server-constructed", "serve_forever"]


@pytest.mark.parametrize("degraded", ["module-missing", "helpers-missing", "helpers-raise"])
def test_startup_survives_an_agent_without_working_resource_limits(startup, monkeypatch, degraded):
    if degraded == "module-missing":
        for name in ("hermes_cli", "hermes_cli.resource_limits"):
            monkeypatch.setitem(sys.modules, name, None)
    elif degraded == "helpers-missing":
        startup.install()
    else:
        startup.install(apply_malloc_arena_max=RuntimeError("no glibc"), apply_nofile_soft_limit=OSError("rlimit denied"))
    assert main.main() == 7
    assert startup.events[-2:] == ["server-constructed", "serve_forever"]
