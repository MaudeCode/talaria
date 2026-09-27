"""Credential scoping for Agent calls, driven in-process with a stand-in ``agent.secret_scope``."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, requires_agent
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

    module.build_profile_secret_scope = build_profile_secret_scope
    module.set_secret_scope = set_secret_scope
    module.reset_secret_scope = reset_secret_scope
    return module


@pytest.fixture
def scope_calls(monkeypatch):
    calls: list = []
    agent = types.ModuleType("agent")
    agent.secret_scope = _fake_secret_scope(calls)
    env_loader = types.ModuleType("hermes_cli.env_loader")
    env_loader.hydrate_profile_secret_sources = lambda home: calls.append(("hydrate", Path(home)))
    launch_policy = types.ModuleType("tui_gateway.launch_profile_policy")
    launch_policy.activate_multi_profile_hosting = lambda: calls.append(("activate", True))
    launch_policy.launch_secret_scope = lambda home: calls.append(("launch-scope", Path(home))) or agent.secret_scope.build_profile_secret_scope(home)
    monkeypatch.setitem(sys.modules, "agent", agent)
    monkeypatch.setitem(sys.modules, "agent.secret_scope", agent.secret_scope)
    monkeypatch.setitem(sys.modules, "hermes_cli.env_loader", env_loader)
    monkeypatch.setitem(sys.modules, "tui_gateway.launch_profile_policy", launch_policy)
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
        assert ("activate", True) in scope_calls
        assert ("hydrate", named) in scope_calls
    assert scope_calls[-1] == ("reset-scope", "scope-token")


def test_root_profile_keeps_single_profile_semantics(tmp_path, monkeypatch, scope_calls) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (root / ".env").write_text("OPENAI_API_KEY=sk-root\n")
    monkeypatch.setattr(home_module, "_PROCESS_HOME", root)
    with home_module.scoped_home(root):
        assert ("launch-scope", root) in scope_calls
        assert ("scope", {"OPENAI_API_KEY": "sk-root"}) in scope_calls
        assert not any(name == "activate" for name, _ in scope_calls)


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


def test_agent_0_21_3_mirrors_the_launch_profile_policy(tmp_path, monkeypatch, scope_calls) -> None:
    root = tmp_path / "root"
    named = root / "profiles" / "work"
    named.mkdir(parents=True)
    (root / ".env").write_text("ROOT_FILE=root\n")
    (named / ".env").write_text("OPENAI_API_KEY=sk-work\n")
    monkeypatch.setattr(home_module, "_PROCESS_HOME", root)
    monkeypatch.setattr(home_module, "_LAUNCH_ENV", None)
    monkeypatch.setitem(sys.modules, "tui_gateway.launch_profile_policy", None)
    scope = sys.modules["agent.secret_scope"]
    multiplex = []
    monkeypatch.setattr(scope, "_is_global_env", lambda name: name in {"HERMES_HOME", "PATH"}, raising=False)
    monkeypatch.setattr(scope, "is_multiplex_active", lambda: bool(multiplex), raising=False)
    monkeypatch.setattr(scope, "set_multiplex_active", lambda active: multiplex.append(active), raising=False)
    for name in list(os.environ):
        if name not in {"HERMES_HOME", "PATH"}:
            monkeypatch.delenv(name)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-launch")

    with home_module.scoped_home(root):
        assert scope_calls[-1] == ("scope", {"OPENAI_API_KEY": "sk-launch", "ROOT_FILE": "root"})
    assert multiplex == []

    with pytest.raises(ValueError, match="test body"):
        with home_module.scoped_home(named):
            assert multiplex == [True]
            assert ("hydrate", named) in scope_calls
            assert scope_calls[-1] == ("scope", {"OPENAI_API_KEY": "sk-work"})
            raise ValueError("test body")
    assert scope_calls[-1] == ("reset-scope", "scope-token")

    # The launch environment was frozen at activation; later process-env writes never reach it.
    monkeypatch.setenv("LEAKED_LATER", "x")
    with home_module.scoped_home(root):
        assert scope_calls[-1] == ("scope", {"OPENAI_API_KEY": "sk-launch", "ROOT_FILE": "root"})
    assert multiplex == [True]

    # A partial implementation is not permission to leak the launch profile's credentials.
    monkeypatch.delattr(scope, "set_multiplex_active")
    with pytest.raises(RpcError) as excinfo:
        with home_module.scoped_home(named):
            pytest.fail("missing isolation must not reach the body")
    assert excinfo.value.data["condition"] == "agent_incompatible"


@requires_agent
def test_concurrent_profiles_resolve_only_their_own_credentials_on_the_installed_agent(tmp_path) -> None:
    root = tmp_path / ".hermes"
    for name, dotenv in (("alpha", "OPENAI_API_KEY=sk-alpha\nALPHA_ONLY=alpha\n"), ("beta", "OPENAI_API_KEY=sk-beta\n")):
        (root / "profiles" / name).mkdir(parents=True)
        (root / "profiles" / name / ".env").write_text(dotenv)
    env = {
        "PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "HERMES_HOME": str(root), "PYTHONPATH": str(SIDECAR_ROOT),
        "HERMES_STATE_DB_GUARD_BYPASS": "1",
        # The launch profile's credentials arrive only through the process environment (systemd, op run).
        "OPENAI_API_KEY": "sk-launch", "LAUNCH_ENV_ONLY": "launch",
    }
    if os.environ.get("LD_LIBRARY_PATH"):  # relocated actions/setup-python interpreter
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    probe = Path(__file__).with_name("profile_isolation_probe.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    results = json.loads(run.stdout.strip().splitlines()[-1])

    def clean(seen):
        return {"success": seen, "scope_after_success": None, "scope_after_error": None, "scope_after_cancel": None}

    launch = {"OPENAI_API_KEY": "sk-launch", "ALPHA_ONLY": None, "LAUNCH_ENV_ONLY": "launch"}
    assert results == {
        "default": clean(launch),
        # A named-profile miss never resolves from the launch environment or a sibling profile.
        "alpha": clean({"OPENAI_API_KEY": "sk-alpha", "ALPHA_ONLY": "alpha", "LAUNCH_ENV_ONLY": None}),
        "beta": clean({"OPENAI_API_KEY": "sk-beta", "ALPHA_ONLY": None, "LAUNCH_ENV_ONLY": None}),
        "default_after_named": launch,
    }
