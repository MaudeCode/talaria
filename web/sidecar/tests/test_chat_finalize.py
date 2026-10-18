"""Session boundaries invoke the real Agent lifecycle in disposable profile homes."""
from __future__ import annotations

import json
import time

import pytest

from conftest import requires_agent


@requires_agent
@pytest.mark.parametrize('mode', ['message', 'raises', 'slow'])
def test_finalize_runs_profile_plugin_without_starting_a_turn(handshaken, hermes_home, mode):
    profile = hermes_home / 'profiles' / 'closing'
    plugin = profile / 'plugins' / 'closing-test'
    plugin.mkdir(parents=True)
    (plugin / 'plugin.yaml').write_text('name: closing-test\nversion: 0.0.1\n')
    action = {
        'message': "return {'message': 'bye'}",
        'raises': "raise RuntimeError('synthetic plugin failure')",
        'slow': "time.sleep(12); return {'message': 'too late'}",
    }[mode]
    (plugin / '__init__.py').write_text(f'''import json, time
from hermes_constants import get_hermes_home

def register(ctx):
    def closing(**kwargs):
        home = get_hermes_home()
        (home / 'finalized.json').write_text(json.dumps({{key: kwargs[key] for key in ('session_id', 'platform', 'reason')}}))
        {action}
    ctx.register_hook('on_session_finalize', closing)
''')
    (profile / 'config.yaml').write_text('plugins:\n  isolation: in_process\n  enabled: [closing-test]\n')
    started = time.monotonic()
    reply, _ = handshaken.call('chat.finalize_session', {
        'profile_home': str(profile), 'session_id': 'closing-chat', 'reason': 'clear',
    }, timeout=30)
    assert reply.get('result') == {'messages': ['bye'] if mode == 'message' else []}, reply
    assert time.monotonic() - started < 11.5
    assert json.loads((profile / 'finalized.json').read_text()) == {
        'session_id': 'closing-chat', 'platform': 'webui', 'reason': 'clear',
    }
    assert not (hermes_home / 'finalized.json').exists()
    if mode == 'slow':
        time.sleep(2.5)  # Let the abandoned hook finish before its disposable home is removed.


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
