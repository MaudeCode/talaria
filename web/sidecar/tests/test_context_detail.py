"""Context reads use a resident Agent or the session's stored prompt and tools, and share the native metadata projection."""
from contextlib import nullcontext
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace

from conftest import SidecarProcess, assert_matches, requires_agent, run_store_script
from talaria_sidecar.methods import Registry, chat


def test_resident_context_read_uses_existing_agent_without_provider_or_build(tmp_path, monkeypatch):
    monkeypatch.setattr(chat, 'scoped_home', lambda *a: nullcontext())
    monkeypatch.setattr(chat, 'session_workspace', lambda *a: nullcontext())
    raw = json.loads((Path(__file__).parent / 'fixtures/context-breakdown.json').read_text())
    agent = SimpleNamespace(model='fixture-model', provider='fixture', _session_messages=[{'role': 'user', 'content': 'synthetic'}])
    calls = []
    def compute(selected, messages):
        assert selected is agent and messages == agent._session_messages
        calls.append('compute')
        return dict(raw)
    monkeypatch.setitem(sys.modules, 'agent.context_breakdown', SimpleNamespace(compute_session_context_breakdown=compute))
    monkeypatch.setitem(sys.modules, 'agent.context_file_sources', SimpleNamespace(context_file_sources_for_agent=lambda a: raw['context_files']))
    monkeypatch.setitem(sys.modules, 'agent.context_pin', SimpleNamespace(agent_context_marker=lambda a: 'fallback'))
    monkeypatch.setattr(chat, '_agent_class', lambda: (_ for _ in ()).throw(AssertionError('must not build')))
    monkeypatch.setattr(chat, '_AGENT_CACHE', {'resident': (agent, 'signature', tmp_path)})
    registry = Registry(None)
    chat.register(registry)
    read = registry.methods.get('chat.context_detail', lambda *a: {})
    params = {'profile_home': str(tmp_path), 'session_id': 'resident', 'model': 'fixture-model', 'model_provider': 'fixture', 'workspace': str(tmp_path)}
    result = read(None, params)
    assert result.get('available') is True, result
    assert result['files'][0]['label'] == 'AGENTS.md'
    assert result['window_source'] == 'fallback'
    assert calls == ['compute']
    for overrides in ({'profile_home': str(tmp_path / 'foreign')}, {'session_id': 'foreign'}, {'model': 'other'}, {'model_provider': 'other'}):
        assert read(None, {**params, **overrides})['available'] is False
    assert calls == ['compute']
    chat._AGENT_CACHE.clear()
    assert read(None, params)['reason'] == 'not_built'
    assert chat._COMMITTING == []


def test_context_projection_bounds_unknowns_and_never_normalizes_estimates():
    from talaria_sidecar.context_detail import project
    raw = json.loads((Path(__file__).parent / 'fixtures/context-breakdown.json').read_text())
    raw.update(context_source='unexpected /private', context_estimated=False, context_used=None, context_max=0)
    raw['categories'] = [{'id': [], 'tokens': 3}, {'id': 'unknown', 'tokens': 3}, {'id': 'rules', 'tokens': float('nan')}, {'id': 'conversation', 'tokens': 0}, *raw['categories'] * 30]
    raw['context_files'] = [{'path': '/private/secret-name', 'label': ['unsafe'], 'chars': -4, 'est_tokens': True, 'status': {}}] * 70
    detail = project(raw)
    assert detail['available'] and detail['source'] is None and detail['estimated'] is None
    assert detail['used_tokens'] is None and detail['window_tokens'] is None and detail['window_source'] is None
    assert detail['categories'][0] == {'id': 'conversation', 'tokens': 0, 'percent': None, 'estimated': True}
    assert len(detail['categories']) == 3 and len(detail['files']) == 64 and detail['truncated']
    assert detail['files'][0] == {'label': 'Context file', 'characters': None, 'tokens': None, 'status': 'unknown', 'loaded': None}
    assert 'private' not in str(detail)
    assert project({})['reason'] == 'not_built'
    assert project({'categories': []})['reason'] == 'not_built'
    assert project(None)['reason'] == 'unsupported'


