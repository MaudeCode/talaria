"""The installed Agent owns cost parsing and approval; no MCP tool is called."""
import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@requires_agent
def test_native_mcp_cost_policy_and_budget_approval(tmp_path):
    probe = pathlib.Path(__file__).with_name('probe_mcp_cost_policy.py')
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=isolated_env(tmp_path / 'agent'),
                         capture_output=True, text=True, timeout=90)
    assert run.returncode == 0, run.stdout + run.stderr
