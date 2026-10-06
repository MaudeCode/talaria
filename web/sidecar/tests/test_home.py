"""Credential scoping for Agent calls, driven in-process with a stand-in ``agent.secret_scope``."""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import threading
import types
from pathlib import Path

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent
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
    module.is_multiplex_active = lambda: False
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
    launch_policy.launch_terminal_env = lambda: pytest.fail("the launch env is frozen only once multiplexing is active")
    terminal = types.ModuleType("tools.terminal_scope")
    terminal.install_profile_terminal_scope = lambda home, env_overlay=None: calls.append(("terminal", Path(home), env_overlay)) or "terminal-token"
    terminal.reset_terminal_scope = lambda token: calls.append(("reset-terminal", token))
    monkeypatch.setitem(sys.modules, "agent", agent)
    monkeypatch.setitem(sys.modules, "agent.secret_scope", agent.secret_scope)
    monkeypatch.setitem(sys.modules, "hermes_cli.env_loader", env_loader)
    monkeypatch.setitem(sys.modules, "tui_gateway.launch_profile_policy", launch_policy)
    monkeypatch.setitem(sys.modules, "tools.terminal_scope", terminal)
    return calls


def test_named_profile_runs_under_its_own_secrets_with_multiplex_semantics(tmp_path, monkeypatch, scope_calls) -> None:
    root = tmp_path / "root"
    named = root / "profiles" / "work"
    named.mkdir(parents=True)
    (named / ".env").write_text("OPENAI_API_KEY=sk-work\n")
    monkeypatch.setattr(home_module, "_PROCESS_HOME", root)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-root-from-startup-dotenv")
    monkeypatch.setenv("TERMINAL_ENV", "local")
    with home_module.scoped_home(named):
        assert os.environ["HERMES_HOME"] == str(named)
        assert ("scope", {"OPENAI_API_KEY": "sk-work"}) in scope_calls
        assert ("activate", True) in scope_calls
        assert ("hydrate", named) in scope_calls
        # Its terminal policy comes from its own files only, never the launch env.
        assert scope_calls[-1] == ("terminal", named, None)
    assert scope_calls[-2:] == [("reset-terminal", "terminal-token"), ("reset-scope", "scope-token")]


def test_root_profile_keeps_single_profile_semantics(tmp_path, monkeypatch, scope_calls) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (root / ".env").write_text("OPENAI_API_KEY=sk-root\n")
    monkeypatch.setattr(home_module, "_PROCESS_HOME", root)
    monkeypatch.setenv("TERMINAL_ENV", "ssh")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-launch")
    with home_module.scoped_home(root):
        assert ("launch-scope", root) in scope_calls
        assert ("scope", {"OPENAI_API_KEY": "sk-root"}) in scope_calls
        assert not any(call[0] == "activate" for call in scope_calls)
        # The launch profile's own files sit over its live launch-process terminal policy.
        assert scope_calls[-1] == ("terminal", root, {"TERMINAL_ENV": "ssh"})


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
            assert scope_calls[-2:] == [("scope", {"OPENAI_API_KEY": "sk-work"}), ("terminal", named, None)]
            raise ValueError("test body")
    assert scope_calls[-1] == ("reset-scope", "scope-token")

    # The launch environment was frozen at activation; later process-env writes never reach it.
    monkeypatch.setenv("LEAKED_LATER", "x")
    with home_module.scoped_home(root):
        assert scope_calls[-1] == ("scope", {"OPENAI_API_KEY": "sk-launch", "ROOT_FILE": "root"})
    assert multiplex == [True]

    # A Settings edit reaches the frozen launch environment.
    from talaria_sidecar.methods import runtime as runtime_methods

    registry = types.SimpleNamespace(runtime=None, methods={})
    registry.method = lambda name, **_: lambda func: registry.methods.setdefault(name, func)
    runtime_methods.register(registry)
    monkeypatch.setenv("FRESH_KEY", "restored-after-the-test")
    registry.methods["runtime.env"](None, {"unset": ["OPENAI_API_KEY"], "set": {"FRESH_KEY": "sk-fresh"}})
    with home_module.scoped_home(root):
        assert scope_calls[-1] == ("scope", {"FRESH_KEY": "sk-fresh", "ROOT_FILE": "root"})

    # A partial implementation is not permission to leak the launch profile's credentials.
    monkeypatch.delattr(scope, "set_multiplex_active")
    with pytest.raises(RpcError) as excinfo:
        with home_module.scoped_home(named):
            pytest.fail("missing isolation must not reach the body")
    assert excinfo.value.data["condition"] == "agent_incompatible"


def test_named_profile_fails_closed_without_a_terminal_scope(tmp_path, monkeypatch, scope_calls) -> None:
    root = tmp_path / "root"
    named = root / "profiles" / "work"
    named.mkdir(parents=True)
    monkeypatch.setattr(home_module, "_PROCESS_HOME", root)
    monkeypatch.setitem(sys.modules, "tools.terminal_scope", None)
    with pytest.raises(RpcError) as excinfo:
        with home_module.scoped_home(named):
            pytest.fail("a named profile must not run on the launch terminal backend")
    assert excinfo.value.data["condition"] == "agent_incompatible"
    assert scope_calls[-1] == ("reset-scope", "scope-token")
    # The root profile still runs (its terminal policy is the process's own).
    with home_module.scoped_home(root):
        assert os.environ["HERMES_HOME"] == str(root)


