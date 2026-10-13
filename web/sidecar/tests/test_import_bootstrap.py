"""Agent imports must not adopt, sync, or replace the sidecar process."""

import json
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@requires_agent
def test_chat_import_does_not_adopt_sync_or_exec_a_blessed_checkout(tmp_path):
    if not (AGENT_DIR / "hermes_cli/venv_sync.py").exists():
        pytest.skip("Agent release predates lazy dependency sync")
    home = tmp_path / "home"
    hermes = home / ".hermes"
    checkout = hermes / "hermes-agent"
    hermes.mkdir(parents=True)
    subprocess.run(["git", "clone", "--quiet", "--shared", str(AGENT_DIR), str(checkout)], check=True)
    probe = r'''
import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import pm
import pm.environments
from hermes_cli import venv_sync, _launchers
calls = []
pm.venv_is_current = lambda **kw: False
venv_sync._finish_source_update = lambda *a, **kw: calls.append("sync")
venv_sync.publish_launchers = lambda *a, **kw: calls.append("publish")
_launchers.resolve_store_python = lambda *a: Path(sys.executable)
pm.environments.activate_dependencies = lambda *a: None
os.execv = lambda *a: calls.append("exec")
from talaria_sidecar.methods.chat import _agent_class
cls = _agent_class()
print(json.dumps({"class": cls.__name__, "calls": calls, "stamp": (Path(sys.argv[1]) / "install-stamp.json").exists()}))
'''
    result = subprocess.run(
        [AGENT_PYTHON, "-c", probe, str(checkout)],
        env=isolated_env(hermes, home=home, HERMES_DISABLE_LAZY_INSTALLS="0"),
        cwd=checkout, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    observed = json.loads(result.stdout.strip().splitlines()[-1])
    assert observed == {"class": "AIAgent", "calls": [], "stamp": False}
