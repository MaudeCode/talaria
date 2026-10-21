"""Native input-aware reconnect requires a real portable package and stdio child."""
import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@requires_agent
def test_plugin_save_reconciles_live_mcp_inputs(tmp_path):
    probe = pathlib.Path(__file__).with_name("probe_plugin_settings_mcp.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=isolated_env(tmp_path / "agent"),
                         capture_output=True, text=True, timeout=180)
    assert run.returncode == 0, run.stdout + run.stderr
