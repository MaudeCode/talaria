"""``runtime.*`` and the transport: handshake, drift guard, cancellation."""

from __future__ import annotations

import subprocess

from conftest import AGENT_DIR, SidecarProcess, assert_matches, requires_agent
from talaria_sidecar import SIDECAR_RPC_VERSION
from talaria_sidecar.runtime import read_pin


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


def test_an_untracked_agent_install_is_compatible_only_when_its_version_matches_the_pin(tmp_path, monkeypatch) -> None:
    from talaria_sidecar.runtime import AgentRuntime

    runtime = AgentRuntime(tmp_path / "home", None)
    runtime.loaded = True
    runtime.revision = None
    monkeypatch.setattr(type(runtime), "agent_version", property(lambda self: runtime.pin["version"]))
    assert runtime.describe()["compatible"] is True
    monkeypatch.setattr(type(runtime), "agent_version", property(lambda self: "0.0.0-other"))
    assert runtime.describe()["compatible"] is False
    monkeypatch.setattr(type(runtime), "agent_version", property(lambda self: None))
    assert runtime.describe()["compatible"] is False
    runtime.revision = runtime.pin["source_revision"]
    assert runtime.describe()["compatible"] is True
