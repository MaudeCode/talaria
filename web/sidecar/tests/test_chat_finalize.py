"""Session boundaries invoke the real Agent lifecycle in disposable profile homes."""
from __future__ import annotations

import json
import time

import pytest

from conftest import requires_agent


@requires_agent
def test_finalize_runs_profile_plugin_without_starting_a_turn(handshaken, hermes_home):
    profile = hermes_home / 'profiles' / 'closing'
    plugin = profile / 'plugins' / 'closing-test'
    plugin.mkdir(parents=True)
    (plugin / 'plugin.yaml').write_text('name: closing-test\nversion: 0.0.1\n')
    (plugin / '__init__.py').write_text(f'''import json, time
from hermes_constants import get_hermes_home

def register(ctx):
    def closing(**kwargs):
        home = get_hermes_home()
        (home / 'finalized.json').write_text(json.dumps({{key: kwargs[key] for key in ('session_id', 'platform', 'reason')}}))
        return {{'message': 'bye'}}
    ctx.register_hook('on_session_finalize', closing)
''')
    (profile / 'config.yaml').write_text('plugins:\n  isolation: in_process\n  enabled: [closing-test]\n')
    started = time.monotonic()
    reply, _ = handshaken.call('chat.finalize_session', {
        'profile_home': str(profile), 'session_id': 'closing-chat', 'reason': 'clear',
    }, timeout=30)
    assert reply.get('result') == {'messages': ['bye']}, reply
    assert time.monotonic() - started < 11.5
    assert json.loads((profile / 'finalized.json').read_text()) == {
        'session_id': 'closing-chat', 'platform': 'webui', 'reason': 'clear',
    }
    assert not (hermes_home / 'finalized.json').exists()


def test_finalize_timeout_keeps_profile_custody_until_the_hook_exits(monkeypatch, tmp_path):
    import contextlib
    import sys
    import threading
    import types
    from talaria_sidecar.methods import Registry, chat

    entered, release = threading.Event(), threading.Event()
    scopes = []

    @contextlib.contextmanager
    def scope(home):
        scopes.append(('enter', home))
        try:
            yield home
        finally:
            scopes.append(('exit', home))

    def finalize(**kwargs):
        assert kwargs == dict(session_id='closing-chat', platform='webui', reason='clear')
        entered.set()
        assert release.wait(5), 'test did not release its hook'
        return ['late message']

    monkeypatch.setitem(sys.modules, 'hermes_cli', types.SimpleNamespace(lifecycle=types.SimpleNamespace(
        finalize_session=finalize, session_end_messages=lambda results: results)))
    monkeypatch.setattr(chat, 'scoped_home', scope)
    monkeypatch.setattr(chat, '_SESSION_FINALIZE_TIMEOUT', .01)
    registry = Registry(runtime=None)
    chat.register(registry)
    worker = None
    try:
        result = registry.methods['chat.finalize_session'](None, {
            'session_id': 'closing-chat', 'profile_home': str(tmp_path), 'reason': 'clear',
        })
        assert entered.wait(1)
        assert result == {'messages': []}
        worker = next(worker for worker, home in chat._RELEASES.items() if home == tmp_path)
        assert worker.is_alive()
        assert scopes == [('enter', tmp_path)]
    finally:
        release.set()
        for pending, home in list(chat._RELEASES.items()):
            if home == tmp_path:
                pending.join(5)
        if worker is not None: worker.join(5)
    assert worker is not None
    assert not worker.is_alive()
    assert worker not in chat._RELEASES
    assert scopes == [('enter', tmp_path), ('exit', tmp_path)]


@pytest.mark.parametrize('surface', ['missing_finalize', 'missing_messages', 'failure'])
def test_finalize_tolerates_missing_helpers_and_dispatch_errors(monkeypatch, tmp_path, surface):
    import contextlib
    import sys
    import types
    from talaria_sidecar.methods import Registry, chat

    called = []

    def finalize(**kwargs):
        called.append(kwargs)
        if surface == 'failure':
            raise RuntimeError('synthetic lifecycle failure')
        return ['bye']

    lifecycle = types.SimpleNamespace()
    if surface != 'missing_finalize':
        lifecycle.finalize_session = finalize
    if surface != 'missing_messages':
        lifecycle.session_end_messages = lambda results: results
    monkeypatch.setitem(sys.modules, 'hermes_cli', types.SimpleNamespace(lifecycle=lifecycle))
    monkeypatch.setattr(chat, 'scoped_home', lambda home: contextlib.nullcontext(home))
    registry = Registry(runtime=None)
    chat.register(registry)
    result = registry.methods['chat.finalize_session'](None, {
        'session_id': 'old-agent', 'profile_home': str(tmp_path), 'reason': 'delete',
    })
    assert result == {'messages': []}
    assert len(called) == (0 if surface == 'missing_finalize' else 1)
