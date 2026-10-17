"""``runtime.*`` and the transport: handshake, drift guard, cancellation."""

from __future__ import annotations

import subprocess
import hashlib
import pytest

from conftest import AGENT_DIR, SidecarProcess, assert_matches, requires_agent
from talaria_sidecar import SIDECAR_RPC_VERSION
from talaria_sidecar.runtime import read_pin


@pytest.mark.parametrize('obligation', ['dependency', 'service'])
def test_same_revision_agent_work_is_blocked_until_durable_web_repair_intent_is_cleared(tmp_path, monkeypatch, obligation):
    from talaria_sidecar.runtime import AgentRuntime, AgentRuntimeStale
    root, home, state = tmp_path / 'agent', tmp_path / 'home', tmp_path / 'web-state'
    root.mkdir(); home.mkdir()
    runtime = AgentRuntime(home, root)
    monkeypatch.setattr(runtime, 'is_stale', lambda: False)
    monkeypatch.setenv('HERMES_WEBUI_STATE_DIR', str(state))
    from talaria_sidecar.agent_services import recovery_path
    marker = recovery_path(root, home) if obligation == 'service' else state / 'agent-dependency-sync' / hashlib.sha256(str(root.resolve()).encode()).hexdigest()
    marker.parent.mkdir(parents=True)
    marker.write_text('pending\n')
    with pytest.raises(AgentRuntimeStale, match='Finish the Agent update') as failure:
        runtime.ensure_current()
    assert failure.value.data['agent_update_state'] == 'incomplete'
    assert 'updated' not in str(failure.value).lower()
    marker.unlink()
    runtime.ensure_current()


@pytest.mark.parametrize('fresh, changed', [('b' * 40, True), (None, False)])
def test_runtime_refusal_only_reports_verified_source_changes(tmp_path, monkeypatch, fresh, changed):
    from talaria_sidecar import runtime as module
    runtime = module.AgentRuntime(tmp_path / 'home', tmp_path / 'agent')
    runtime.loaded = True
    runtime.revision = 'a' * 40
    monkeypatch.setattr(runtime, 'web_repair_state', lambda: 'absent')
    monkeypatch.setattr(runtime, 'update_transaction_state', lambda: 'unverified')
    monkeypatch.setattr(module, 'read_agent_revision', lambda *_: fresh)
    with pytest.raises(module.AgentRuntimeStale) as failure:
        runtime.ensure_current()
    assert failure.value.data['agent_source_changed'] is changed
    assert failure.value.data['agent_update_state'] == 'unverified'
    assert 'updated' not in str(failure.value).lower()


def test_active_update_with_retained_recovery_is_not_classified_as_incomplete(tmp_path, monkeypatch):
    from talaria_sidecar import runtime as module
    runtime = module.AgentRuntime(tmp_path / 'home', tmp_path / 'agent')
    monkeypatch.setattr(runtime, 'web_repair_state', lambda: 'present')
    monkeypatch.setattr(module, '_read_live_agent_update', lambda *_: 'active')
    with pytest.raises(module.AgentRuntimeStale) as failure:
        runtime.ensure_current()
    assert failure.value.data['agent_update_state'] == 'active'
    assert 'incomplete' not in str(failure.value).lower()


@pytest.mark.parametrize("method", ["providers.auth_status", "providers.model_ids", "plugins.providers", "usage.pool_providers", "usage.pool", "usage.account"])
def test_catalog_reads_keep_agent_recovery_admission(method):
    from talaria_sidecar.methods import Registry
    from talaria_sidecar.methods import providers, usage, commands
    from talaria_sidecar.methods import runtime as runtime_methods
    from talaria_sidecar.runtime import AgentRuntimeStale

    class HeldRuntime:
        def load(self):
            pass

        def ensure_current(self):
            raise AgentRuntimeStale("incomplete", "Agent update recovery is incomplete.")

    registry = Registry(HeldRuntime())
    providers.register(registry)
    usage.register(registry)
    runtime_methods.register(registry)
    commands.register(registry)
    with pytest.raises(AgentRuntimeStale, match="recovery is incomplete"):
        registry.methods[method](None, {})


@requires_agent
def test_handshake_reports_the_pinned_agent(sidecar: SidecarProcess) -> None:
    result = sidecar.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
    assert_matches("runtime.handshake", result)
    assert result["rpc_version"] == SIDECAR_RPC_VERSION
    assert result["pinned_revision"] == read_pin()["source_revision"]
    assert result["agent_dir"] == str(AGENT_DIR)
    assert result["compatible"] is True
    assert result["stale"] is False
    assert result["import_error"] is None


