"""Credential scoping for Agent calls, driven in-process with a stand-in ``agent.secret_scope``."""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import threading
import types
from contextvars import ContextVar
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


@pytest.mark.parametrize('context_local', [False, True])
def test_read_only_profile_scope_can_skip_process_recovery(tmp_path, monkeypatch, scope_calls, context_local):
    root = tmp_path / 'root'
    root.mkdir()
    monkeypatch.setattr(home_module, '_PROCESS_HOME', root)
    calls = []
    monkeypatch.setattr(home_module, '_recover_processes', lambda home: calls.append(home))
    constants = types.ModuleType('hermes_constants')
    if context_local:
        constants.set_hermes_home_override = lambda home: home
        constants.reset_hermes_home_override = lambda token: None
    monkeypatch.setitem(sys.modules, 'hermes_constants', constants)
    with home_module.scoped_home(root, load_plugins=False, recover_processes=False):
        assert calls == []
    with home_module.scoped_home(root):
        assert calls == [root]


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

    # The launch profile also binds its terminal scope, layering the launch env's TERMINAL_* (none here).
    with home_module.scoped_home(root):
        assert scope_calls[-2:] == [("scope", {"OPENAI_API_KEY": "sk-launch", "ROOT_FILE": "root"}), ("terminal", root, {})]
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
        assert scope_calls[-2:] == [("scope", {"OPENAI_API_KEY": "sk-launch", "ROOT_FILE": "root"}), ("terminal", root, {})]
    assert multiplex == [True]

    # A Settings edit reaches the frozen launch environment.
    from talaria_sidecar.methods import runtime as runtime_methods

    registry = types.SimpleNamespace(runtime=None, methods={})
    registry.method = lambda name, **_: lambda func: registry.methods.setdefault(name, func)
    runtime_methods.register(registry)
    monkeypatch.setenv("FRESH_KEY", "restored-after-the-test")
    registry.methods["runtime.env"](None, {"unset": ["OPENAI_API_KEY"], "set": {"FRESH_KEY": "sk-fresh"}})
    with home_module.scoped_home(root):
        assert scope_calls[-2:] == [("scope", {"FRESH_KEY": "sk-fresh", "ROOT_FILE": "root", "HERMES_DISABLE_LAZY_INSTALLS": "1"}), ("terminal", root, {})]

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


@pytest.fixture
def cached_scopes(tmp_path, monkeypatch, scope_calls):
    """Agent boundaries with real disposable files and context-local scope bindings."""
    monkeypatch.setattr(home_module, "_PROCESS_HOME", tmp_path / "launch")
    monkeypatch.setattr(home_module, "_recover_processes", lambda home: None)
    if hasattr(home_module, "_SCOPE_CACHE"):
        monkeypatch.setattr(home_module, "_SCOPE_CACHE", {})
    terminal = sys.modules["tools.terminal_scope"]
    active = ContextVar("test-terminal", default=None)
    active_secrets = ContextVar("test-secrets", default=None)
    reads = []
    external, managed = {}, {}
    sources = sys.modules["hermes_cli.env_loader"]
    sources.get_secret_source_values = lambda home: dict(external)
    managed_module = types.ModuleType("hermes_cli.managed_scope")
    managed_module.load_managed_env = lambda: dict(managed)
    gateway = types.ModuleType("gateway.config_loader")
    gateway.bridged_allow_all_users = lambda: None
    monkeypatch.setitem(sys.modules, "hermes_cli.managed_scope", managed_module)
    monkeypatch.setitem(sys.modules, "gateway.config_loader", gateway)
    secrets = sys.modules["agent.secret_scope"]
    build_secrets = secrets.build_profile_secret_scope

    def build_secret_scope(home):
        reads.append(("secrets", Path(home)))
        return {**build_secrets(home), **external, **managed}

    secrets.build_profile_secret_scope = build_secret_scope
    secrets._is_global_env = lambda key: key.startswith("TERMINAL_")
    record_secrets = secrets.set_secret_scope

    def set_secrets(mapping):
        record_secrets(mapping)
        return active_secrets.set(mapping)

    secrets.set_secret_scope = set_secrets
    secrets.reset_secret_scope = active_secrets.reset

    class Unavailable(Exception):
        pass

    class Refusal(dict):
        def __init__(self, reason):
            self.reason = reason

    def build_terminal_scope(home, *, env_overlay=None):
        path = Path(home) / "config.yaml"
        reads.append(("config", Path(home)))
        try:
            config = json.loads(path.read_text()) if path.exists() else {}
        except (OSError, ValueError) as exc:
            raise Unavailable(str(exc)) from exc
        return {**(env_overlay or {}), **config}

    def install(home, *, env_overlay=None):
        try:
            scope = build_terminal_scope(home, env_overlay=env_overlay)
        except Unavailable as exc:
            scope = Refusal(str(exc))
        return active.set(scope)

    terminal.build_profile_terminal_scope = build_terminal_scope
    terminal.set_terminal_scope = active.set
    terminal.reset_terminal_scope = active.reset
    terminal.install_profile_terminal_scope = install
    terminal.TerminalPolicyUnavailable = Unavailable
    terminal.TerminalPolicyRefusal = Refusal
    return types.SimpleNamespace(reads=reads, active=active, secrets=active_secrets, external=external, managed=managed)


