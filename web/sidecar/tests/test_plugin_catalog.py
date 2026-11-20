"""Native pinned catalog install, scanner and dependency-consent contract."""
from pathlib import Path
import json
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, load_schema, requires_agent, share_pm_store, validate


@requires_agent
@pytest.mark.pm_store
def test_native_catalog_install(tmp_path: Path):
    offline = share_pm_store(tmp_path)
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).with_name('probe_plugin_catalog.py')), str(AGENT_DIR)],
                            env=isolated_env(tmp_path, **offline), capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    payload = next((line.removeprefix('TYPED_CATALOG=') for line in result.stdout.splitlines() if line.startswith('TYPED_CATALOG=')), None)
    assert payload is not None, 'Native probe did not publish typed evidence'
    outputs = json.loads(payload)
    assert validate(outputs['catalog'], load_schema('plugins.catalog')) == []
    assert outputs['catalog']['supported'] is True
    for key in ('review', 'blocked', 'installed'):
        assert validate(outputs[key], load_schema('plugins.install')) == []
