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
