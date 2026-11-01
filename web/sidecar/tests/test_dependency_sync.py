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
        assert result['ok'] is (mode in ('success', 'legacy')), result
        assert result['skipped'] is (mode == 'legacy')
        if mode != 'legacy':
            assert json.loads((agent / 'called.json').read_text()) == {
                'args': ['--project-root', str(agent), '--json'], 'home': str(home), 'lazy': '1',
            }
        message, _ = proc.call('runtime.sync_dependencies', {'agent_dir': str(tmp_path / 'another-agent')})
        assert message['error']['code'] == -32602
    finally:
        proc.close()


def _looping_agent(tmp_path):
    agent = tmp_path / 'agent'
    home = tmp_path / 'home'
    package = agent / 'hermes_cli'
    package.mkdir(parents=True)
    home.mkdir()
    (package / '__init__.py').write_text('')
    loop = """
import os, time
from pathlib import Path
Path({pid!r}).write_text(str(os.getpid()))
while True:
    with open({output!r}, 'a') as out: out.write('x')
    time.sleep(0.03)
"""
    (agent / 'grandchild.py').write_text(loop.format(pid='grandchild.pid', output='child-writes'))
    (package / 'venv_sync.py').write_text(
        "import subprocess, sys\nsubprocess.Popen([sys.executable, 'grandchild.py'])\n"
        + loop.format(pid='writer.pid', output='writes'))
    return agent, home


def _wait_for_file(path):
    import time
    deadline = time.monotonic() + 5
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert path.exists(), f'writer never created {path.name}'


def _clean_writers(agent):
    import os
    import signal
    for path in (agent / 'writer.pid', agent / 'grandchild.pid'):
        if path.exists():
            try: os.kill(int(path.read_text()), signal.SIGKILL)
            except ProcessLookupError: pass


@pytest.mark.parametrize('stop', ['cancel', 'shutdown', 'eof', 'kill'])
def test_dependency_sync_writer_stops_with_its_rpc_owner(tmp_path, stop):
    import time

    agent, home = _looping_agent(tmp_path)
    proc = SidecarProcess(home, agent_dir=agent, python=sys.executable)
    try:
        request = proc.request('runtime.sync_dependencies', {'agent_dir': str(agent)})
        # Each writer records its pid before its first append; stopping in that gap leaves no file to measure.
        for name in ('writes', 'child-writes'):
            _wait_for_file(agent / name)
        if stop == 'cancel':
            proc.request('rpc.cancel', {'id': request})
        elif stop == 'shutdown':
            proc.request('runtime.shutdown', {})
        elif stop == 'eof':
            proc.proc.stdin.close()
        else:
            proc.proc.kill()
        time.sleep(1)
        before = [(agent / name).stat().st_size for name in ('writes', 'child-writes')]
        time.sleep(0.3)
        assert [(agent / name).stat().st_size for name in ('writes', 'child-writes')] == before, 'dependency writer outlived its RPC owner'
    finally:
        _clean_writers(agent)
        proc.close()


def test_dependency_sync_refuses_overlapping_writers(tmp_path):
    agent, home = _looping_agent(tmp_path)
    proc = SidecarProcess(home, agent_dir=agent, python=sys.executable)
    try:
        proc.request('runtime.sync_dependencies', {'agent_dir': str(agent)})
        _wait_for_file(agent / 'grandchild.pid')
        first = (agent / 'writer.pid').read_text()
        result = proc.result('runtime.sync_dependencies', {'agent_dir': str(agent)})
        assert result['ok'] is False
        assert 'Another Agent dependency sync is still running' in result['detail']
        assert (agent / 'writer.pid').read_text() == first
    finally:
        _clean_writers(agent)
        proc.close()