def test_scoped_home_reuses_file_scopes_and_reloads_edits(tmp_path, cached_scopes, scope_calls):
    home = tmp_path / "work"
    home.mkdir()
    config = home / "config.yaml"
    config.write_text('{"TERMINAL_ENV": "ssh"}')
    (home / ".env").write_text("KEY=first\n")
    for _ in range(2):
        with home_module.scoped_home(home):
            assert cached_scopes.active.get() == {"TERMINAL_ENV": "ssh"}
            assert ("scope", {"KEY": "first"}) in scope_calls
    assert cached_scopes.reads.count(("config", home)) == 1
    assert cached_scopes.reads.count(("secrets", home)) == 1
    config.write_text('{"TERMINAL_ENV": "docker"}')
    (home / ".env").write_text("KEY=second\n")
    with home_module.scoped_home(home):
        assert cached_scopes.active.get() == {"TERMINAL_ENV": "docker"}
        assert ("scope", {"KEY": "second"}) in scope_calls
    assert cached_scopes.reads.count(("config", home)) == 2
    assert cached_scopes.reads.count(("secrets", home)) == 2
    assert cached_scopes.active.get() is None


def test_scope_cache_preserves_dashboard_plugin_loading_refusal(tmp_path, monkeypatch, cached_scopes):
    home = tmp_path / "dashboard"
    home.mkdir()
    (home / ".env").write_text("KEY=file\n")
    plugins = types.ModuleType("hermes_cli.plugins")
    plugins.discover_plugins = lambda: pytest.fail("dashboard scope must not load user plugins")
    monkeypatch.setitem(sys.modules, "hermes_cli.plugins", plugins)
    sys.modules["hermes_cli.env_loader"].hydrate_profile_secret_sources = lambda home: pytest.fail("dashboard scope must not hydrate user secret sources")
    for _ in range(2):
        with home_module.scoped_home(home, load_plugins=False):
            assert cached_scopes.secrets.get() == {"KEY": "file"}
    assert cached_scopes.reads.count(("secrets", home)) == 1


@pytest.mark.parametrize("changed_file", [".env", "config.yaml"])
def test_scope_cache_rechecks_a_file_replaced_after_entry_stamp(tmp_path, monkeypatch, cached_scopes, changed_file):
    home = tmp_path / "work"
    home.mkdir()
    (home / ".env").write_text("KEY=first\n")
    (home / "config.yaml").write_text('{"TERMINAL_ENV": "ssh"}')
    with home_module.scoped_home(home):
        assert cached_scopes.secrets.get() == {"KEY": "first"}
        assert cached_scopes.active.get() == {"TERMINAL_ENV": "ssh"}

    stamp = home_module._scope_stamp
    replaced = False

    def replace_after_stamp(path):
        nonlocal replaced
        captured = stamp(path)
        if not replaced:
            replaced = True
            replacement = home / "replacement"
            replacement.write_text("KEY=rotated\n" if changed_file == ".env" else '{"TERMINAL_ENV": "docker"}')
            replacement.replace(home / changed_file)
        return captured

    monkeypatch.setattr(home_module, "_scope_stamp", replace_after_stamp)
    with home_module.scoped_home(home):
        assert cached_scopes.secrets.get() == {"KEY": "rotated" if changed_file == ".env" else "first"}
        assert cached_scopes.active.get() == {"TERMINAL_ENV": "docker" if changed_file == "config.yaml" else "ssh"}
    assert cached_scopes.secrets.get() is None
    assert cached_scopes.active.get() is None


