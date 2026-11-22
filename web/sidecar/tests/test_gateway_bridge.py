"""The private session bridge's socket boundary, run once per supported Agent on Linux (TAL-1977)."""
from pathlib import Path
import json
import subprocess
import sys

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@requires_agent
@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="the private session bridge needs Linux peer credentials")
@pytest.mark.parametrize("check", ["config", "paths", "platform", "relay", "profiles", "binding", "peers", "framing", "shutdown", "cleanup"])
def test_bridge_socket_boundary_and_lifecycle(tmp_path, check):
    """One check of gateway_bridge_peer.py over its own disposable homes and socket; its docstring names the contract."""
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_bridge_peer.py"), check],
                            env=isolated_env(tmp_path / "hermes", TALARIA_WEB_AGENT_DIR=str(AGENT_DIR)),
                            capture_output=True, text=True, timeout=60, check=False)
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    assert [line for line in result.stdout.splitlines() if line.startswith("CHECKS ")] == ["CHECKS " + json.dumps([check])], output
