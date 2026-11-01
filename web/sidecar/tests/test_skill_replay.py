"""Bounded saved-check replay: fixed fixtures, exact revisions, one capped call, no tool effects or judge (TAL-1563)."""
from contextlib import contextmanager
import hashlib
import json
from types import SimpleNamespace as NS
import sys
import importlib
import urllib.error

import pytest

from talaria_sidecar.errors import InvalidParams, RpcError
from talaria_sidecar.methods import build_methods, chat, cron, skill_revisions as history, skills

RECORDED = [
    dict(id=1, role='user', content='Summarize the report'),
    dict(id=2, role='assistant', content='', tool_calls=json.dumps([{'id': 'c1', 'function': {'name': 'read_file', 'arguments': '{"path": "r.md"}'}}])),
    dict(id=3, role='tool', tool_call_id='c1', content='recorded file body'),
    dict(id=4, role='assistant', content='Here is the summary.'),
    dict(id=5, role='user', content='Now email it'),
    dict(id=6, role='assistant', content='', tool_calls=json.dumps([{'id': 'c2', 'function': {'name': 'send_email', 'arguments': '{}'}}])),
]


class FakeDB:
    sessions = {'s1': RECORDED}

    def __init__(self, path, read_only=False):
        assert read_only is True
        self.closed = False

    def get_messages(self, sid):
        return [dict(m) for m in self.sessions.get(sid, [])]

    def get_session(self, sid):
        return {'system_prompt': 'You are a helpful agent.'} if sid in self.sessions else None

    def close(self):
        self.closed = True


@pytest.fixture
def store(tmp_path, monkeypatch):
    replay = importlib.import_module('talaria_sidecar.methods.skill_replay')
    home = tmp_path / 'profile'
    path = home / 'skills/demo/SKILL.md'
    path.parent.mkdir(parents=True)
    texts = ['Original instructions.\n', 'Revised instructions.\n']
    path.write_text(texts[1])
    directory = home / 'hermetic/skill-versions/demo'
    directory.mkdir(parents=True)
    for text in texts:
        sha = hashlib.sha256(text.encode()).hexdigest()
        (directory / f'{sha[:16]}-SKILL.md').write_text(text)
    (home / 'state.db').write_bytes(b'synthetic')
    cases = [dict(id='c-plan', ts=1, message_id='5', session_id='s1', title='Email the summary', skill='demo', mode='plan',
                  expect_tools=['send_email'], never_tools=['delete_file']),
             dict(id='c-other', ts=2, message_id='5', session_id='s1', title='Other skill', skill='other', mode='plan')]
    (home / 'hermetic/cases.jsonl').write_text('\n'.join(json.dumps(c) for c in cases) + '\n')
    entries = [dict(load_name='demo', name='demo', path=path)]
    monkeypatch.setattr(skills, '_skill_helper', lambda _: lambda **kwargs: entries)
    consent = {str(home): True}
    monkeypatch.setattr(history.dashboard_plugins, 'reviewed_producer', lambda selected, *args: history._PIN if consent.get(str(selected)) else None)
    monkeypatch.setitem(sys.modules, 'hermes_state', NS(SessionDB=FakeDB))
    route = {'pin': ('openrouter', 'vendor/model-a'), 'base_url': 'https://openrouter.ai/api/v1', 'api_key': 'synthetic-key'}
    monkeypatch.setattr(cron, '_main_model_pin', lambda: route['pin'])
    monkeypatch.setattr(chat, '_resolve_runtime', lambda provider, model: {'provider': provider, 'base_url': route['base_url'], 'api_key': route['api_key']})
    posts = []
    answers = [{'provider': 'Vendor', 'choices': [{'finish_reason': 'tool_calls', 'message': {'content': '', 'tool_calls': [{'function': {'name': 'send_email', 'arguments': '{"to": "x"}'}}]}}],
                'usage': {'prompt_tokens': 900, 'completion_tokens': 40, 'cost': 0.0004}}]

    def post(url, key, body):
        posts.append(dict(url=url, key=key, body=body))
        answer = answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer
    monkeypatch.setattr(replay, '_post', post)

    @contextmanager
    def scope(selected, **kwargs):
        assert kwargs == {'load_plugins': False, 'recover_processes': False}
        yield selected
    monkeypatch.setattr(skills, 'scoped_home', scope)
    methods = build_methods(NS(load=lambda: None, ensure_current=lambda: None))
    ctx = NS(check_cancelled=lambda: None)
    revisions = methods['skills.revisions'](ctx, dict(profile_home=str(home), name='demo'))['revisions']
    newer, older = revisions[0]['id'], revisions[1]['id']

    def plan(**kwargs):
        return methods['skills.replay_plan'](ctx, dict(profile_home=str(home), name='demo', baseline=older, candidate=newer) | kwargs)

    def case(planned, revision=None, **kwargs):
        row = next((r for r in planned['revisions'] if r['id'] == (revision or newer)), dict(id=revision, sha256='1' * 64))
        params = dict(profile_home=str(home), name='demo', baseline=older, candidate=newer, revision=row['id'], sha256=row['sha256'],
                      fixture=planned['cases'][0]['id'], route=planned['route'], max_input_tokens=planned['cases'][0]['input_tokens_bound'],
                      max_output_tokens=1500, max_price_per_million=2.5)
        return methods['skills.replay_case'](ctx, params | kwargs)
    return NS(replay=replay, home=home, directory=directory, texts=texts, plan=plan, case=case, posts=posts, answers=answers, route=route,
              newer=newer, older=older, consent=consent, cases=home / 'hermetic/cases.jsonl')


