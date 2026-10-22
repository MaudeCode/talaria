"""Context reads use a resident Agent only and share the native metadata projection."""
from contextlib import nullcontext
import json
from pathlib import Path
import sys
from types import SimpleNamespace

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
