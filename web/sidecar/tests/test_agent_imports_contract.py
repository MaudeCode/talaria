"""Compatibility proof against the reviewed plugin revision; provisioning happens before the suite."""
import json
import os
from pathlib import Path
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent, load_schema, validate


@requires_agent
def test_agent_catalog_ships_a_reviewed_importer(tmp_path):
    # The real catalog entry, not a stub: an Agent release that re-pins the plugin must fail here first.
    code = "from hermes_cli.plugin_catalog import get_catalog_entry as g; e = g('agent-importers'); print(e.sha if e else '')"
    sha = subprocess.run([AGENT_PYTHON, '-c', code], cwd=AGENT_DIR, env=isolated_env(tmp_path / 'hermes'),
                         capture_output=True, text=True, timeout=60, check=True).stdout.strip()
    reviewed = json.loads((SIDECAR_ROOT / 'agent_importer.json').read_text())['revisions']
    assert not sha or sha in reviewed, f'Agent catalog pins unreviewed agent-importers {sha}'


@requires_agent
def test_reviewed_native_importer_contract(tmp_path):
    plugin = os.environ.get('HERMES_WEBUI_IMPORTER_DIR')
    assert plugin and any(Path(plugin).glob('*/importer.py')), 'Run via check-agent-compatibility.py to provision reviewed plugin bytes'
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).with_name('probe_agent_imports.py')), str(AGENT_DIR), plugin],
                            env=isolated_env(tmp_path / 'hermes'), capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    payload = next(line.removeprefix('NATIVE_IMPORT=') for line in result.stdout.splitlines() if line.startswith('NATIVE_IMPORT='))
    for response in json.loads(payload).values():
        assert validate(response, load_schema('profiles.import')) == []
