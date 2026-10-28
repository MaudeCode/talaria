"""Command lifetime and identity matrices belong here; native mapping lives in test_plugin_choices."""
import contextlib
import contextvars
import json
import queue
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from talaria_sidecar.methods import Registry, chat, commands
from talaria_sidecar.rpc import CallContext


@pytest.fixture
def bridge(monkeypatch, tmp_path):
    asker = contextvars.ContextVar('synthetic_asker', default=None)

    @contextlib.contextmanager
    def bind(value):
        token = asker.set(value)
        try:
            yield
        finally:
            asker.reset(token)

    monkeypatch.setitem(sys.modules, 'hermes_cli', SimpleNamespace())
    monkeypatch.setitem(sys.modules, 'hermes_cli.plugin_choices', SimpleNamespace(
        bind_asker=bind, clarify_asker=lambda callback: lambda: callback([{'qid': 'q0', 'question': 'Same question?', 'choices': ['one', 'two']}])) )
    monkeypatch.setattr(commands, 'scoped_home', lambda home: contextlib.nullcontext())
    monkeypatch.setattr(chat, '_turn_identity', lambda *a: contextlib.nullcontext())
    monkeypatch.setattr(chat, '_clarify_timeout', lambda params: 5)
    monkeypatch.setattr(chat, '_COMMAND_RUNS', {})
    monkeypatch.setattr(chat, '_RUNS', {})
    monkeypatch.setattr(chat, '_RUNS_BY_SESSION', {})
    monkeypatch.setattr(chat, '_DRAINING', threading.Event())
    monkeypatch.setattr(chat, '_AGENT_CACHE', {})
    monkeypatch.setattr(chat, '_cancel_background_reviews', lambda *a: [])
    monkeypatch.setattr(chat, '_release_vault_session', lambda *a: None)
    monkeypatch.setattr(chat, 'release_all', lambda: None)
    monkeypatch.setattr(chat, 'release_home', lambda *a: None)
    monkeypatch.setattr(commands, 'execute_agent_command', lambda *a: None)
    monkeypatch.setattr(commands, 'execute_plugin_command', lambda *a: json.dumps(asker.get()()) if asker.get() else 'unattended')
    registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    commands.register(registry)
    chat.register(registry)
    frames = queue.Queue()
    server = SimpleNamespace(notify=lambda method, frame: frames.put(frame))
    params = {'command': '/choose', 'session_id': 'session', 'profile_home': str(tmp_path)}
    return registry.methods, server, frames, params, asker


def prompt(frames):
    frame = frames.get(timeout=3)
    assert frame['event'] == 'clarify'
    return {**frame['data'], '_rpc_id': frame['id']}


def test_concurrent_commands_never_steal_answers_or_context(bridge):
    methods, server, frames, params, asker = bridge
    contexts = [CallContext(server, i, 'commands.exec') for i in range(4)]
    identities = [params, params, {**params, 'session_id': 'other'}, {**params, 'profile_home': params['profile_home'] + '/other'}]
    with ThreadPoolExecutor(max_workers=4) as pool:
        calls = [pool.submit(methods['commands.exec'], ctx, identity) for ctx, identity in zip(contexts, identities)]
        try:
            questions = [prompt(frames) for _ in calls]
            assert len({q['clarify_id'] for q in questions}) == 4
            for frame, q in zip(contexts, questions):
                # Resolve by the emitting RPC identity, not arrival order.
                owner = q['_rpc_id']
                identity = identities[owner]
                answer = {**identity, 'clarify_id': q['clarify_id'], 'response': json.dumps({'answers': {'q0': str(owner)}})}
                assert methods['clarify.respond'](frame, {**answer, 'session_id': 'wrong'}) == {'ok': False}
                assert methods['clarify.respond'](frame, {**answer, 'profile_home': '/wrong'}) == {'ok': False}
                assert methods['clarify.respond'](frame, {**answer, 'clarify_id': 'stale'}) == {'ok': False}
                assert methods['clarify.respond'](frame, answer)['ok'] is True
                assert methods['clarify.respond'](frame, answer) == {'ok': False}
            assert [json.loads(call.result(timeout=3)['output'])['answers']['q0'] for call in calls] == ['0', '1', '2', '3']
        finally:
            for ctx in contexts:
                ctx.cancel_event.set()
    assert not chat._COMMAND_RUNS and asker.get() is None
    assert not chat._RUNS and not chat._RUNS_BY_SESSION


@pytest.mark.parametrize('exit', ['request', 'session', 'profile', 'credentials', 'shutdown', 'expiry'])
def test_every_exit_releases_the_waiter_and_refuses_a_late_answer(bridge, monkeypatch, exit):
    methods, server, frames, params, asker = bridge
    clock = [1.0]
    monkeypatch.setattr(chat.time, 'monotonic', lambda: clock[0])
    ctx = CallContext(server, 1, 'commands.exec')
    with ThreadPoolExecutor(max_workers=1) as pool:
        call = pool.submit(methods['commands.exec'], ctx, params)
        q = prompt(frames)
        if exit == 'request':
            ctx.cancel_event.set()
        elif exit == 'session':
            methods['chat.evict_agent'](CallContext(server, 2, 'chat.evict_agent'), {**params, 'clear_session': True})
        elif exit == 'profile':
            with chat.release_profile_agents(params['profile_home']):
                pass
        elif exit == 'credentials':
            chat.evict_all_agents()
        elif exit == 'shutdown':
            chat.drain_agents()
        else:
            clock[0] = 10.0
        assert methods['clarify.respond'](CallContext(server, 3, 'clarify.respond'), {**params, 'clarify_id': q['clarify_id'], 'response': '{"answers":{"q0":"late"}}'}) == {'ok': False}
        if exit == 'request':
            from talaria_sidecar.errors import Cancelled
            with pytest.raises(Cancelled):
                call.result(timeout=3)
        else:
            result = json.loads(call.result(timeout=3)['output'])
            assert result['answers'] == {}
            assert result['outcome'] == ('timed_out' if exit == 'expiry' else 'cancelled')
    assert frames.get(timeout=3)['event'] == 'clarify_resolved'
    assert not chat._COMMAND_RUNS and asker.get() is None


def test_no_session_or_older_agent_keeps_unattended_fallback(bridge, monkeypatch):
    methods, server, frames, params, asker = bridge
    ctx = CallContext(server, 1, 'commands.exec')
    assert methods['commands.exec'](ctx, {**params, 'session_id': ''})['output'] == 'unattended'
    monkeypatch.setitem(sys.modules, 'hermes_cli.plugin_choices', None)
    assert methods['commands.exec'](ctx, params)['output'] == 'unattended'
    assert frames.empty() and not chat._COMMAND_RUNS and asker.get() is None
