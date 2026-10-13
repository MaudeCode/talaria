"""Dependency repair stays available when new Agent code cannot import."""
import json
import sys

import pytest

from conftest import SidecarProcess, assert_matches
from talaria_sidecar import SIDECAR_RPC_VERSION


@pytest.mark.parametrize('mode', ['success', 'exit', 'failed', 'invalid', 'legacy'])
def test_dependency_sync_rpc_owns_the_agent_subprocess(tmp_path, mode):
    agent = tmp_path / 'agent'
    home = tmp_path / 'home'
    agent.mkdir()
    home.mkdir()
    (agent / 'run_agent.py').write_text('raise RuntimeError("dependencies missing")\n')
    if mode != 'legacy':
        package = agent / 'hermes_cli'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'venv_sync.py').write_text(f'''
import json, os, sys
from pathlib import Path
Path('called.json').write_text(json.dumps({{'args': sys.argv[1:], 'home': os.environ['HERMES_HOME'], 'lazy': os.environ['HERMES_DISABLE_LAZY_INSTALLS']}}))
print('invalid' if {mode!r} == 'invalid' else json.dumps({{'ok': {mode!r} == 'success', 'detail': 'synthetic sync failure'}}))
sys.exit(1 if {mode!r} == 'exit' else 0)
''')
    proc = SidecarProcess(home, agent_dir=agent, python=sys.executable)
    try:
        assert proc.result('runtime.handshake', {'rpc_version': SIDECAR_RPC_VERSION})['compatible'] is False
        message, _ = proc.call('runtime.sync_dependencies', {'agent_dir': str(agent)})
        assert 'result' in message, message
        result = message['result']
        assert_matches('runtime.sync_dependencies', result)
        assert result['ok'] is (mode in ('success', 'legacy'))
        assert result['skipped'] is (mode == 'legacy')
        if mode != 'legacy':
            assert json.loads((agent / 'called.json').read_text()) == {
                'args': ['--project-root', str(agent), '--json'], 'home': str(home), 'lazy': '1',
            }
        message, _ = proc.call('runtime.sync_dependencies', {'agent_dir': str(tmp_path / 'another-agent')})
        assert message['error']['code'] == -32602
    finally:
        proc.close()
