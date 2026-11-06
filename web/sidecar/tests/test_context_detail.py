"""Context reads use a resident Agent or the session's stored prompt and tools, and share the native metadata projection."""
from contextlib import nullcontext
import json
from pathlib import Path
import subprocess
import sys
import textwrap
from types import SimpleNamespace

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, assert_matches, isolated_env, requires_agent
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
    monkeypatch.setattr(chat, '_agent_class', lambda: (_ for _ in ()).throw(AssertionError('must not build')))
    monkeypatch.setattr(chat, '_AGENT_CACHE', {'resident': (agent, 'signature', tmp_path)})
    registry = Registry(None)
    chat.register(registry)
    read = registry.methods.get('chat.context_detail', lambda *a: {})
    params = {'profile_home': str(tmp_path), 'session_id': 'resident', 'model': 'fixture-model', 'model_provider': 'fixture', 'workspace': str(tmp_path)}
    result = read(None, params)
    assert result.get('available') is True, result
    assert result['files'][0]['label'] == 'AGENTS.md'
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
    assert detail['used_tokens'] is None and detail['window_tokens'] is None
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
    script = textwrap.dedent(f"""
        from pathlib import Path
        from hermes_state import SessionDB
        db = SessionDB(db_path=Path({str(home / 'state.db')!r}))
        tool = {{'type': 'function', 'function': {{'name': 'synthetic_tool', 'description': 'synthetic tool', 'parameters': {{}}}}}}
        db.create_session(session_id='stored', source='webui')
        db.update_system_prompt('stored', 'Synthetic stored prompt. ' * 40)
        db.update_session_tool_names('stored', [tool])
        db.append_message('stored', 'user', 'Synthetic question. ' * 40)
        db.create_session(session_id='no-prompt', source='webui')
        db.append_message('no-prompt', 'user', 'Synthetic question.')
        db.create_session(session_id='rotated', source='webui')
        db.end_session('rotated', 'compression')
        db.create_session(session_id='rotated-tip', source='webui', parent_session_id='rotated')
        db.update_system_prompt('rotated-tip', 'Synthetic tip prompt. ' * 40)
        db.close()
    """)
    subprocess.run([AGENT_PYTHON, '-c', script], env=isolated_env(home, PYTHONPATH=str(AGENT_DIR)), check=True, timeout=60)


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


def test_an_agent_without_the_stored_helpers_keeps_not_built(tmp_path, monkeypatch):
    def must_not_open(*a, **k):
        raise AssertionError('must not open the store')
    monkeypatch.setitem(sys.modules, 'agent.context_breakdown', SimpleNamespace())
    monkeypatch.setitem(sys.modules, 'tools.mcp_tool_agent', SimpleNamespace(pinned_tool_defs=lambda pin: []))
    assert _stored_read(tmp_path, monkeypatch, session_db=must_not_open)['reason'] == 'not_built'
    monkeypatch.setitem(sys.modules, 'agent.context_breakdown', SimpleNamespace(stored_context_breakdown=lambda *a: {}))
    monkeypatch.setitem(sys.modules, 'tools.mcp_tool_agent', SimpleNamespace())
    assert _stored_read(tmp_path, monkeypatch, session_db=must_not_open)['reason'] == 'not_built'


def test_a_failed_stored_read_exposes_no_diagnostics(tmp_path, monkeypatch):
    def broken(*a, **k):
        raise RuntimeError('/private/synthetic-secret')
    monkeypatch.setitem(sys.modules, 'agent.context_breakdown', SimpleNamespace(stored_context_breakdown=lambda *a: {}))
    monkeypatch.setitem(sys.modules, 'tools.mcp_tool_agent', SimpleNamespace(pinned_tool_defs=lambda pin: []))
    result = _stored_read(tmp_path, monkeypatch, session_db=broken)
    assert result['reason'] == 'unavailable' and 'private' not in str(result)
