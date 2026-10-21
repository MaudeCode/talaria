"""Actual supported-Agent allowlist reconciliation through approval.respond."""

import subprocess
from pathlib import Path

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@requires_agent
def test_always_preserves_revocation_and_profile_scoped_grants(tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    run = subprocess.run(
        [AGENT_PYTHON, str(Path(__file__).with_name("command_approval_probe.py")), str(AGENT_DIR)],
        env=isolated_env(home), capture_output=True, text=True, timeout=60,
    )
    assert run.returncode == 0, run.stdout + run.stderr
