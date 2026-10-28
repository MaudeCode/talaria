"""Compatibility proof against the reviewed plugin revision; provisioning happens before the suite."""
import json
import os
from pathlib import Path
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent, load_schema, validate


@requires_agent
def test_reviewed_native_importer_contract(tmp_path):
    plugin = os.environ.get('HERMES_WEBUI_IMPORTER_DIR')
    assert plugin and (Path(plugin) / 'importer.py').is_file(), 'Run via check-agent-compatibility.py to provision reviewed plugin bytes'
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).with_name('probe_agent_imports.py')), str(AGENT_DIR), plugin],
                            env=isolated_env(tmp_path / 'hermes'), capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    payload = next(line.removeprefix('NATIVE_IMPORT=') for line in result.stdout.splitlines() if line.startswith('NATIVE_IMPORT='))
    for response in json.loads(payload).values():
        assert validate(response, load_schema('profiles.import')) == []
