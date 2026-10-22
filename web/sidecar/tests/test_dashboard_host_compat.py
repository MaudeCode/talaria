"""Only the actual Agent can prove its per-profile executable host and cached-app admission ABI."""
import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@requires_agent
def test_native_dashboard_host_profile_and_request_admission(tmp_path):
    home = tmp_path / '.hermes'
    home.mkdir()
    result = subprocess.run([AGENT_PYTHON, str(pathlib.Path(__file__).with_name('probe_dashboard_plugins.py')), str(AGENT_DIR)],
                            env=isolated_env(home), capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
