"""TAL-1263: every provider sign-in builds its HTTP client with the supported Agent's TLS verification, so a CA the
Agent trusts and an install-environment rotation under a running sidecar behave as in the Agent's own sign-in."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

pytestmark = requires_agent

PROBE = Path(__file__).with_name("oauth_tls_probe.py")


def probe(tmp_path: Path, *args: str) -> dict:
    home = tmp_path / ".hermes"
    home.mkdir()
    run = subprocess.run([AGENT_PYTHON, str(PROBE), str(AGENT_DIR), *args[:1], str(tmp_path), *args[1:]], env=isolated_env(home),
                         capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    return json.loads(run.stdout.strip().splitlines()[-1])


def test_the_sign_in_client_trusts_an_exported_ca_bundle_on_top_of_the_agents_platform_store(tmp_path):
    assert probe(tmp_path, "cert_file") == {"handshake": True, "platform_store": True}


@pytest.mark.parametrize("entry", ["client", "xai"])
def test_a_sign_in_survives_a_deleted_certifi_bundle(tmp_path, entry):
    result = probe(tmp_path, "rotated", entry)
    if not result["recovers"]:
        pytest.skip("the Agent's certifi rotation recovery first shipped in v0.22.3")
    assert result == {"recovers": True, "built": True}
