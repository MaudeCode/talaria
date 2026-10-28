"""Native offer policy stays Agent-owned across supported releases."""
from pathlib import Path
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@requires_agent
def test_native_connector_offer_schedule_and_claim_once(tmp_path):
    probe = Path(__file__).with_name('probe_connector_offer.py')
    result = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)],
                            env=isolated_env(tmp_path / 'agent'), capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