@requires_agent
def test_handshake_rejects_another_rpc_version(sidecar: SidecarProcess) -> None:
    message, _ = sidecar.call("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION + 1})
    assert message["error"]["data"]["condition"] == "sidecar_rpc_version_mismatch"
    assert sidecar.close() == 3


@requires_agent
def test_handshake_rejects_pre_receipt_delivery_protocol(sidecar: SidecarProcess) -> None:
    message, _ = sidecar.call("runtime.handshake", {"rpc_version": 37})
    assert "error" in message, "pre-receipt servers must not admit reconciled deliveries"
    assert message["error"]["data"]["condition"] == "sidecar_rpc_version_mismatch"
    assert sidecar.close() == 3


@requires_agent
def test_status_before_handshake_reports_nothing_loaded(sidecar: SidecarProcess) -> None:
    result = sidecar.result("runtime.status")
    assert result["compatible"] is False
    assert result["agent_revision"] is None


@requires_agent
def test_unknown_method_and_cancel_of_inactive_request(handshaken: SidecarProcess) -> None:
    message, _ = handshaken.call("nope.nothing")
    assert message["error"]["code"] == -32601
    assert handshaken.result("rpc.cancel", {"id": 12345}) == {"cancelled": False, "reason": "not_active"}
    methods = handshaken.result("rpc.methods")["methods"]
    assert "runtime.handshake" in methods


@requires_agent
def test_drift_guard_refuses_a_changed_checkout(tmp_path, hermes_home) -> None:
    """A copied checkout whose HEAD moves after import answers agent_runtime_stale."""
    clone = tmp_path / "agent-clone"
    subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(AGENT_DIR), str(clone)], check=True)
    subprocess.run(["git", "-C", str(clone), "checkout", "--quiet", "--detach", "HEAD"], check=True)
    proc = SidecarProcess(hermes_home, agent_dir=clone)
    try:
        result = proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
        assert result["agent_dir"] == str(clone)
        assert proc.result("runtime.ensure_current")["current"] is True
        identity = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
        subprocess.run(["git", "-C", str(clone), "commit", "--quiet", "--allow-empty", "-m", "drift"], check=True, env=identity)
        message, _ = proc.call("runtime.ensure_current")
        assert message["error"]["data"]["condition"] == "agent_runtime_stale"
        assert proc.result("runtime.status")["stale"] is True
    finally:
        proc.close()


def test_pin_file_is_immutable_shape() -> None:
    pin = read_pin()
    assert len(pin["source_revision"]) == 40
    assert pin["image"].startswith("docker.io/nousresearch/hermes-agent@sha256:")


@requires_agent
def test_runtime_env_edits_the_sidecar_process_environment(sidecar: SidecarProcess) -> None:
    """Web-owned `.env` edits reach the running sidecar without a restart; names are validated."""
    assert sidecar.result("runtime.env", {"set": {"TALARIA_TEST_KEY": "sk-synthetic"}}) == {"ok": True}
    assert sidecar.result("chat.evict_agent", {"session_id": "none"}) == {"evicted": False}
    assert sidecar.result("runtime.env", {"unset": ["TALARIA_TEST_KEY", "NEVER_SET"]}) == {"ok": True}
    message, _ = sidecar.call("runtime.env", {"set": {"bad name": "x"}})
    assert message["error"]["code"] == -32602
    message, _ = sidecar.call("runtime.env", {"unset": "OPENAI_API_KEY"})
    assert message["error"]["code"] == -32602


def test_importable_agent_is_not_rejected_for_an_unpinned_or_unknown_version(tmp_path, monkeypatch) -> None:
    from talaria_sidecar.runtime import AgentRuntime

    runtime = AgentRuntime(tmp_path / "home", None)
    runtime.loaded = True
    runtime.revision = None
    monkeypatch.setattr(type(runtime), "agent_version", property(lambda self: runtime.pin["version"]))
    assert runtime.describe()["compatible"] is True
    monkeypatch.setattr(type(runtime), "agent_version", property(lambda self: "0.0.0-other"))
    assert runtime.describe()["compatible"] is True
    monkeypatch.setattr(type(runtime), "agent_version", property(lambda self: None))
    assert runtime.describe()["compatible"] is True
    runtime.revision = runtime.pin["source_revision"]
    assert runtime.describe()["compatible"] is True
    runtime.revision = "a" * 40
    assert runtime.describe()["compatible"] is True
    runtime.loaded = False
    assert runtime.describe()["compatible"] is False