def test_resident_context_read_drops_an_evicted_agent_and_releases_its_pin(tmp_path, monkeypatch):
    from contextlib import nullcontext
    monkeypatch.setattr(chat, 'scoped_home', lambda *a: nullcontext())
    monkeypatch.setattr(chat, 'session_workspace', lambda *a: nullcontext())
    agent = SimpleNamespace(model='fixture-model', provider='fixture', _session_messages=[])
    monkeypatch.setattr(chat, '_AGENT_CACHE', {'resident': (agent, 'signature', tmp_path)})
    released = []
    monkeypatch.setattr(chat, '_release_if_dropped_locked', lambda a, home: released.append(a))
    def compute(*args):
        assert (agent, tmp_path) in chat._COMMITTING
        chat._AGENT_CACHE.clear()
        return {'categories': [{'id': 'conversation', 'tokens': 0}]}
    monkeypatch.setitem(sys.modules, 'agent.context_breakdown', SimpleNamespace(compute_session_context_breakdown=compute))
    monkeypatch.setitem(sys.modules, 'agent.context_file_sources', SimpleNamespace(context_file_sources_for_agent=lambda a: []))
    registry = Registry(None)
    chat.register(registry)
    result = registry.methods['chat.context_detail'](None, {'profile_home': str(tmp_path), 'session_id': 'resident', 'model': 'fixture-model', 'model_provider': 'fixture'})
    assert result['reason'] == 'changed' and result['categories'] == []
    assert chat._COMMITTING == [] and released == [agent]


def test_resident_context_read_drops_compression_during_measurement(tmp_path, monkeypatch):
    monkeypatch.setattr(chat, 'scoped_home', lambda *a: nullcontext())
    monkeypatch.setattr(chat, 'session_workspace', lambda *a: nullcontext())
    comp = SimpleNamespace(compression_count=0, last_prompt_tokens=9000)
    agent = SimpleNamespace(model='fixture-model', provider='fixture', _session_messages=[], context_compressor=comp)
    monkeypatch.setattr(chat, '_AGENT_CACHE', {'resident': (agent, 'signature', tmp_path)})
    def compute(*args):
        comp.compression_count += 1
        return {'categories': [{'id': 'conversation', 'tokens': 0}]}
    monkeypatch.setitem(sys.modules, 'agent.context_breakdown', SimpleNamespace(compute_session_context_breakdown=compute))
    monkeypatch.setitem(sys.modules, 'agent.context_file_sources', SimpleNamespace(context_file_sources_for_agent=lambda a: []))
    registry = Registry(None)
    chat.register(registry)
    result = registry.methods['chat.context_detail'](None, {'profile_home': str(tmp_path), 'session_id': 'resident', 'model': 'fixture-model', 'model_provider': 'fixture'})
    assert result['reason'] == 'changed' and result['categories'] == []
    assert chat._COMMITTING == []


def _seed_stored_sessions(home) -> None:
    run_store_script(home, """
        tool = {'type': 'function', 'function': {'name': 'synthetic_tool', 'description': 'synthetic tool', 'parameters': {}}}
        prompt = (store.sessions if store else db).update_system_prompt
        db.create_session(session_id='stored', source='webui')
        prompt('stored', 'Synthetic stored prompt. ' * 40)
        store.sessions.update_tool_pin('stored', [tool]) if store else db.update_session_tool_names('stored', [tool])
        db.append_message('stored', 'user', 'Synthetic question. ' * 40)
        db.create_session(session_id='no-prompt', source='webui')
        db.append_message('no-prompt', 'user', 'Synthetic question.')
        db.create_session(session_id='rotated', source='webui')
        db.end_session('rotated', 'compression')
        db.create_session(session_id='rotated-tip', source='webui', parent_session_id='rotated')
        prompt('rotated-tip', 'Synthetic tip prompt. ' * 40)
    """)


@requires_agent
def test_a_chat_with_no_resident_agent_measures_its_stored_prompt_and_tools(hermes_home):
    proc = SidecarProcess(hermes_home)
    def read(session_id):
        result = proc.result('chat.context_detail', {'profile_home': str(hermes_home), 'session_id': session_id, 'model': None, 'model_provider': None, 'workspace': None})
        assert_matches('chat.context_detail', result)
        return result
    try:
        assert read('stored')['reason'] == 'not_built'
        assert not (hermes_home / 'state.db').exists(), 'a read must not create the store'
        _seed_stored_sessions(hermes_home)
        detail = read('stored')
        assert detail['available'] is True and detail['reason'] is None, detail
        assert detail['source'] is None and detail['used_tokens'] is None and detail['window_tokens'] is None
        tokens = {row['id']: row['tokens'] for row in detail['categories']}
        assert tokens['system_prompt'] > 0 and tokens['tool_definitions'] > 0 and tokens['conversation'] > 0
        assert detail['estimated_total'] == sum(tokens.values())
        assert 'Synthetic' not in str(detail)
        # A session the Agent rotated by compression is measured at its live tip.
        assert read('rotated')['available'] is True
        for nothing_stored in ('no-prompt', 'never-seen'):
            assert read(nothing_stored)['reason'] == 'not_built'
    finally:
        proc.close()