@requires_agent
def test_concurrent_profiles_resolve_only_their_own_credentials_on_the_installed_agent(tmp_path) -> None:
    root = tmp_path / ".hermes"
    for name, dotenv in (("alpha", "OPENAI_API_KEY=sk-alpha\nALPHA_ONLY=alpha\n"), ("beta", "OPENAI_API_KEY=sk-beta\n")):
        (root / "profiles" / name).mkdir(parents=True)
        (root / "profiles" / name / ".env").write_text(dotenv)
    # The launch profile's credentials arrive only through the process environment (systemd, op run).
    env = isolated_env(root, OPENAI_API_KEY="sk-launch", LAUNCH_ENV_ONLY="launch")
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
        "default_after_env_edit": {"OPENAI_API_KEY": None, "ALPHA_ONLY": None, "LAUNCH_ENV_ONLY": "rotated"},
    }


@requires_agent
def test_concurrent_turns_run_under_their_own_profiles_terminal_backend_on_the_installed_agent(tmp_path) -> None:
    root = tmp_path / ".hermes"
    configs = {
        root: "terminal:\n  backend: ssh\n  ssh_host: root-host\n",
        root / "profiles" / "alpha": "terminal:\n  backend: docker\n  docker_image: alpha-image\n  container_persistent: true\n",
        root / "profiles" / "beta": "terminal:\n  backend: ssh\n  ssh_host: beta-host\n",
        root / "profiles" / "gamma": "terminal:\n  backend: docker\n  docker_image: gamma-image\n  container_persistent: true\n",
    }
    for home, config in configs.items():
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text(config)
        (home / ".env").write_text("")
    # The host default, plus a launch-only policy key with no file to rebuild it from (systemd, op run).
    env = isolated_env(root, TERMINAL_ENV="local", TERMINAL_SSH_USER="launch-user")
    probe = Path(__file__).with_name("terminal_scope_probe.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    default_image = "nikolaik/python-nodejs:python3.11-nodejs20"
    assert json.loads(run.stdout.strip().splitlines()[-1]) == {
        # The root profile's config.yaml wins over the host default; its launch env still fills unset keys.
        "default": {"env_type": "ssh", "docker_image": default_image, "ssh_host": "root-host", "ssh_user": "launch-user", "container": "session:default"},
        # Named profiles see only their own files, never the launch env or a sibling's backend, and each
        # persistent Docker profile creates and reuses its own sandbox rather than the shared default one.
        "alpha": {"env_type": "docker", "docker_image": "alpha-image", "ssh_host": "", "ssh_user": "", "container": "profile:alpha"},
        "beta": {"env_type": "ssh", "docker_image": default_image, "ssh_host": "beta-host", "ssh_user": "", "container": "session:beta"},
        "gamma": {"env_type": "docker", "docker_image": "gamma-image", "ssh_host": "", "ssh_user": "", "container": "profile:gamma"},
    }


def test_runtime_env_waits_for_a_launch_policy_import_in_flight(tmp_path, monkeypatch) -> None:
    """A Settings edit racing the Agent's first import of the policy module edits its snapshot once the import finishes."""
    package = tmp_path / "tui_gateway"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "launch_profile_policy.py").write_text(
        "import threading\nimport _tal525_gate\n_tal525_gate.started.set()\n_tal525_gate.release.wait(10)\n"
        "_lock = threading.Lock()\n_snapshot = {'OPENAI_API_KEY': 'sk-launch', 'KEPT': 'kept'}\n"
    )
    gate = types.ModuleType("_tal525_gate")
    gate.started, gate.release = threading.Event(), threading.Event()
    monkeypatch.setitem(sys.modules, "_tal525_gate", gate)
    monkeypatch.syspath_prepend(str(tmp_path))
    for name in ("tui_gateway", "tui_gateway.launch_profile_policy"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setattr(home_module, "_LAUNCH_ENV", None)

    importer = threading.Thread(target=importlib.import_module, args=("tui_gateway.launch_profile_policy",))
    importer.start()
    assert gate.started.wait(10)
    errors = []
    editor = threading.Thread(target=lambda: _record(errors, lambda: home_module.edit_launch_env({}, ["OPENAI_API_KEY"])))
    editor.start()
    editor.join(0.2)
    gate.release.set()
    importer.join(10)
    editor.join(10)
    assert errors == []
    assert sys.modules["tui_gateway.launch_profile_policy"]._snapshot == {"KEPT": "kept"}


def _record(errors: list, body) -> None:
    try:
        body()
    except Exception as exc:  # noqa: BLE001 - reported to the test
        errors.append(repr(exc))
