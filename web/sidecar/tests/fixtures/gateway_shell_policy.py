"""Supported owner's shell contract with synthetic policies and a subprocess tripwire."""
import asyncio
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace as NS
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
from gateway import session_shell as shell
from hermes_state_runtime import RuntimeStoreError

root = Path(sys.argv[2])
first, second = root / 'first', root / 'second'
first.mkdir(parents=True)
second.mkdir()
policies = {sid: NS(cwd=str(cwd), terminal_json='{"TERMINAL_ENV":"local"}') for sid, cwd in [('first', first), ('second', second)]}
connection = NS(authority=NS(runner=object(), sessions={sid: NS(source=sid) for sid in policies}, _require_admission_open=lambda: None))
observed = []

def run(command, **kwargs):
    observed.append((command, kwargs))
    assert kwargs['env'].get('OPENAI_API_KEY') is None
    assert kwargs['stdin'] == subprocess.DEVNULL and kwargs['timeout'] == 30
    if command == 'timeout':
        raise subprocess.TimeoutExpired(command, 30)
    # A secret crosses the eventual tail boundary. Only redact-then-tail removes all of it.
    return NS(stdout='x' * 100 + ' sk-' + 'a' * 48 + '\n' + 'z' * 3975, stderr='diagnostic', returncode=7)

async def main():
    with patch('gateway.session_busy_controls.authorize', lambda *args: None), \
         patch('gateway.session_local.authorize_local_source', lambda *args: True), \
         patch('gateway.session_policy.policy_for_source', lambda runner, source: policies[source]), \
         patch('subprocess.run', run), patch.dict('os.environ', {'OPENAI_API_KEY': 'sk-' + 'a' * 48}):
        results = []
        for sid in policies:
            result = await shell.shell_exec(connection, NS(session_id=sid), {'session_id': sid, 'command': 'pwd'})
            assert result['code'] == 7 and result['stderr'] == 'diagnostic'
            assert len(result['stdout']) <= 4000 and 'a' * 10 not in result['stdout']
            assert observed[-1][1]['cwd'] == policies[sid].cwd
            results.append(result)
        for backend in ['ssh', 'docker']:
            policies['first'].terminal_json = json.dumps({'TERMINAL_ENV': backend})
            count = len(observed)
            try:
                await shell.shell_exec(connection, NS(session_id='first'), {'session_id': 'first', 'command': 'pwd'})
                raise AssertionError('remote backend ran on host')
            except RuntimeStoreError as error:
                assert str(error) == 'unsupported_terminal_backend'
            assert len(observed) == count
        policies['first'].terminal_json = '{"TERMINAL_ENV":"local"}'
        for command, expected in [('rm -rf /', 'dangerous_command'), ('timeout', 'command_timeout')]:
            try:
                await shell.shell_exec(connection, NS(session_id='first'), {'session_id': 'first', 'command': command})
                raise AssertionError('expected native refusal')
            except RuntimeStoreError as error:
                assert str(error) == expected
        policies['first'].cwd = str(root / 'missing')
        count = len(observed)
        try:
            await shell.shell_exec(connection, NS(session_id='first'), {'session_id': 'first', 'command': 'pwd'})
            raise AssertionError('missing cwd fell back')
        except RuntimeStoreError as error:
            assert str(error) == 'cwd_unavailable'
        assert len(observed) == count
        print(json.dumps(results[0]))

asyncio.run(main())