def _stored_read(tmp_path, monkeypatch, *, session_db):
    (tmp_path / 'state.db').touch()
    monkeypatch.setattr(chat, 'scoped_home', lambda *a: nullcontext())
    monkeypatch.setattr(chat, '_AGENT_CACHE', {})
    monkeypatch.setitem(sys.modules, 'hermes_state', SimpleNamespace(SessionDB=session_db))
    registry = Registry(None)
    chat.register(registry)
    return registry.methods['chat.context_detail'](None, {'profile_home': str(tmp_path), 'session_id': 'stored', 'model': None, 'model_provider': None, 'workspace': None})


def test_a_failed_stored_read_exposes_no_diagnostics(tmp_path, monkeypatch):
    def broken(*a, **k):
        raise RuntimeError('/private/synthetic-secret')
    monkeypatch.setitem(sys.modules, 'agent.context_breakdown', SimpleNamespace(stored_context_breakdown=lambda *a: {}))
    monkeypatch.setitem(sys.modules, 'tools.mcp_tool_agent', SimpleNamespace(pinned_tool_defs=lambda pin: []))
    result = _stored_read(tmp_path, monkeypatch, session_db=broken)
    assert result['reason'] == 'unavailable' and 'private' not in str(result)


def test_stored_reads_past_the_limit_are_refused_without_holding_a_call_slot(tmp_path, monkeypatch):
    opened, entered, release = [], threading.Semaphore(0), threading.Event()
    def blocked(*a, **k):
        opened.append(1)
        entered.release()
        release.wait(10)
        raise RuntimeError('synthetic read end')
    monkeypatch.setitem(sys.modules, 'agent.context_breakdown', SimpleNamespace(stored_context_breakdown=lambda *a: {}))
    monkeypatch.setitem(sys.modules, 'tools.mcp_tool_agent', SimpleNamespace(pinned_tool_defs=lambda pin: []))
    workers = [threading.Thread(target=_stored_read, args=(tmp_path, monkeypatch), kwargs={'session_db': blocked}) for _ in range(4)]
    release_after_refusal = threading.Timer(2, release.set)
    try:
        for worker in workers:
            worker.start()
        for _ in workers:
            assert entered.acquire(timeout=10)
        release_after_refusal.start()
        refused = _stored_read(tmp_path, monkeypatch, session_db=blocked)
        assert refused['reason'] == 'unavailable'
        assert len(opened) == 4, 'a refused read must not open the store'
    finally:
        release_after_refusal.cancel()
        release.set()
        for worker in workers:
            worker.join(10)
    # Finished reads give their permits back.
    assert _stored_read(tmp_path, monkeypatch, session_db=blocked)['reason'] == 'unavailable' and len(opened) == 5


