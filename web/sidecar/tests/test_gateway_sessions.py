"""Canonical owner attachment never creates an independent Agent or starts a daemon."""
from pathlib import Path
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, isolated_env, requires_agent


@requires_agent
def test_stopped_owner_is_an_explicit_refusal_without_starting(tmp_path):
    home = tmp_path / "hermes"
    home.mkdir()
    sidecar = SidecarProcess(home)
    try:
        response, _ = sidecar.call("gateway.session", {
            "profile_home": str(home), "session_id": "native-chat", "action": "snapshot",
        })
    finally:
        sidecar.close()
    expected = "stopped" if (AGENT_DIR / "hermes_cli/gateway_client.py").exists() else "incompatible"
    assert response.get("result", {}).get("state") == expected, response
    assert not (home / "gateway.pid").exists()


@requires_agent
@pytest.mark.parametrize("mode", ["shared", "batch", "approval", "clarify", "recovery", "secure", "profiles", "dedicated", "replay"])
def test_real_native_owner_shared_admission_and_detach(tmp_path, mode):
    if not (AGENT_DIR / "hermes_cli/gateway_client.py").exists():
        pytest.skip("this supported Agent does not expose native sessions")
    home = tmp_path / "hermes"
    env = isolated_env(home, HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR), HERMES_WEBUI_PYTHON=str(AGENT_PYTHON),
                       PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_session_peer.py"), mode],
                            env=env, capture_output=True, text=True, timeout=200, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


@requires_agent
def test_diagnostic_creation_refuses_without_starting(tmp_path):
    home = tmp_path / "hermes"
    home.mkdir()
    sidecar = SidecarProcess(home)
    try:
        probed = sidecar.result("gateway.create", {"profile_home": str(home), "probe": True})
        created = sidecar.result("gateway.create", {"profile_home": str(home), "request_id": "never", "execution_mode": "safe",
                                                    "cwd": str(tmp_path), "model": "fixture"})
    finally:
        sidecar.close()
    native = (AGENT_DIR / "hermes_cli/gateway_client.py").exists()
    for result in (probed, created):
        if native:
            assert result["state"] == "stopped", result
        else:
            assert (result["state"], result["reason"]) == ("incompatible", "native_sessions_unavailable"), result
        assert result["snapshot"] is None and result["receipt"] is None
    assert not (home / "gateway.pid").exists() and not (home / "state.db").exists()


@requires_agent
def test_real_owner_diagnostic_execution_modes(tmp_path):
    if not (AGENT_DIR / "hermes_cli/gateway_client.py").exists():
        pytest.skip("this supported Agent does not expose native sessions")
    home = tmp_path / "hermes"
    env = isolated_env(home, HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR), HERMES_WEBUI_PYTHON=str(AGENT_PYTHON),
                       PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_execution_peer.py")],
                            env=env, capture_output=True, text=True, timeout=600, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
