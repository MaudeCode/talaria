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
        params = dict(session_id='guard-test', model='muse-spark-1.2-contributor', provider='custom', base_url='https://provider.invalid/v1', current_provider='custom', current_model='old-model', context_tokens=200000, messages=[])
        with scoped_home(home), patch('agent.models_dev.get_model_info', return_value=None), patch('agent.usage_pricing.get_pricing_entry', return_value=None):
            result = providers.selection_warnings(home, params)
            assert {w['kind'] for w in result['warnings']} == {'data_policy', 'context_cache'}, result
            (home / 'config.yaml').write_text('model:\\n  switch_context_confirm_tokens: 0\\n')
            assert {w['kind'] for w in providers.selection_warnings(home, params)['warnings']} == {'data_policy'}
            (home / 'config.yaml').write_text('model:\\n  switch_context_confirm_tokens: 100000\\n')
            params.update(model='ordinary/model', current_model='ordinary/model')
            assert providers.selection_warnings(home, params)['warnings'] == []
            params.update(provider='other-provider', base_url='https://other.invalid/v1')
            assert {w['kind'] for w in providers.selection_warnings(home, params)['warnings']} == {'context_cache'}
            params.update(provider='custom', base_url='https://provider.invalid/v1', current_model='old-model')
            params['context_tokens'] = None
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
            info = ModelInfo(id='pricey/model', name='pricey/model', family='', provider_id='anthropic', cost_input=50.0, cost_output=200.0)
            params.update(model='pricey/model', provider='anthropic', base_url='https://api.anthropic.com', context_tokens=1)
            with patch('agent.models_dev.get_model_info', return_value=info):
                assert {w['kind'] for w in providers.selection_warnings(home, params)['warnings']} == {'cost'}
            print(json.dumps(result))
    ''')
    env = isolated_env(tmp_path / 'launch')
    env['PYTHONPATH'] = f'{SIDECAR_ROOT}:{AGENT_DIR}'
    run = subprocess.run([AGENT_PYTHON, '-c', script, str(tmp_path / 'profile')], env=env, capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stdout + run.stderr
    assert json.loads(run.stdout.splitlines()[-1])['context_tokens'] == 200_000


@requires_agent
def test_real_provider_name_conflicts_refused_before_clients(tmp_path):
    """Native config/disabled semantics and both runtime entry points, without inference or real credentials."""
    script = textwrap.dedent('''
        import json, sys
        from pathlib import Path
        from unittest.mock import patch
        from talaria_sidecar.errors import RpcError
        from talaria_sidecar.home import scoped_home
        from talaria_sidecar.methods import aux, chat, providers
        from hermes_cli.config import load_config
        import agent.auxiliary_client as native_aux

        home = Path(sys.argv[1]); home.mkdir()
        builtin = dict(base_url='https://builtin.invalid/v1', api_key='synthetic-builtin-key')
        proxy = dict(base_url='https://proxy.invalid/v1', api_key='synthetic-proxy-key')
        checked = 0
        def write(records, requested='openai', **extra):
            (home / 'config.yaml').write_text(json.dumps(dict(model=dict(provider=requested, default='test-model'), providers=records, **extra)))
        def refused(call, record):
            global checked
            try:
                call()
            except RpcError as exc:
                assert exc.data['condition'] == 'provider_name_ambiguous', (exc, exc.data)
                assert 'providers.openai' in str(exc) and record in str(exc), str(exc)
                assert 'Rename or remove' in str(exc), str(exc)
                assert all(secret not in str(exc) for secret in [*builtin.values(), *proxy.values()]), str(exc)
                checked += 1
            else:
                raise AssertionError(('ambiguous provider reached runtime/client resolution', requested, load_config().get('providers')))
        def runtimes(requested):
            return [lambda: chat._resolve_runtime(requested, 'test-model'),
                    lambda: providers.resolve_runtime(requested=requested, target_model='test-model', api_key=None, base_url=proxy['base_url'])]
        with scoped_home(home):
            for reverse in [False, True]:
                for keyed in [True, False]:
                    rows = [('openai', builtin), ('custom:openai', proxy if keyed else dict(base_url=proxy['base_url']))]
                    records = dict(reversed(rows) if reverse else rows)
                    for requested in ['openai', 'custom:openai', None, '']:
                        write(records)
                        for call in runtimes(requested):
                            refused(call, 'custom:openai')
                rows = [('openai', builtin), ('custom:openai', proxy)]
                write(dict(reversed(rows) if reverse else rows), auxiliary=dict(title_generation=dict(provider='openai', model='test-model', base_url=proxy['base_url'])))
                # Fail at the actual sidecar boundary, before either native client factory can see a key.
                with patch.object(native_aux, 'get_text_auxiliary_client', side_effect=AssertionError('client built')), patch.object(native_aux, 'resolve_provider_client', side_effect=AssertionError('client built')):
                    refused(lambda: aux.complete('title_generation', [dict(role='user', content='hi')], main_runtime=None, max_tokens=None, temperature=None, ctx=None), 'custom:openai')
            for extra, record in [
                (dict(providers=dict(openai=builtin, proxy=dict(proxy, name='OPENAI'))), 'proxy'),
                (dict(providers=dict(openai=builtin), custom_providers=[dict(proxy, name='openai', enabled=False)]), 'custom_providers[0]'),
                (dict(providers={'CUSTOM:OPENAI': proxy}), 'CUSTOM:OPENAI'),
            ]:
                write(extra.pop('providers'), **extra)
                for call in runtimes('openai'):
                    refused(call, record)
            # These must still resolve their own endpoint and key through the real installed Agent.
            for records, requested, expected in [
                (dict(openai=builtin), 'openai', builtin),
                ({'custom:openai': proxy}, 'custom:openai', proxy),
                (dict(proxy=proxy), 'custom:proxy', proxy),
                ({'x-ai': builtin, 'custom:x_ai': proxy}, 'custom:x_ai', proxy),
                ({'x-ai': builtin, 'custom:x_ai': proxy}, 'x-ai', builtin),
                ({'openai': builtin, 'custom:openai': dict(proxy, enabled=False)}, 'openai', builtin),
            ]:
                write(records, requested)
                for runtime in [chat._resolve_runtime(requested, 'test-model'), providers.resolve_runtime(requested=requested, target_model='test-model', api_key=None, base_url=None)]:
                    assert runtime['base_url'].rstrip('/') == expected['base_url'], runtime
                    assert runtime['api_key'] == expected['api_key'], runtime
            write(dict(openai=builtin, **{'custom:openai': proxy}), auxiliary=dict(title_generation=dict(provider='openai', model='test-model', **proxy)))
            with patch.object(aux, '_aux_request', return_value=(None, False)), patch.object(aux, '_stream_completion', return_value=dict(text='own route')):
                assert aux.complete('title_generation', [dict(role='user', content='hi')], main_runtime=None, max_tokens=None, temperature=None, ctx=None)['text'] == 'own route'
            print(json.dumps(dict(refusals=checked)))
    ''')
    env = isolated_env(tmp_path / 'launch')
    env['PYTHONPATH'] = f'{SIDECAR_ROOT}:{AGENT_DIR}'
    run = subprocess.run([AGENT_PYTHON, '-c', script, str(tmp_path / 'profile')], env=env, capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stdout + run.stderr
    assert json.loads(run.stdout.splitlines()[-1])['refusals'] == 40


@requires_agent
def test_real_agent_parser_answers_model_arguments(tmp_path):
    script = textwrap.dedent('''
        from talaria_sidecar.methods.providers import parse_switch_args as parse
        assert parse('reset') == dict(target='reset', provider=None, reset=True, reasoning=None, errors=[], unsupported_flags=[])
        assert parse('some/model --provider openrouter') == dict(target='some/model', provider='openrouter', reset=False, reasoning=None, errors=[], unsupported_flags=[])
        assert parse('some/model') == dict(target='some/model', provider=None, reset=False, reasoning=None, errors=[], unsupported_flags=[])
        refused = parse('reset --provider openrouter')
        assert not refused['reset'] and len(refused['errors']) == 1, refused
        assert parse('some/model --global --reasoning high')['unsupported_flags'] == ['--global'], parse('some/model --global --reasoning high')
        assert parse('some/model --reasoning high')['reasoning'] == 'high', parse('some/model --reasoning high')
    ''')
    env = isolated_env(tmp_path / 'launch')
    env['PYTHONPATH'] = f'{SIDECAR_ROOT}:{AGENT_DIR}'
    run = subprocess.run([AGENT_PYTHON, '-c', script], env=env, capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr


GUARD_PROBE = """
import json, os, sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.append(sys.argv[1])
import hermes_cli.left_core_migration as left_core
import hermes_cli.model_selection_guards as guards
from talaria_sidecar.methods import Registry, providers

home, lab, keyed = Path(os.environ["HERMES_HOME"]), sys.argv[2], sys.argv[3]
sent, delivered, replied = [], [], []
real = guards.selection_warnings
guards.selection_warnings = lambda model, **kw: sent.append([kw["provider"], kw["base_url"], kw["api_key"]]) or real(model, **kw)
left_core.recover_for_provider = lambda name: delivered.append(name)
registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
providers.register(registry)
guard = registry.methods["models.selection_warnings"]
pool = lambda: json.loads((home / "auth.json").read_text())["credential_pool"]
before = pool()
with patch("agent.models_dev.get_model_info", return_value=None), patch("agent.usage_pricing.get_pricing_entry", return_value=None):
    for provider, url in [("lab", lab)] * 3 + [("keyed", keyed)] * 2 + [("lab", "https://elsewhere.invalid/v1")]:
        reply = guard(None, {"profile_home": str(home), "session_id": "guard", "model": "synthetic-model", "provider": provider,
                             "base_url": url, "current_model": None, "current_provider": None, "context_tokens": None, "messages": []})
        replied.append([reply["provider"], reply["base_url"]])
try:
    from hermes_cli.runtime_provider_custom import main_endpoint_key_for
    selector = True
except ImportError:
    selector = False
print(json.dumps({"sent": sent, "replied": replied, "pool_unchanged": pool() == before, "delivered": delivered, "selector": selector}, default=lambda o: type(o).__name__))
"""


@requires_agent
def test_repeated_guard_checks_leave_inference_credentials_untouched(tmp_path):
    """TAL-2616: a model-switch guard check selects no pool row, mints no key_cmd token and delivers no plugin; the
    key it hands the guards is the Agent's metadata selection for the configured main endpoint (0.23.3+), else none."""
    root, lab, keyed = tmp_path / ".hermes", "https://lab.invalid/v1", "https://keyed.invalid/v1"
    root.mkdir()
    minted = tmp_path / "minted"
    (root / "config.yaml").write_text(json.dumps({
        "model": {"provider": "lab", "default": "synthetic-model", "base_url": lab},
        "providers": {"lab": {"base_url": lab},
                      "keyed": {"base_url": keyed, "key_cmd": f"touch {minted} && echo sk-synthetic-minted"}},
        "credential_pool_strategies": {"lab": "round_robin"}}))
    rows = [{"id": f"k{i}", "label": f"row{i}", "auth_type": "api_key", "priority": i, "source": "manual",
             "access_token": f"sk-synthetic-pool-{i}", "base_url": lab} for i in (1, 2)]
    (root / "auth.json").write_text(json.dumps({"version": 1, "providers": {}, "credential_pool": {"lab": rows}}))
    run = subprocess.run([AGENT_PYTHON, "-c", GUARD_PROBE, str(AGENT_DIR), lab, keyed],
                         env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    assert out["pool_unchanged"]
    assert not minted.exists()
    assert out["delivered"] == []
    matched = "sk-synthetic-pool-1" if out["selector"] else ""
    assert out["sent"] == [["lab", lab, matched]] * 3 + [["keyed", keyed, ""]] * 2 + [["lab", "https://elsewhere.invalid/v1", ""]]
    assert out["replied"] == [row[:2] for row in out["sent"]]
