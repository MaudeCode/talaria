"""Credential scoping for Agent calls, driven in-process with a stand-in ``agent.secret_scope``."""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

import pytest

from talaria_sidecar import home as home_module
from talaria_sidecar.errors import RpcError


def _fake_secret_scope(calls: list) -> types.ModuleType:
    module = types.ModuleType("agent.secret_scope")

    def build_profile_secret_scope(hermes_home):
        env = Path(hermes_home) / ".env"
        secrets = {}
        if env.exists():
            for line in env.read_text().splitlines():
                key, _, value = line.partition("=")
                secrets[key.strip()] = value.strip()
        return secrets

    def set_secret_scope(secrets):
        calls.append(("scope", dict(secrets)))
        return "scope-token"

    def reset_secret_scope(token):
        calls.append(("reset-scope", token))

    def set_multiplex_context(active):
        calls.append(("multiplex", active))
        return "mux-token"

    def reset_multiplex_context(token):
        calls.append(("reset-multiplex", token))

    module.build_profile_secret_scope = build_profile_secret_scope
    module.set_secret_scope = set_secret_scope
    module.reset_secret_scope = reset_secret_scope
    module.set_multiplex_context = set_multiplex_context
    module.reset_multiplex_context = reset_multiplex_context
    return module


@pytest.fixture
def scope_calls(monkeypatch):
    calls: list = []
    agent = types.ModuleType("agent")
    agent.secret_scope = _fake_secret_scope(calls)
    monkeypatch.setitem(sys.modules, "agent", agent)
    monkeypatch.setitem(sys.modules, "agent.secret_scope", agent.secret_scope)
    return calls


def test_named_profile_runs_under_its_own_secrets_with_multiplex_semantics(tmp_path, monkeypatch, scope_calls) -> None:
    root = tmp_path / "root"
    named = root / "profiles" / "work"
    named.mkdir(parents=True)
    (named / ".env").write_text("OPENAI_API_KEY=sk-work\n")
    monkeypatch.setattr(home_module, "_PROCESS_HOME", root)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-root-from-startup-dotenv")
    with home_module.scoped_home(named):
        assert os.environ["HERMES_HOME"] == str(named)
        assert ("scope", {"OPENAI_API_KEY": "sk-work"}) in scope_calls
        assert ("multiplex", True) in scope_calls
    assert scope_calls[-2:] == [("reset-multiplex", "mux-token"), ("reset-scope", "scope-token")]


def test_root_profile_keeps_single_profile_semantics(tmp_path, monkeypatch, scope_calls) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (root / ".env").write_text("OPENAI_API_KEY=sk-root\n")
    monkeypatch.setattr(home_module, "_PROCESS_HOME", root)
    with home_module.scoped_home(root):
        assert ("scope", {"OPENAI_API_KEY": "sk-root"}) in scope_calls
        assert not any(name == "multiplex" for name, _ in scope_calls)


def test_named_profile_fails_closed_without_a_secret_scope(tmp_path, monkeypatch) -> None:
    root = tmp_path / "root"
    named = root / "profiles" / "work"
    named.mkdir(parents=True)
    monkeypatch.setattr(home_module, "_PROCESS_HOME", root)
    monkeypatch.setitem(sys.modules, "agent", None)
    monkeypatch.setitem(sys.modules, "agent.secret_scope", None)
    with pytest.raises(RpcError) as excinfo:
        with home_module.scoped_home(named):
            pass
    assert excinfo.value.data["condition"] == "agent_incompatible"
    # The root profile still runs (its credentials are the process's own).
    with home_module.scoped_home(root):
        assert os.environ["HERMES_HOME"] == str(root)