@requires_agent
def test_config_reads_survive_agent_import_failure(tmp_path, hermes_home) -> None:
    broken_agent = tmp_path / "broken-agent"
    broken_agent.mkdir()
    (broken_agent / "run_agent.py").write_text("raise ImportError('synthetic broken Agent')\n")
    config = hermes_home / "config.yaml"
    config.write_text("webui_oidc:\n  issuer: https://idp.example\n")
    proc = SidecarProcess(hermes_home, agent_dir=broken_agent)
    try:
        assert proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"] is False
        assert proc.result("config.get", {"profile_home": str(hermes_home)})["config"] == {"webui_oidc": {"issuer": "https://idp.example"}}
        assert proc.result("config.set", {"profile_home": str(hermes_home), "config": {"webui_oidc": {"issuer": "https://repaired.example"}}})["ok"] is True
        assert proc.result("config.get", {"profile_home": str(hermes_home)})["config"] == {"webui_oidc": {"issuer": "https://repaired.example"}}
        message, _ = proc.call("runtime.ensure_current")
        assert message["error"]["data"]["condition"] == "agent_incompatible"
        config.write_text("webui_oidc: [\n")
        message, _ = proc.call("config.get", {"profile_home": str(hermes_home)})
        assert message["error"]["data"]["condition"] == "config_invalid"
        config.write_text("- not-a-mapping\n")
        message, _ = proc.call("config.get", {"profile_home": str(hermes_home)})
        assert message["error"]["data"]["condition"] == "config_invalid"
    finally:
        proc.close()


def _load_with_site_packages(tmp_path, monkeypatch, site_packages):
    import sys
    import types

    from talaria_sidecar.runtime import AgentRuntime

    site_packages.mkdir(parents=True)
    monkeypatch.syspath_prepend(str(site_packages))
    monkeypatch.setitem(sys.modules, "run_agent", types.SimpleNamespace(AIAgent=object))
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.auth", types.ModuleType("hermes_cli.auth"))
    runtime = AgentRuntime(tmp_path / "home", None)
    runtime.load()
    return runtime


def test_load_rejects_agent_packages_built_for_another_python(tmp_path, monkeypatch) -> None:
    import sys

    from talaria_sidecar.runtime import AgentIncompatible, AgentRuntime

    other = f"{sys.version_info[0]}.{sys.version_info[1] + 1}"
    venv = tmp_path / "environments" / "generation" / "venv"
    site_packages = venv / "lib" / f"python{other}" / "site-packages"
    try:
        _load_with_site_packages(tmp_path, monkeypatch, site_packages)
    except AgentIncompatible as error:
        message = str(error)
    else:
        raise AssertionError("load() accepted Agent packages built for another Python")
    running = f"{sys.version_info[0]}.{sys.version_info[1]}"
    assert f"interpreter Python {running} cannot load Agent packages built for Python {other} ({site_packages})" in message
    assert "unset HERMES_WEBUI_PYTHON" in message and str(venv / "bin" / "python") in message
    runtime = AgentRuntime(tmp_path / "home", None)
    try:
        runtime.load()
    except AgentIncompatible:
        pass
    described = runtime.describe()
    assert described["compatible"] is False
    assert f"built for Python {other}" in described["import_error"]


def test_load_rejects_a_windows_venv_for_another_python(tmp_path, monkeypatch) -> None:
    import sys

    from talaria_sidecar.runtime import AgentIncompatible

    venv = tmp_path / "venv"
    venv.mkdir()
    (venv / "pyvenv.cfg").write_text(f"home = C:\\Python\nversion = {sys.version_info[0]}.{sys.version_info[1] + 1}.0\n")
    try:
        _load_with_site_packages(tmp_path, monkeypatch, venv / "Lib" / "site-packages")
    except AgentIncompatible as error:
        assert "python.exe" in str(error)
    else:
        raise AssertionError("load() accepted a Windows venv built for another Python")


def test_load_accepts_agent_packages_for_the_running_python(tmp_path, monkeypatch) -> None:
    import sys

    running = f"{sys.version_info[0]}.{sys.version_info[1]}"
    runtime = _load_with_site_packages(tmp_path, monkeypatch, tmp_path / "venv" / "lib" / f"python{running}" / "site-packages")
    assert runtime.loaded is True
    assert runtime.describe()["compatible"] is True


def test_load_rejects_agent_packages_for_the_other_free_threading_abi(tmp_path, monkeypatch) -> None:
    import sys
    import sysconfig

    from talaria_sidecar.runtime import AgentIncompatible

    running = f"{sys.version_info[0]}.{sys.version_info[1]}"
    other = running if sysconfig.get_config_var("Py_GIL_DISABLED") else f"{running}t"
    venv = tmp_path / "venv"
    venv.mkdir()
    (venv / "pyvenv.cfg").write_text(f"version = {running}.0\nexecutable = C:\\Python\\python{other}.exe\n")
    for site_packages in (tmp_path / "posix" / "lib" / f"python{other}" / "site-packages", venv / "Lib" / "site-packages"):
        try:
            _load_with_site_packages(tmp_path, monkeypatch, site_packages)
        except AgentIncompatible as error:
            assert f"built for Python {other} ({site_packages})" in str(error)
        else:
            raise AssertionError(f"load() accepted {site_packages} built for the other free-threading ABI")
        monkeypatch.undo()
