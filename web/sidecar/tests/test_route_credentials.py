"""TAL-2294: the model, auxiliary and delegation blocks the server saves after a route change, resolved by the installed
Agent. No credential saved for the old endpoint reaches the new route; a key entered with the change does."""
import json
import pathlib
import subprocess
import textwrap

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent

FIXTURE = pathlib.Path(__file__).parent / 'fixtures' / 'route-credential-switch.json'


@requires_agent
def test_real_agent_sends_no_old_endpoint_credential_to_a_new_route(tmp_path):
    script = textwrap.dedent('''
        import json, sys
        from pathlib import Path
        from types import SimpleNamespace
        import httpx
        from talaria_sidecar.home import scoped_home
        from talaria_sidecar.methods import chat
        import agent.auxiliary_client as native_aux
        from tools.delegate_tool_config import _load_config, _resolve_delegation_credentials

        home = Path(sys.argv[1]); home.mkdir()
        fixture = json.loads(Path(sys.argv[2]).read_text())
        (home / '.env').write_text(''.join(f'{k}={v}\\n' for k, v in fixture['env'].items()))
        sent = []
        def answer(request):
            sent.append((request.url.host, request.headers.get('authorization')))
            return httpx.Response(200, json=dict(id='x', object='chat.completion', created=0, model='m', choices=[dict(index=0, finish_reason='stop', message=dict(role='assistant', content='ok'))]))
        def write(config):
            (home / 'config.yaml').write_text(json.dumps(config))
        def aux_call(task):
            """The slot's real client, sending one request through a fake transport: (host, Authorization)."""
            provider, model, base_url, api_key, api_mode = native_aux._resolve_task_provider_model(task)
            client, model = native_aux.resolve_provider_client(provider, model, explicit_base_url=base_url, explicit_api_key=api_key, api_mode=api_mode, task=task)
            client.with_options(http_client=httpx.Client(transport=httpx.MockTransport(answer))).chat.completions.create(model=model, messages=[dict(role='user', content='hi')])
            return sent[-1]
        def child():
            return _resolve_delegation_credentials(_load_config(), SimpleNamespace(request_overrides=None))
        def main(config):
            return chat._resolve_runtime(None, config['model']['default'])
        env_key = fixture['env']['OPENAI_API_KEY']
        entered = fixture['switched']['auxiliary']['vision']['api_key']
        old_keys = {fixture['before']['model']['api_key'], fixture['env']['OLD_KEY']}
        with scoped_home(home):
            write(fixture['switched'])
            assert aux_call('vision') == ('openrouter.ai', f'Bearer {entered}'), sent
            assert aux_call('compression') == ('api.openai.com', f'Bearer {env_key}'), sent
            runtime = main(fixture['switched'])
            assert (runtime['base_url'].rstrip('/'), runtime['api_key']) == (fixture['switched']['model']['base_url'], env_key), runtime
            bundle = child()
            assert (bundle['base_url'].rstrip('/'), bundle['api_key']) == (fixture['switched']['model']['base_url'], env_key), bundle

            # Reset All: every slot inherits again and names no endpoint or credential of its own.
            write(fixture['reset'])
            for task in ('vision', 'compression'):
                assert native_aux._resolve_task_provider_model(task)[2:4] == (None, None), task
            bundle = child()
            assert (bundle['provider'], bundle['base_url'], bundle['api_key']) == (None, None, None), bundle

            # The same switch with the old endpoint's keys left behind, as saved before TAL-2294: the Agent sends them.
            leaked = json.loads(json.dumps(fixture['switched']))
            for path in (['model'], ['auxiliary', 'compression'], ['delegation']):
                old, new = fixture['before'], leaked
                for key in path: old, new = old[key], new[key]
                new.update({k: v for k, v in old.items() if k in ('api_key', 'key_env', 'api_key_env')})
            write(leaked)
            host, auth = aux_call('compression')
            assert host == 'api.openai.com' and auth.removeprefix('Bearer ') in old_keys, sent
            assert main(leaked)['api_key'] in old_keys
            assert child()['api_key'] in old_keys
            print(json.dumps(dict(requests=len(sent))))
    ''')
    env = isolated_env(tmp_path / 'launch')
    env['PYTHONPATH'] = f'{SIDECAR_ROOT}:{AGENT_DIR}'
    run = subprocess.run([AGENT_PYTHON, '-c', script, str(tmp_path / 'profile'), str(FIXTURE)], env=env, capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stdout + run.stderr
    assert json.loads(run.stdout.splitlines()[-1])['requests'] == 3
