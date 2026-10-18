"""The installed Agent's real guard registry with synthetic routes and local pricing, never provider traffic."""
import json
import subprocess
import textwrap

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent


@requires_agent
def test_real_selection_guards_and_read_only_context(tmp_path):
    script = textwrap.dedent('''
        import json, sqlite3, sys
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import patch
        from agent.models_dev import ModelInfo
        from talaria_sidecar.methods import providers, chat
        from talaria_sidecar.home import scoped_home
        home = Path(sys.argv[1]); home.mkdir()
        params = dict(session_id='guard-test', model='muse-spark-1.2-contributor', provider='custom', current_model='old-model', context_tokens=200000, messages=[])
        route = dict(provider='custom', base_url='https://provider.invalid/v1', api_key='synthetic-key')
        with scoped_home(home), patch.object(chat, '_resolve_runtime', return_value=route), patch('agent.models_dev.get_model_info', return_value=None), patch('agent.usage_pricing.get_pricing_entry', return_value=None):
            result = providers.selection_warnings(home, params)
            assert {w['kind'] for w in result['warnings']} == {'data_policy', 'context_cache'}, result
            (home / 'config.yaml').write_text('model:\\n  switch_context_confirm_tokens: 0\\n')
            assert {w['kind'] for w in providers.selection_warnings(home, params)['warnings']} == {'data_policy'}
            (home / 'config.yaml').write_text('model:\\n  switch_context_confirm_tokens: 100000\\n')
            params['model'] = 'ordinary/model'; params['context_tokens'] = None
            assert providers.selection_warnings(home, params)['warnings'] == []
            # A different profile's cached Agent must never supply this profile's context.
            agent = SimpleNamespace(model='old-model', context_compressor=SimpleNamespace(last_prompt_tokens=250000))
            chat._AGENT_CACHE['guard-test'] = (agent, 'signature', home / 'foreign')
            assert providers.selection_warnings(home, params)['context_tokens'] is None
            chat._AGENT_CACHE['guard-test'] = (agent, 'signature', home)
            assert providers.selection_warnings(home, params)['context_tokens'] == 250000
            assert chat._AGENT_CACHE['guard-test'][0] is agent
            chat._AGENT_CACHE.clear()
            # Persist a real Agent anchor, then prove reading it changes no database bytes.
            from agent.usage_anchor import capture_usage_anchor, _serialize
            messages = [{'role': 'user', 'content': 'test context'}]
            anchor = capture_usage_anchor(220000, 0, messages)
            db = sqlite3.connect(home / 'state.db')
            db.execute('CREATE TABLE sessions (id TEXT, model_config TEXT)')
            db.execute('INSERT INTO sessions VALUES (?, ?)', ('guard-test', json.dumps({'_usage_anchor': _serialize(anchor)})))
            db.commit(); db.close()
            before = (home / 'state.db').read_bytes()
            params['messages'] = messages
            assert providers.selection_warnings(home, params)['context_tokens'] == 220000
            assert (home / 'state.db').read_bytes() == before
            params['messages'] = []
            assert providers.selection_warnings(home, params)['context_tokens'] is None
            # Real cost guard reads a fixed local price, without lookup or model requests.
            route['provider'] = 'anthropic'; route['base_url'] = 'https://api.anthropic.com'
            info = ModelInfo(id='pricey/model', name='pricey/model', family='', provider_id='anthropic', cost_input=50.0, cost_output=200.0)
            params.update(model='pricey/model', provider='anthropic', context_tokens=1)
            with patch('agent.models_dev.get_model_info', return_value=info):
                assert {w['kind'] for w in providers.selection_warnings(home, params)['warnings']} == {'cost'}
            print(json.dumps(result))
    ''')
    env = isolated_env(tmp_path / 'launch')
    env['PYTHONPATH'] = f'{SIDECAR_ROOT}:{AGENT_DIR}'
    run = subprocess.run([AGENT_PYTHON, '-c', script, str(tmp_path / 'profile')], env=env, capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stdout + run.stderr
    assert json.loads(run.stdout.splitlines()[-1])['context_tokens'] == 200_000