def test_replay_methods_are_registered():
    methods = build_methods(NS(load=lambda: None, ensure_current=lambda: None))
    assert {'skills.replay_plan', 'skills.replay_case'} <= set(methods)


def test_plan_binds_two_exact_revisions_and_recorded_case_fixtures(store):
    b = store
    before = {str(p): p.read_bytes() for p in b.home.rglob('*') if p.is_file()}
    planned = b.plan()
    assert planned['state'] == 'ready' and planned['reason'] is None
    assert [(r['role'], r['id']) for r in planned['revisions']] == [('baseline', b.older), ('candidate', b.newer)]
    assert [c['case_id'] for c in planned['cases']] == ['c-plan']
    assert planned['route'] == {'provider': 'openrouter', 'model': 'vendor/model-a'}
    assert 0 < planned['cases'][0]['input_tokens_bound'] <= b.replay.MAX_INPUT_TOKENS
    assert b.posts == []
    assert {str(p): p.read_bytes() for p in b.home.rglob('*') if p.is_file()} == before


def test_each_revision_replays_identical_recorded_fixture_with_one_capped_call(store):
    b = store
    planned = b.plan()
    newer, older = b.case(planned), b.case(planned, revision=b.older)
    assert len(b.posts) == 2
    first, second = (p['body'] for p in b.posts)
    assert first['messages'][:-1] == second['messages'][:-1]
    assert [first['messages'][-1]['content'], second['messages'][-1]['content']] == b.texts[::-1]
    # Recorded tool results are the only tool output the model sees; the later recorded call is not part of the fixture.
    assert [m.get('content') for m in first['messages'] if m['role'] == 'tool'][0] == 'recorded file body'
    assert not any('send_email' in json.dumps(m.get('tool_calls', [])) for m in first['messages'])
    assert first['max_tokens'] == 1500 and first['stream'] is False
    assert first['provider'] == {'max_price': {'prompt': 2.5, 'completion': 2.5, 'request': 0, 'image': 0}}
    assert b.posts[0]['url'] == 'https://openrouter.ai/api/v1/chat/completions'
    assert newer['outcome'] == 'completed' and newer['passed'] is True
    assert newer['checks'] == {'not_empty': True, 'valid_tools': True, 'expected_tools': True, 'never_tools': True}
    assert newer['tool_calls'] == [{'name': 'send_email', 'arguments': '{"to": "x"}'}]
    assert (newer['input_tokens'], newer['output_tokens'], newer['cost_usd']) == (900, 40, 0.0004)
    assert older['outcome'] == 'completed'


def test_planned_tool_calls_are_scored_never_executed_and_no_judge_runs(store, monkeypatch):
    b = store
    for module in ('model_tools', 'tools.registry', 'agent.plugin_llm'):
        monkeypatch.setitem(sys.modules, module, None)
    b.answers[0] = {'choices': [{'message': {'content': '', 'tool_calls': [{'function': {'name': 'delete_file', 'arguments': '{bad'}}]}}], 'usage': {}}
    result = b.case(b.plan())
    assert result['checks'] == {'not_empty': True, 'valid_tools': False, 'expected_tools': False, 'never_tools': False}
    assert result['passed'] is False and result['cost_usd'] is None
    assert len(b.posts) == 1 and 'judge' not in json.dumps(b.posts[0]['body']).lower()


