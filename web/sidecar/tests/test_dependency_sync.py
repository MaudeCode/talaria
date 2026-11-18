"""Dependency repair stays available when new Agent code cannot import."""
import json
import sys
import time

import pytest

from conftest import SidecarProcess, assert_matches, process_snapshot
from talaria_sidecar import SIDECAR_RPC_VERSION


def test_dependency_sync_rpc_owns_the_agent_subprocess(tmp_path):
    agent = tmp_path / 'agent'
    home = tmp_path / 'home'
    agent.mkdir()
    home.mkdir()
    (agent / 'run_agent.py').write_text('raise RuntimeError("dependencies missing")\n')
    package = agent / 'hermes_cli'
    package.mkdir()
    (package / '__init__.py').write_text('')
    (package / 'venv_sync.py').write_text('''
import json, os, sys
from pathlib import Path
Path('called.json').write_text(json.dumps({'args': sys.argv[1:], 'home': os.environ['HERMES_HOME'], 'lazy': os.environ['HERMES_DISABLE_LAZY_INSTALLS']}))
print(json.dumps({'ok': True, 'detail': ''}))
''')
    proc = SidecarProcess(home, agent_dir=agent, python=sys.executable)
    try:
        assert proc.result('runtime.handshake', {'rpc_version': SIDECAR_RPC_VERSION})['compatible'] is False
        message, _ = proc.call('runtime.sync_dependencies', {'agent_dir': str(agent)})
        assert 'result' in message, message
        assert_matches('runtime.sync_dependencies', message['result'])
        assert message['result'] == {'ok': True, 'skipped': False, 'detail': ''}
        assert json.loads((agent / 'called.json').read_text()) == {
            'args': ['--project-root', str(agent), '--json'], 'home': str(home), 'lazy': '1',
        }
        message, _ = proc.call('runtime.sync_dependencies', {'agent_dir': str(tmp_path / 'another-agent')})
        assert message['error']['code'] == -32602
    finally:
        proc.close()


@pytest.mark.parametrize('mode, returncode, output, expected', [
    ('exit', 1, b'{"ok": false, "detail": "synthetic sync failure"}', {'ok': False, 'skipped': False}),
    ('failed', 0, b'{"ok": false, "detail": "synthetic sync failure"}', {'ok': False, 'skipped': False, 'detail': 'synthetic sync failure'}),
    ('invalid', 0, b'invalid', {'ok': False, 'skipped': False, 'detail': 'Agent dependency sync returned an invalid result.'}),
    ('legacy', None, None, {'ok': True, 'skipped': True, 'detail': ''}),
], ids=['exit', 'failed', 'invalid', 'legacy'])
def test_dependency_sync_maps_the_writer_result(tmp_path, monkeypatch, mode, returncode, output, expected):
    """The supervisor's exit status and JSON line become the RPC result; an Agent without venv_sync is skipped."""
    import subprocess
    import threading
    import types
    from talaria_sidecar.methods import Registry, runtime as runtime_methods

    agent = tmp_path / 'agent'
    (agent / 'hermes_cli').mkdir(parents=True)
    if mode != 'legacy':
        (agent / 'hermes_cli' / 'venv_sync.py').write_text('')
    launched = []

    class Supervisor:
        def __init__(self, argv, *, stdout, stdin, **kwargs):
            launched.append(argv)
            stdout.write(output)
            self.returncode, self.stdin = returncode, types.SimpleNamespace(close=lambda: None)

        def poll(self):
            return self.returncode

        def wait(self):
            return self.returncode

    monkeypatch.setattr(subprocess, 'Popen', Supervisor)
    registry = Registry(runtime=types.SimpleNamespace(agent_dir=agent, hermes_home=tmp_path / 'home', retire=lambda: None))
    runtime_methods.register(registry)
    ctx = types.SimpleNamespace(check_cancelled=lambda: None, cancel_event=threading.Event())
    result = registry.methods['runtime.sync_dependencies'](ctx, {'agent_dir': str(agent)})
    assert_matches('runtime.sync_dependencies', result)
    assert {key: result[key] for key in expected} == expected
    assert len(launched) == (0 if mode == 'legacy' else 1)


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


def _wait(done, failure):
    deadline = time.monotonic() + 5
    while not done() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert done(), failure


def _wait_for_file(path):
    _wait(path.exists, f'writer never created {path.name}')


def _clean_writers(agent):
    import os
    import signal
    for path in (agent / 'writer.pid', agent / 'grandchild.pid'):
        if path.exists():
            try: os.kill(int(path.read_text()), signal.SIGKILL)
            except ProcessLookupError: pass


@pytest.mark.parametrize('stop', ['cancel', 'shutdown', 'eof', 'kill'])
def test_dependency_sync_writer_stops_with_its_rpc_owner(tmp_path, stop):
    agent, home = _looping_agent(tmp_path)
    proc = SidecarProcess(home, agent_dir=agent, python=sys.executable)
    try:
        request = proc.request('runtime.sync_dependencies', {'agent_dir': str(agent)})
        # Each writer records its pid before its first append, so a write proves a complete pid file.
        for name in ('writes', 'child-writes'):
            _wait_for_file(agent / name)
        writers = {int((agent / name).read_text()) for name in ('writer.pid', 'grandchild.pid')}
        # A zombie or reused PID lists other args, so a matching row is a writer still running.
        running = lambda: {(pid, args) for pid, _, _, args in process_snapshot() if pid in writers}
        started = running()
        assert len(started) == 2, started
        if stop == 'cancel':
            proc.request('rpc.cancel', {'id': request})
        elif stop == 'shutdown':
            proc.request('runtime.shutdown', {})
        elif stop == 'eof':
            proc.proc.stdin.close()
        else:
            proc.proc.kill()
        _wait(lambda: not started & running(), 'dependency writer outlived its RPC owner')
    finally:
        _clean_writers(agent)
        proc.close()


def test_dependency_sync_refuses_overlapping_writers(tmp_path):
    agent, home = _looping_agent(tmp_path)
    proc = SidecarProcess(home, agent_dir=agent, python=sys.executable)
    request = None
    reaped = False
    try:
        request = proc.request('runtime.sync_dependencies', {'agent_dir': str(agent)})
        _wait_for_file(agent / 'grandchild.pid')
        first = (agent / 'writer.pid').read_text()
        result = proc.result('runtime.sync_dependencies', {'agent_dir': str(agent)})
        assert result['ok'] is False
        assert 'Another Agent dependency sync is still running' in result['detail']
        assert (agent / 'writer.pid').read_text() == first
    finally:
        try:
            if request is not None:
                proc.request('rpc.cancel', {'id': request})
                while True:
                    message = proc.next_message()
                    assert message is not None, 'sidecar exited before dependency writer cleanup acknowledgement'
                    if message.get('id') == request:
                        # The RPC's finally waits for the supervisor to reap its writer before replying.
                        reaped = True
                        break
        finally:
            if not reaped:
                _clean_writers(agent)
            proc.close()