# TAL-2647: every window below is folded by the Agent's own clock from a synthetic response at a frozen send time, and the
# sidecar's projection runs on the Agent's interpreter at a frozen read time, so each state comes from the native rules.
_CACHE_WINDOWS = r"""
import json, sqlite3, sys
from dataclasses import asdict, replace
from types import SimpleNamespace
try:
    import agent.prompt_cache_clock as clock
except ImportError:  # an Agent before v0.23.2 has no window
    clock = None
from talaria_sidecar.context_detail import project

def agent(provider, base_url, model, api_mode='chat_completions'):
    return SimpleNamespace(provider=provider, base_url=base_url, model=model, api_mode=api_mode, session_id='s1', _cache_ttl='1h',
                           _use_prompt_caching=True, _session_db=None, context_compressor=SimpleNamespace(compression_count=0))

def turn(a, request, usage, sent_at):
    from agent.usage_pricing import normalize_usage
    clock.time.time = lambda: sent_at
    clock.record_attempt_sent(a, request)
    clock.record_cache_response(a, normalize_usage(usage, provider=a.provider, api_mode=a.api_mode), model=a.model, provider=a.provider,
                                base_url=a.base_url, api_mode=a.api_mode)
    return a

def marked(ttl):
    marker = {'type': 'ephemeral', 'ttl': '1h'} if ttl == '1h' else {'type': 'ephemeral'}
    return {'messages': [{'role': 'system', 'content': [{'type': 'text', 'text': 'sys', 'cache_control': marker}]}, {'role': 'user', 'content': 'hi'}]}

def write(t5=0, t1h=0):
    return {'input_tokens': 5, 'output_tokens': 1, 'cache_creation_input_tokens': t5 + t1h,
            'cache_creation': {'ephemeral_5m_input_tokens': t5, 'ephemeral_1h_input_tokens': t1h}}

def read(window, now):
    clock.time.time = lambda: now  # the Agent's helpers read the shared time module
    return project({'categories': [{'id': 'conversation', 'tokens': 1}], 'prompt_cache': window}).get('prompt_cache')

out = {'older': project({'categories': [{'id': 'conversation', 'tokens': 1}]}).get('prompt_cache'), 'native': clock is not None}
if clock is not None:
    anthropic = lambda: agent('anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-6', 'anthropic_messages')
    window = lambda a: asdict(clock.cache_window(a))
    proven = window(turn(anthropic(), marked('1h'), write(t1h=4096), 1000.0))
    out['proven'] = [read(proven, now) for now in (1000.0, 4600.0)]
    declared = turn(anthropic(), marked('5m'), {'input_tokens': 5, 'output_tokens': 1, 'cache_creation_input_tokens': 4096}, 1000.0)
    out['declared'] = read(window(declared), 1100.0)
    # A session saved before the clock existed: restored from its newest assistant row with no response evidence.
    restored = anthropic()
    restored._session_db = SimpleNamespace(get_prompt_cache_clock=lambda sid: {'clock': None, 'last_assistant_at': 1000.0, 'generation': 0},
                                           prompt_cache_generation=lambda sid: 0)
    out['assumed'] = [read(window(restored), now) for now in (1000.0, 4601.0)]
    out['mixed'] = read(window(turn(anthropic(), marked('1h'), write(t5=2000, t1h=4000), 1000.0)), 1400.0)
    unobserved = anthropic()
    clock.time.time = lambda: 1000.0
    clock.record_unobserved_cache_response(unobserved, SimpleNamespace(cache_read_tokens=4096, cache_write_tokens=0), reason='codex_app_server')
    out['unobserved'] = read(window(unobserved), 1000.0)
    moved = turn(anthropic(), marked('1h'), write(t1h=4096), 1000.0)
    moved.model = 'claude-opus-4-6'
    out['route_changed'] = read(window(moved), 1000.0)
    compressed = turn(anthropic(), marked('1h'), write(t1h=4096), 1000.0)
    compressed.context_compressor.compression_count = 1
    out['compacted'] = read(window(compressed), 1000.0)
    class Broken:
        def prompt_cache_generation(self, session_id):
            raise sqlite3.OperationalError('synthetic storage failure')
    saved = clock.event_to_json(replace(turn(anthropic(), marked('1h'), write(t1h=4096), 1000.0)._prompt_cache_clock, generation=0))
    out['storage'] = read(clock.stored_cache_window(saved, session_id='s1', generation=clock.current_generation(Broken(), 's1')), 1000.0)
    out['invalid'] = [read(raw, 1000.0) for raw in ('warm', {'confidence': 'proven', 'estimated_until': 'later'},
                      {'confidence': 'proven', 'guaranteed_until': float('inf'), 'estimated_until': 4600.0}, {'confidence': 'certain', 'estimated_until': 4600.0}, {'confidence': ['proven'], 'estimated_until': 4600.0})]
    out['missing'] = read({'confidence': 'declared'}, 1000.0)
    out['odd_reason'] = read({'confidence': 'unknown', 'reason': ['compacted']}, 1000.0)
    out['odd_tier'] = read({**proven, 'tier': ['1h'], 'coverage': {'1h': 4600.0, '7d': 9e9, '5m': 'soon'}}, 1000.0)
    # A known window with only a guarantee (a local endpoint on Agent v0.23.3+): warm before it, unknown after.
    out['guarantee_only'] = [read({'confidence': 'declared', 'guaranteed_until': 2800.0, 'tier': '30m'}, now) for now in (1000.0, 2800.0)]
    out['saved'] = saved
print(json.dumps(out))
"""