def test_unsupported_routes_refuse_before_any_call(store):
    b = store
    b.route['pin'] = ('anthropic', 'claude-x')
    planned = b.plan()
    assert planned['state'] == 'unavailable' and planned['reason'] == 'route_unsupported'
    b.route['pin'] = ('openrouter', 'vendor/model-a')
    planned = b.plan()
    for base in ('http://openrouter.ai/api/v1', 'https://openrouter.ai.evil/api/v1', 'https://proxy.local/api/v1'):
        b.route['base_url'] = base
        assert b.plan()['reason'] == 'route_unsupported'
        with pytest.raises(RpcError, match='cannot enforce a replay budget') as refused:
            b.case(planned)
        assert refused.value.data['condition'] == 'replay_refused'
    b.route['base_url'], b.route['api_key'] = 'https://openrouter.ai/api/v1', None
    with pytest.raises(RpcError, match='cannot enforce a replay budget'):
        b.case(planned)
    assert b.posts == []


@pytest.mark.parametrize('drift', ['revision', 'case', 'route', 'bound', 'foreign_revision', 'deleted_case', 'price'])
def test_consented_inputs_cannot_drift_before_dispatch(store, drift):
    b = store
    planned = b.plan()
    kwargs = {}
    if drift == 'revision':
        kwargs['sha256'] = '0' * 64
    elif drift == 'case':
        FakeDB.sessions['s1'] = RECORDED[:4] + [dict(RECORDED[4], content='Changed request')] + RECORDED[5:]
    elif drift == 'route':
        b.route['pin'] = ('openrouter', 'vendor/model-b')
    elif drift == 'bound':
        kwargs['max_input_tokens'] = 10
    elif drift == 'foreign_revision':
        planned = planned | dict(revisions=[])
        kwargs['revision'] = '1' * 64
    elif drift == 'deleted_case':
        with b.cases.open('a') as file:
            file.write(json.dumps({'id': 'c-plan', 'deleted': True}) + '\n')
    else:
        kwargs['max_price_per_million'] = 0
    try:
        with pytest.raises(InvalidParams):
            b.case(planned, **kwargs)
    finally:
        FakeDB.sessions['s1'] = RECORDED
    assert b.posts == []


def test_missing_history_stale_ids_and_foreign_profiles_refuse(store):
    b = store
    with pytest.raises(InvalidParams, match='no longer exists'):
        b.plan(candidate='0' * 64)
    with pytest.raises(InvalidParams, match='two different revisions'):
        b.plan(candidate=b.older)
    assert b.plan(profile_home=str(b.home.with_name('foreign')))['state'] == 'unavailable'
    b.consent[str(b.home)] = False
    assert b.plan()['reason'] == 'backend_unavailable'
    b.consent[str(b.home)] = True
    for file in b.directory.iterdir():
        file.unlink()
    with pytest.raises(InvalidParams, match='no longer exists'):
        b.plan()
    assert b.posts == []


def test_cases_without_recorded_turns_are_counted_not_invented(store):
    b = store
    b.cases.write_text(json.dumps(dict(id='gone', message_id='9', session_id='missing', skill='demo')) + '\n')
    planned = b.plan()
    assert (planned['state'], planned['reason'], planned['unavailable_cases'], planned['cases']) == ('unavailable', 'no_cases', 1, [])
    b.cases.write_text('{broken\n')
    assert b.plan()['reason'] == 'invalid_history'


@pytest.mark.parametrize('failure,outcome', [(urllib.error.HTTPError('u', 402, 'over budget', {}, None), 'error'), (TimeoutError(), 'unknown'),
                                             (ConnectionResetError(), 'unknown'), ({'error': {'message': 'No endpoints under max price'}}, 'error'),
                                             ({'choices': [{'message': {'tool_calls': [{'function': 'not-an-object'}]}}]}, 'error')])
def test_provider_failures_stay_explicit(store, failure, outcome):
    b = store
    b.answers[0] = failure
    result = b.case(b.plan())
    assert result['outcome'] == outcome and result['passed'] is None and result['checks'] == {}
    assert len(b.posts) == 1
