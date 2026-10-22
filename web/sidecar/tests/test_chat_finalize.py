"""Session boundaries invoke the real Agent lifecycle in disposable profile homes."""
from __future__ import annotations

import json
import time

import pytest

from conftest import requires_agent


@requires_agent
@pytest.mark.parametrize('mode', ['message', 'raises'])
def test_finalize_runs_profile_plugin_without_starting_a_turn(handshaken, hermes_home, mode):
    profile = hermes_home / 'profiles' / 'closing'
    plugin = profile / 'plugins' / 'closing-test'
    plugin.mkdir(parents=True)
    (plugin / 'plugin.yaml').write_text('name: closing-test\nversion: 0.0.1\n')
    action = "return {'message': 'bye'}" if mode == 'message' else "raise RuntimeError('synthetic plugin failure')"
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


@pytest.mark.parametrize('reason', ['clear', 'archive'])
def test_finalize_timeout_keeps_profile_custody_until_the_hook_exits(monkeypatch, tmp_path, reason):
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
    def notify(home, session_id, lineage):
        assert home == tmp_path and session_id == 'closing-chat' and lineage is None
        entered.set()
        assert release.wait(5), 'test did not release its hook'

    monkeypatch.setattr(chat, '_notify_archive', notify)
    monkeypatch.setattr(chat, 'scoped_home', scope)
    monkeypatch.setattr(chat, '_SESSION_FINALIZE_TIMEOUT', .01)
    registry = Registry(runtime=None)
    chat.register(registry)
    worker = None
    try:
        result = registry.methods['chat.finalize_session'](None, {
            'session_id': 'closing-chat', 'profile_home': str(tmp_path), 'reason': reason,
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


@pytest.mark.parametrize('surface', ['missing_emitter', 'raises', 'logged_failure'])
def test_archive_notification_is_optional_and_diagnostics_have_no_callback_payload(monkeypatch, tmp_path, caplog, surface):
    import contextlib
    import logging
    import sys
    import types
    from talaria_sidecar.methods import Registry, chat

    called = []
    secret = 'private-synthetic-credential' * 1000

    def emit(db, ids, **kwargs):
        called.append((db.db_path, ids, kwargs))
        if surface == 'raises':
            raise RuntimeError(secret)
        logging.getLogger('hermes_state_common').warning('callback failed: %s', secret)

    module = types.SimpleNamespace()
    if surface != 'missing_emitter':
        module.emit_session_deleted = emit
    monkeypatch.setitem(sys.modules, 'hermes_state_common', module)
    monkeypatch.setattr(chat, 'agent_scope', lambda home: contextlib.nullcontext(home))
    registry = Registry(runtime=None)
    chat.register(registry)
    result = registry.methods['chat.finalize_session'](None, {
        'session_id': 'archive-root', 'profile_home': str(tmp_path), 'reason': 'archive',
        'lineage': ['archive-root', 'archive-tip'],
    })
    assert result == {'messages': []}
    for worker, home in list(chat._RELEASES.items()):
        if home == tmp_path:
            worker.join(5)
    assert not any(home == tmp_path for home in chat._RELEASES.values())
    assert len(called) == (0 if surface == 'missing_emitter' else 1)
    if called:
        assert called[0] == (tmp_path / 'state.db', ['archive-root', 'archive-root', 'archive-tip'], {
            'reason': 'archive', 'primary': 'archive-root', 'sessions_dir': tmp_path / 'sessions',
        })
    assert 'private-synthetic-credential' not in caplog.text
    assert len(caplog.text) < 300
    assert not (tmp_path / 'state.db').exists()


@requires_agent
@pytest.mark.parametrize('mode', ['record', 'raises'])
def test_archive_notifies_profile_plugins_without_finalizing_or_writing_state(handshaken, hermes_home, mode):
    from conftest import AGENT_DIR
    emitter_available = 'def emit_session_deleted' in (AGENT_DIR / 'hermes_state_common.py').read_text()
    profile = hermes_home / 'profiles' / 'archiving'
    plugin = profile / 'plugins' / 'archive-test'
    plugin.mkdir(parents=True)
    (plugin / 'plugin.yaml').write_text('name: archive-test\nversion: 0.0.1\n')
    action = "raise RuntimeError('private-synthetic-credential' * 1000)" if mode == 'raises' else 'pass'
    (plugin / '__init__.py').write_text(f'''import json
from hermes_constants import get_hermes_home

def register(ctx):
    def archived(**kwargs):
        home = get_hermes_home()
        fields = ('session_id', 'reason', 'profile', 'deleted_ids', 'sessions_dir')
        (home / 'archived.json').write_text(json.dumps({{key: kwargs.get(key) for key in fields}}))
        {action}
    def finalized(**kwargs):
        (get_hermes_home() / 'finalized').touch()
    ctx.register_hook('on_session_delete', archived)
    ctx.register_hook('on_session_finalize', finalized)
''')
    (profile / 'config.yaml').write_text('plugins:\n  isolation: in_process\n  enabled: [archive-test]\n')
    # A bogus database is deliberate: notification must neither open nor repair it.
    (profile / 'state.db').write_bytes(b'untouched owner database')
    reply, _ = handshaken.call('chat.finalize_session', {
        'session_id': 'archive-root', 'profile_home': str(profile), 'reason': 'archive',
        'lineage': ['archive-root', 'archive-tip'],
    })
    assert reply.get('result') == {'messages': []}, reply
    if not emitter_available:
        assert not (profile / 'archived.json').exists()
        assert (profile / 'state.db').read_bytes() == b'untouched owner database'
        return
    deadline = time.monotonic() + 15
    while not (profile / 'archived.json').exists() and time.monotonic() < deadline:
        time.sleep(.01)
    # Close drains the already-delivered callback and its diagnostics before inspecting the result.
    handshaken.close()
    assert json.loads((profile / 'archived.json').read_text()) == {
        'session_id': 'archive-root', 'reason': 'archive', 'profile': 'archiving',
        'deleted_ids': ['archive-root', 'archive-tip'], 'sessions_dir': str(profile / 'sessions'),
    }
    assert (profile / 'state.db').read_bytes() == b'untouched owner database'
    assert not (profile / 'finalized').exists()
    assert not (hermes_home / 'archived.json').exists()
    assert 'private-synthetic-credential' not in '\n'.join(handshaken.stderr_lines)


def test_archive_acknowledges_each_notification_while_callbacks_are_blocked(monkeypatch, tmp_path):
    import contextlib
    import threading
    from talaria_sidecar.methods import Registry, chat

    release, acknowledged = threading.Event(), threading.Event()
    entered = []
    replies = []

    def notify(home, session_id, lineage):
        entered.append(session_id)
        assert release.wait(5), 'test did not release its callbacks'

    monkeypatch.setattr(chat, 'agent_scope', lambda home: contextlib.nullcontext(home))
    monkeypatch.setattr(chat, '_notify_archive', notify)
    registry = Registry(runtime=None)
    chat.register(registry)

    def archive_batch():
        for sid in ('archive-one', 'archive-two'):
            replies.append(registry.methods['chat.finalize_session'](None, {
                'session_id': sid, 'profile_home': str(tmp_path), 'reason': 'archive',
            }))
        acknowledged.set()

    caller = threading.Thread(target=archive_batch)
    caller.start()
    try:
        assert acknowledged.wait(1), 'archive batch did not acknowledge while callbacks remain blocked'
        assert replies == [{'messages': []}, {'messages': []}]
        assert len([worker for worker, home in chat._RELEASES.items() if home == tmp_path]) == 2
    finally:
        release.set()
        caller.join(5)
        for worker, home in list(chat._RELEASES.items()):
            if home == tmp_path:
                worker.join(5)
    assert not caller.is_alive()
    assert sorted(entered) == ['archive-one', 'archive-two']
    assert not any(home == tmp_path for home in chat._RELEASES.values())


def test_archive_callback_queue_bounds_threads_and_retains_queued_profile_custody(monkeypatch, tmp_path, caplog):
    import contextlib
    import queue
    import threading
    from talaria_sidecar.errors import RpcError
    from talaria_sidecar.methods import Registry, chat

    pending = queue.Queue(maxsize=2)
    workers = []
    monkeypatch.setattr(chat, '_ARCHIVE_QUEUE', pending, raising=False)
    monkeypatch.setattr(chat, '_ARCHIVE_WORKERS', workers, raising=False)
    monkeypatch.setattr(chat, '_ARCHIVE_MAX_WORKERS', 2, raising=False)
    monkeypatch.setattr(chat, '_PROFILE_RELEASE_TIMEOUT', 0)
    release, active = threading.Event(), threading.Event()
    started, entered = [], []
    original_start = threading.Thread.start
    running_home, queued_home = tmp_path / 'running', tmp_path / 'queued'

    def start(thread):
        if thread.name.startswith('session-'):
            started.append(thread)
        return original_start(thread)

    def notify(home, session_id, lineage):
        entered.append(session_id)
        if len(entered) == 2:
            active.set()
        assert release.wait(5), 'test did not release its callbacks'

    monkeypatch.setattr(threading.Thread, 'start', start)
    monkeypatch.setattr(chat, 'agent_scope', lambda home: contextlib.nullcontext(home))
    monkeypatch.setattr(chat, '_notify_archive', notify)
    registry = Registry(runtime=None)
    chat.register(registry)

    def archive(index, home):
        return registry.methods['chat.finalize_session'](None, {
            'session_id': f'archive-{index}', 'profile_home': str(home), 'reason': 'archive',
        })

    try:
        for i in range(2):
            assert archive(i, running_home) == {'messages': []}
        assert active.wait(1), 'test callbacks did not start'
        for i in range(2, 8):
            assert archive(i, queued_home) == {'messages': []}
        assert len(started) == 2, 'archive requests must share the bounded daemon workers'
        assert all(thread.daemon for thread in started)
        assert len([home for home in chat._RELEASES.values() if home == running_home]) == 2
        assert len([home for home in chat._RELEASES.values() if home == queued_home]) == 2
        with pytest.raises(RpcError, match='profile is still saving'):
            with chat.release_profile_agents(queued_home):
                pytest.fail('queued callback profile lost custody')
        assert 'queue is full' in caplog.text
        assert sorted(entered) == ['archive-0', 'archive-1']
    finally:
        release.set()
        for work, home in list(chat._RELEASES.items()):
            if home in (running_home, queued_home):
                work.join(5)
        for _ in workers:
            pending.put(None)
        for thread in started:
            thread.join(5)
    assert not any(home in (running_home, queued_home) for home in chat._RELEASES.values())
    assert sorted(entered) == ['archive-0', 'archive-1', 'archive-2', 'archive-3']


@pytest.mark.parametrize('fence', ['profile', 'shutdown'])
def test_archive_queue_refuses_admission_after_its_owner_closes(monkeypatch, tmp_path, caplog, fence):
    import queue
    import threading
    from talaria_sidecar.methods import Registry, chat

    monkeypatch.setattr(chat, '_ARCHIVE_QUEUE', queue.Queue(maxsize=2))
    workers = []
    monkeypatch.setattr(chat, '_ARCHIVE_WORKERS', workers)
    draining = threading.Event()
    if fence == 'shutdown':
        draining.set()
    monkeypatch.setattr(chat, '_DRAINING', draining)
    monkeypatch.setattr(chat, '_MCP_CLOSING_HOMES', {str(tmp_path.resolve())} if fence == 'profile' else set())
    registry = Registry(runtime=None)
    chat.register(registry)
    assert registry.methods['chat.finalize_session'](None, {
        'session_id': 'archive-closed', 'profile_home': str(tmp_path), 'reason': 'archive',
    }) == {'messages': []}
    assert workers == []
    assert chat._ARCHIVE_QUEUE.empty()
    assert not any(home == tmp_path for home in chat._RELEASES.values())
    assert 'notification unavailable' in caplog.text