def _native_cache_windows(hermes_home) -> dict:
    import subprocess
    from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env
    done = subprocess.run([AGENT_PYTHON, '-c', _CACHE_WINDOWS], env=isolated_env(hermes_home, PYTHONPATH=f'{SIDECAR_ROOT}:{AGENT_DIR}'),
                          check=True, timeout=60, capture_output=True, text=True)
    return json.loads(done.stdout.strip().splitlines()[-1])


@requires_agent
def test_context_detail_projects_the_agents_prompt_cache_window(hermes_home):
    windows = _native_cache_windows(hermes_home)
    assert windows['older'] is None, 'no window from the Agent is absence, never a guess'
    if not windows['native']:
        return  # an Agent before v0.23.2: absence above is the whole contract
    warm, cold = windows['proven']
    assert warm == {'state': 'warm', 'confidence': 'proven', 'reason': None, 'tier': '1h', 'guaranteed_until': 4600.0, 'estimated_until': 4600.0,
                    'remaining_seconds': 3600.0, 'coverage': [{'tier': '1h', 'until': 4600.0}]}
    assert cold['state'] == 'expired', 'Anthropic tiers are exact: the guaranteed end is also the last moment'
    assert windows['declared'] | {'coverage': None} == {'state': 'warm', 'confidence': 'declared', 'reason': None, 'tier': '5m', 'guaranteed_until': 1300.0,
                                                          'estimated_until': 1300.0, 'remaining_seconds': 200.0, 'coverage': None}
    maybe, gone = windows['assumed']
    assert (maybe['state'], maybe['confidence'], maybe['guaranteed_until'], maybe['estimated_until'], maybe['remaining_seconds'], maybe['coverage']) == ('maybe_warm', 'assumed', None, 4600.0, None, [])
    assert gone['state'] == 'expired'
    only, past = windows['guarantee_only']
    assert (only['state'], only['guaranteed_until'], only['estimated_until'], only['remaining_seconds']) == ('warm', 2800.0, None, 1800.0) and past['reason'] == 'no_published_window'
    mixed = windows['mixed']
    assert (mixed['state'], mixed['tier'], mixed['guaranteed_until'], mixed['estimated_until']) == ('maybe_warm', '5m', 1300.0, 4600.0)
    assert mixed['coverage'] == [{'tier': '5m', 'until': 1300.0}, {'tier': '1h', 'until': 4600.0}]
    unknown = {'state': 'unknown', 'confidence': 'unknown', 'tier': None, 'guaranteed_until': None, 'estimated_until': None, 'remaining_seconds': None, 'coverage': []}
    for case, reason in (('unobserved', 'no_published_window'), ('route_changed', 'route_changed'), ('compacted', 'compacted'), ('storage', 'storage_unavailable'),
                         ('missing', 'no_published_window')):
        assert windows[case] == {**unknown, 'reason': reason}, case
    assert windows['invalid'] == [{**unknown, 'reason': 'invalid'}] * 5
    assert windows['odd_reason'] == {**unknown, 'reason': 'no_published_window'}
    assert windows['odd_tier'] == {**warm, 'tier': None}
    assert 's1' not in json.dumps({k: v for k, v in windows.items() if k != 'saved'})

    # A chat with no resident Agent reads its saved clock, checked by the Agent against the stored generation and session.
    _seed_stored_sessions(hermes_home)
    event = json.loads(windows['saved'])
    def seed(row_id, **changes):
        import sqlite3
        with sqlite3.connect(hermes_home / 'state.db') as conn:
            conn.execute('UPDATE sessions SET prompt_cache_clock = ? WHERE id = ?', (json.dumps({**event, 'session_id': row_id, **changes}), row_id))
    proc = SidecarProcess(hermes_home)
    def window():
        result = proc.result('chat.context_detail', {'profile_home': str(hermes_home), 'session_id': 'stored', 'model': None, 'model_provider': None, 'workspace': None})
        assert_matches('chat.context_detail', result)
        return result['prompt_cache']
    try:
        assert window() is None, 'a session that never touched a cache has no window'
        seed('stored')
        # The synthetic send time is long past, so the Agent's own rule classifies it at the real read time.
        assert {k: window()[k] for k in ('state', 'confidence', 'tier')} == {'state': 'expired', 'confidence': 'proven', 'tier': '1h'}
        seed('stored', generation=7)
        assert (window()['state'], window()['reason']) == ('unknown', 'compacted')
        seed('stored', session_id='another')
        assert (window()['state'], window()['reason']) == ('unknown', 'session_rotated')
    finally:
        proc.close()
