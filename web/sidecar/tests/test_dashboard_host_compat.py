"""Only the actual Agent can prove its per-profile executable host and cached-app admission ABI."""
import pathlib
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent, share_pm_store


def run_probe(tmp_path, scenario):
    home = tmp_path / '.hermes'
    home.mkdir()
    offline = share_pm_store(home)
    result = subprocess.run([AGENT_PYTHON, str(pathlib.Path(__file__).with_name('probe_dashboard_plugins.py')), str(AGENT_DIR), scenario],
                            env=isolated_env(home, **offline), capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr


@requires_agent
def test_native_dashboard_host_profile_and_request_admission(tmp_path):
    run_probe(tmp_path, 'hosts')


@requires_agent
@pytest.mark.pm_store
@pytest.mark.parametrize('switch', ['off', 'on'])
def test_native_dashboard_toggle_runs_the_agent_admission(tmp_path, switch):
    run_probe(tmp_path, 'toggle-' + switch)