def test_scope_cache_preserves_dynamic_secrets_and_private_bindings(tmp_path, cached_scopes, scope_calls):
    home = tmp_path / "work"
    home.mkdir()
    (home / "config.yaml").write_text('{"TERMINAL_ENV": "ssh"}')
    (home / ".env").write_text("KEY=file\n")
    for source in (cached_scopes.external, cached_scopes.managed):
        source["KEY"] = "rotated"
        with home_module.scoped_home(home):
            assert ("scope", {"KEY": "rotated"}) in scope_calls
            cached_scopes.active.get()["TERMINAL_ENV"] = "mutated"
            cached_scopes.secrets.get()["KEY"] = "mutated"
        source.clear()
        scope_calls.clear()
        with home_module.scoped_home(home):
            assert ("scope", {"KEY": "file"}) in scope_calls
            assert cached_scopes.active.get() == {"TERMINAL_ENV": "ssh"}
    assert cached_scopes.reads.count(("config", home)) == 1


def test_scope_cache_rebuilds_after_same_size_replacement_and_missing_file_creation(tmp_path, cached_scopes):
    home = tmp_path / "work"
    home.mkdir()
    with home_module.scoped_home(home):
        assert cached_scopes.secrets.get() == {}
    env = home / ".env"
    env.write_text("KEY=first\n")
    with home_module.scoped_home(home):
        assert cached_scopes.secrets.get() == {"KEY": "first"}
    stamp = env.stat()
    replacement = home / "replacement"
    replacement.write_text("KEY=other\n")
    os.utime(replacement, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    replacement.replace(env)
    with home_module.scoped_home(home):
        assert cached_scopes.secrets.get() == {"KEY": "other"}


def test_concurrent_scope_entries_share_one_build(tmp_path, monkeypatch, cached_scopes):
    home = tmp_path / "work"
    home.mkdir()
    (home / "config.yaml").write_text('{"TERMINAL_ENV": "ssh"}')
    constants = types.ModuleType("hermes_constants")
    active_home = ContextVar("test-home", default=None)
    constants.set_hermes_home_override = active_home.set
    constants.reset_hermes_home_override = active_home.reset
    monkeypatch.setitem(sys.modules, "hermes_constants", constants)
    barrier = threading.Barrier(4, timeout=10)
    errors = []

    def enter():
        barrier.wait()
        with home_module.scoped_home(home):
            assert cached_scopes.active.get() == {"TERMINAL_ENV": "ssh"}
            barrier.wait()
        assert cached_scopes.active.get() is None
        assert cached_scopes.secrets.get() is None

    threads = [threading.Thread(target=lambda: _record(errors, enter)) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(15)
    assert not any(thread.is_alive() for thread in threads)
    assert errors == []
    assert cached_scopes.reads.count(("config", home)) == 1
    assert cached_scopes.reads.count(("secrets", home)) == 1


def test_scope_cache_separates_homes_and_retries_invalid_policy(tmp_path, cached_scopes, scope_calls):
    homes = [tmp_path / name for name in ("alpha", "beta")]
    for home in homes:
        home.mkdir()
        (home / "config.yaml").write_text(json.dumps({"TERMINAL_ENV": home.name}))
        (home / ".env").write_text(f"KEY={home.name}\n")
    for home in homes * 2:
        with home_module.scoped_home(home):
            assert cached_scopes.active.get() == {"TERMINAL_ENV": home.name}
            assert ("scope", {"KEY": home.name}) in scope_calls
    home = homes[0]
    (home / "config.yaml").write_text("invalid yaml [")
    for _ in range(2):
        with home_module.scoped_home(home):
            assert isinstance(cached_scopes.active.get(), sys.modules["tools.terminal_scope"].TerminalPolicyRefusal)
    assert cached_scopes.reads.count(("config", home)) == 3
    (home / "config.yaml").unlink()
    (home / ".env").unlink()
    with home_module.scoped_home(home):
        assert cached_scopes.active.get() == {}
        assert scope_calls[-1] == ("scope", {})


def test_scope_cache_tracks_launch_environment_edits(tmp_path, monkeypatch, cached_scopes, scope_calls):
    home = tmp_path / "launch"
    home.mkdir()
    launch = {"TERMINAL_ENV": "ssh", "KEY": "launch"}
    policy = sys.modules["tui_gateway.launch_profile_policy"]
    policy._launch_env = lambda: dict(launch)
    policy.launch_terminal_env = lambda: {k: v for k, v in launch.items() if k.startswith("TERMINAL_")}
    policy.launch_secret_scope = lambda home: {"KEY": launch["KEY"]}
    sys.modules["agent.secret_scope"].is_multiplex_active = lambda: True
    for value in ("ssh", "docker"):
        launch.update(TERMINAL_ENV=value, KEY=value)
        with home_module.scoped_home(home):
            assert cached_scopes.active.get() == {"TERMINAL_ENV": value}
            assert ("scope", {"KEY": value}) in scope_calls


def test_scope_cache_drops_uncertain_stamps_and_evicts_old_homes(tmp_path, monkeypatch, cached_scopes):
    monkeypatch.setattr(home_module, "_SCOPE_CACHE_MAX", 2)
    home = tmp_path / "alpha"
    home.mkdir()
    config = home / "config.yaml"
    config.write_text('{"TERMINAL_ENV": "ssh"}')
    with home_module.scoped_home(home):
        pass
    def denied(original):
        def call(path, *args, **kwargs):
            if path == config:
                raise PermissionError("transient denial")
            return original(path, *args, **kwargs)
        return call

    with monkeypatch.context() as patch:
        # Python 3.14's Path.exists no longer calls Path.stat, so the policy read is denied as well.
        patch.setattr(Path, "stat", denied(Path.stat))
        patch.setattr(Path, "read_text", denied(Path.read_text))
        with home_module.scoped_home(home):
            assert isinstance(cached_scopes.active.get(), sys.modules["tools.terminal_scope"].TerminalPolicyRefusal)
    with home_module.scoped_home(home):
        assert cached_scopes.active.get() == {"TERMINAL_ENV": "ssh"}
    for name in ("beta", "gamma"):
        with home_module.scoped_home(tmp_path / name):
            pass
    assert len(home_module._SCOPE_CACHE) == 2
    assert str(home.absolute()) not in home_module._SCOPE_CACHE


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
    seen = json.loads(run.stdout.strip().splitlines()[-1])
    turns, default_image = seen["turns"], seen["default_image"]  # The Agent owns its default sandbox image.
    assert all(isinstance(turn, dict) for turn in turns.values()), turns
    containers = {name: turn.pop("container") for name, turn in turns.items()}
    assert turns == {
        # The root profile's config.yaml wins over the host default; its launch env still fills unset keys.
        "default": {"env_type": "ssh", "docker_image": default_image, "ssh_host": "root-host", "ssh_user": "launch-user"},
        # Named profiles see only their own files, never the launch env or a sibling's backend.
        "alpha": {"env_type": "docker", "docker_image": "alpha-image", "ssh_host": "", "ssh_user": ""},
        "beta": {"env_type": "ssh", "docker_image": default_image, "ssh_host": "beta-host", "ssh_user": ""},
        "gamma": {"env_type": "docker", "docker_image": "gamma-image", "ssh_host": "", "ssh_user": ""},
    }
    # Each persistent Docker profile creates and reuses its own sandbox rather than the shared default one, and no two
    # profiles share a sandbox key. The Agent may qualify a named profile's session key with its profile.
    assert (containers["alpha"], containers["gamma"], containers["default"]) == ("profile:alpha", "profile:gamma", "session:default"), containers
    assert containers["beta"].endswith("session:beta"), containers
    assert len(set(containers.values())) == len(containers), containers


@requires_agent
def test_the_launch_profiles_terminal_scope_keeps_its_launch_env_once_a_named_profile_runs_on_the_installed_agent(tmp_path) -> None:
    """A root turn layers the launch env under its own config.yaml, frozen when the first named profile runs."""
    root = tmp_path / ".hermes"
    named = root / "profiles" / "alpha"
    for home, config in ((root, "terminal:\n  backend: ssh\n  ssh_host: root-host\n"), (named, "terminal:\n  backend: local\n")):
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text(config)
        (home / ".env").write_text("")
    code = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from tools.terminal_tool import _get_env_config
root = Path(os.environ["HERMES_HOME"])
def seen(home):
    with scoped_home(home):
        config = _get_env_config()
        return {key: config[key] for key in ("env_type", "ssh_host", "ssh_user")}
before = seen(root)  # single-profile: the live launch env
with scoped_home(root / "profiles" / "alpha"):  # the first named profile freezes the launch env
    pass
os.environ["TERMINAL_SSH_USER"] = "edited-after-freeze"
print(json.dumps({"before": before, "after": seen(root), "named": seen(root / "profiles" / "alpha")}))
"""
    env = isolated_env(root, TERMINAL_ENV="local", TERMINAL_SSH_USER="launch-user")
    run = subprocess.run([AGENT_PYTHON, "-c", code, str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    root_turn = {"env_type": "ssh", "ssh_host": "root-host", "ssh_user": "launch-user"}
    assert json.loads(run.stdout.strip().splitlines()[-1]) == {
        "before": root_turn,
        # The frozen launch env still fills the root profile's unset keys; a later process-env edit never leaks in.
        "after": root_turn,
        # A named profile never sees the launch env.
        "named": {"env_type": "local", "ssh_host": "", "ssh_user": ""},
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


_VAULT_PLUGIN = '''
from agent.secret_sources.base import SECRET_SOURCE_API_VERSION, FetchResult, SecretSource


class TestVaultSource(SecretSource):
    api_version = SECRET_SOURCE_API_VERSION
    name = "testvault"
    label = "Test Vault"
    shape = "bulk"

    def fetch(self, cfg, home_path):
        return FetchResult(secrets={"TESTVAULT_API_KEY": "stub-vault-key"})


def register(ctx):
    ctx.register_secret_source(TestVaultSource())
'''


@requires_agent
def test_a_named_profiles_plugin_secret_source_reaches_its_scope_after_the_root_loaded_the_agent_on_the_installed_agent(tmp_path) -> None:
    """A vault plugin a named profile ships hydrates its scope even though the Agent's one-time discovery ran under the root."""
    root = tmp_path / ".hermes"
    named = root / "profiles" / "b"
    for name, body in (("test-vault", _VAULT_PLUGIN), ("broken", "def register(ctx):\n    raise RuntimeError('broken plugin')\n")):
        plugin = named / "plugins" / name
        plugin.mkdir(parents=True)
        (plugin / "plugin.yaml").write_text(f"name: {name}\ndescription: stub\n")
        (plugin / "__init__.py").write_text(body)
    (named / "config.yaml").write_text(
        "secrets:\n  sources: [testvault]\n  testvault:\n    enabled: true\nplugins:\n  enabled: [test-vault, broken]\n"
    )
    (named / ".env").write_text("")
    code = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from agent.secret_scope import current_secret_scope
root = Path(os.environ["HERMES_HOME"])
with scoped_home(root):  # a default-profile chat imports the Agent first
    import run_agent  # noqa: F401
seen = []
for _ in range(2):
    with scoped_home(root / "profiles" / "b"):
        seen.append((current_secret_scope() or {}).get("TESTVAULT_API_KEY"))
print(json.dumps(seen))
"""
    run = subprocess.run([AGENT_PYTHON, "-c", code, str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    # A plugin whose register raises does not fail the call or keep its sibling's source from loading.
    assert json.loads(run.stdout.strip().splitlines()[-1]) == ["stub-vault-key", "stub-vault-key"]


def test_read_only_home_binding_does_not_hydrate_credentials_or_initialize_runtime(tmp_path, monkeypatch):
    constants = types.ModuleType('hermes_constants')
    override = ContextVar('read-only-home', default=None)
    constants.set_hermes_home_override = lambda home: override.set(home)
    constants.reset_hermes_home_override = lambda token: override.reset(token)
    monkeypatch.setitem(sys.modules, 'hermes_constants', constants)
    monkeypatch.setattr(home_module, '_secret_scope', lambda *a, **kw: pytest.fail('Read-only inspection hydrated credentials'))
    monkeypatch.setattr(home_module, '_terminal_scope', lambda *a, **kw: pytest.fail('Read-only inspection initialized terminal defaults'))
    monkeypatch.setattr(home_module, '_recover_processes', lambda *a: pytest.fail('Read-only inspection recovered processes'))
    with home_module.scoped_home(tmp_path, read_only=True):
        assert override.get() == tmp_path
    assert override.get() is None
    assert list(tmp_path.iterdir()) == []
