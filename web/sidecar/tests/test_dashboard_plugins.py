"""Profile-owned dashboard hosting, using synthetic files and Agent boundary fakes."""
import contextlib
import contextvars
import json
import sys
from types import SimpleNamespace as NS

import pytest

from talaria_sidecar.methods import build_methods
from talaria_sidecar.errors import Cancelled


@pytest.fixture
def dashboards(tmp_path, monkeypatch):
    current = contextvars.ContextVar('dashboard_home')
    homes = [tmp_path / 'alpha', tmp_path / 'alpha' / 'profiles' / 'beta']
    from talaria_sidecar.methods import dashboard_plugins
    monkeypatch.setattr(dashboard_plugins, '_SOURCE_CLOSED', False)
    monkeypatch.setattr(dashboard_plugins, '_BASE_HOME', homes[0].resolve(), raising=False)
    monkeypatch.setattr(dashboard_plugins, '_RAW_BASE_HOME', homes[0], raising=False)
    monkeypatch.setattr('talaria_sidecar.home._PROCESS_HOME', homes[0])
    plugins = {}
    for home in homes:
        names = ['board'] + (['secondary'] if home.name == 'beta' else [])
        plugins[str(home)] = []
        for name in names:
            root = home / 'plugins' / name / 'dashboard'
            (root / 'dist').mkdir(parents=True)
            (root / 'manifest.json').write_text(json.dumps({'name': name, 'panel': 'dist/index.html'}))
            (root / 'api.py').write_text('# synthetic API')
            (root / 'dist' / 'index.html').write_text(f'<p>{home.name}:{name}</p>')
            plugins[str(home)].append({'name': name, 'label': f'{home.name}:{name}', '_dir': str(root), '_api_file': 'api.py', 'source': 'user'})
    consent = {str(homes[0]): {'board'}, str(homes[1]): set()}
    @contextlib.contextmanager
    def scope(home, **kwargs):
        assert kwargs == {'load_plugins': False}, 'dashboard reads must not import user plugin code in the sidecar'
        token = current.set(str(home))
        try:
            yield home
        finally:
            current.reset(token)
    monkeypatch.setattr('talaria_sidecar.home.scoped_home', scope)
    monkeypatch.setitem(sys.modules, 'hermes_cli', NS())
    monkeypatch.setitem(sys.modules, 'hermes_cli.web_server_plugin_profiles', NS(_scan_profile_plugins=lambda home: plugins[str(home)]))
    monkeypatch.setitem(sys.modules, 'hermes_cli.web_server_dashboard', NS(
        _plugin_enable_sets_here=lambda: (consent[current.get()], set()),
        _plugin_api_mount_skip_reason=lambda p, enabled, disabled: None if p['name'] in enabled else 'not enabled'))
    class Host:
        def asgi_request(self, *args, authenticated=False, **kwargs):
            raise AssertionError('read started plugin host')
    monkeypatch.setitem(sys.modules, 'hermes_cli.plugin_host', NS(PluginHost=Host))
    methods = build_methods(NS(load=lambda: None, ensure_current=lambda: None))
    assert 'plugins.dashboard_list' in methods, 'profile-owned Agent dashboard discovery is absent'
    ctx = NS(check_cancelled=lambda: None, cancelled=False)
    def call(action, home, **params):
        return methods[f'plugins.dashboard_{action}'](ctx, {'profile_home': str(home), **params})
    monkeypatch.setitem(sys.modules, 'hermes_cli.plugins_cmd', NS(
        _resolve_plugin_key=lambda name: name,
        _activate_key=lambda key, enable: consent[current.get()].add(key) if enable else consent[current.get()].discard(key)))
    try:
        yield NS(homes=homes, plugins=plugins, consent=consent, call=call, ctx=ctx, methods=methods, current=current, Host=Host)
    finally:
        dashboard_plugins.close_dashboard_sources()


def test_dashboard_plugins_keep_same_name_discovery_assets_and_consent_in_the_selected_profile(dashboards):
    homes, consent, call = dashboards.homes, dashboards.consent, dashboards.call
    alpha = call('list', homes[0])
    beta = call('list', homes[1])
    assert [p['name'] for p in alpha['plugins']] == ['board']
    assert [p['name'] for p in beta['plugins']] == ['board', 'secondary']
    assert alpha['plugins'][0]['enabled'] is True
    assert beta['plugins'][0]['enabled'] is False
    import base64
    assert base64.b64decode(call('asset', homes[0], name='board', path='dist/index.html')['body']) == b'<p>alpha:board</p>'
    assert call('asset', homes[1], name='board', path='dist/index.html')['status'] == 404
    consent[str(homes[1])].add('board')
    assert base64.b64decode(call('asset', homes[1], name='board', path='dist/index.html')['body']) == b'<p>beta:board</p>'
    assert call('asset', homes[0], name='secondary', path='dist/index.html')['status'] == 404


def test_native_desktop_bundles_are_listed_for_migration_and_cannot_execute(dashboards):
    d = dashboards
    root = d.homes[0] / 'plugins/board/dashboard'
    (root / 'manifest.json').write_text(json.dumps({'name': 'board', 'entry': 'dist/desktop.js'}))
    row = d.call('list', d.homes[0])['plugins'][0]
    assert row['panel'] is None
    assert d.call('asset', d.homes[0], name='board', path='dist/index.html')['status'] == 404


def test_native_consent_is_profile_owned_and_only_explicit_toggles_write(dashboards):
    d = dashboards
    assert d.call('toggle', d.homes[1], name='board', enabled=True) == {'ok': True}
    assert d.consent[str(d.homes[1])] == {'board'}
    d.call('toggle', d.homes[0], name='board', enabled=False)
    assert d.consent[str(d.homes[0])] == set()
    assert d.call('list', d.homes[1])['plugins'][0]['enabled'] is True


@pytest.mark.parametrize('path', ['../manifest.json', 'dist/../manifest.json', 'dist/.env', 'dist/link.js', 'dist/api.py', 'dist/%2e%2e/secret.txt', 'static//x.js'])
def test_untrusted_assets_and_paths_serve_nothing(dashboards, path, tmp_path):
    d = dashboards
    root = d.homes[0] / 'plugins/board/dashboard'
    outside = tmp_path / 'secret.js'
    outside.write_text('secret')
    (root / 'dist/link.js').symlink_to(outside)
    assert d.call('asset', d.homes[0], name='board', path=path)['status'] == 404


def _api(d, monkeypatch, native):
    monkeypatch.setitem(sys.modules, 'hermes_cli.plugins', NS(get_plugin_manager=lambda: NS(_plugin_host=lambda: NS(asgi_request=native))))
    def call(home=None, **kwargs):
        return d.call('request', home or d.homes[0], name='board', path='/identity', method='GET', query='',
                      headers={}, body='', websocket=False, **kwargs)
    return call


def test_api_keeps_profile_identity_and_strips_credentials_with_request_local_admission(dashboards, monkeypatch):
    import base64
    d = dashboards
    seen = []
    def native(name, root, api, method, path, query, headers, body, *, timeout, authenticated):
        seen.append((d.current.get(), authenticated, query, headers))
        return {'status': 200, 'body': d.current.get().encode(), 'headers': [('content-type', 'text/plain'), ('set-cookie', 'nope')]}
    _api(d, monkeypatch, native)
    d.call('toggle', d.homes[1], name='board', enabled=True)
    for home in d.homes:
        params = dict(name='board', path='/identity', method='GET', query='profile=other&%74oken=secret&ticket=secret&q=hello',
                      headers={'Authorization': 'secret', 'Cookie': 'secret', 'X-CSRF-Token': 'secret', 'X-Hermes-Gateway-Ticket': 'secret', 'X-Forwarded-Host': 'evil', 'Accept': 'application/json'}, body='', websocket=False)
        refused = d.call('request', home, authenticated=False, **params)
        assert refused['status'] == 404
        result = d.call('request', home, authenticated=True, **params)
        assert base64.b64decode(result['body']).decode() == str(home)
        assert result['content_type'] == 'text/plain'
    assert seen == [(str(home), True, 'q=hello', [('accept', 'application/json')]) for home in d.homes]


@pytest.mark.parametrize('outcome', ['timeout', 'cancel', 'oversize', 'stream', 'websocket'])
def test_http_limits_cancellation_and_unsupported_transports(dashboards, monkeypatch, outcome):
    d = dashboards
    def check():
        if d.ctx.cancelled:
            raise Cancelled()
    d.ctx.check_cancelled = check
    def native(*args, **kwargs):
        if outcome == 'timeout':
            raise TimeoutError()
        if outcome == 'cancel':
            d.ctx.cancelled = True
        return {'status': 200, 'body': b'x' * (512 * 1024 + 1 if outcome == 'oversize' else 1),
                'headers': [('content-type', 'text/event-stream' if outcome == 'stream' else 'text/plain')]}
    call = _api(d, monkeypatch, native)
    if outcome == 'cancel':
        with pytest.raises(Cancelled):
            call(authenticated=True)
    elif outcome == 'websocket':
        assert d.call('request', d.homes[0], name='board', path='/', authenticated=True, websocket=True)['status'] == 501
    else:
        assert call(authenticated=True)['status'] == {'timeout': 504, 'oversize': 502, 'stream': 501}[outcome]


@pytest.mark.parametrize('ancestor', ['plugins', 'profiles'])
def test_symlinked_plugins_ancestor_never_serves_assets_or_reaches_native_api(dashboards, monkeypatch, tmp_path, ancestor):
    d = dashboards
    home = d.homes[0] if ancestor == 'plugins' else d.homes[1]
    d.consent[str(home)].add('board')
    plugins_dir = d.homes[0] / ancestor
    outside = tmp_path / 'outside-plugins'
    plugins_dir.rename(outside)
    plugins_dir.symlink_to(outside, target_is_directory=True)
    assert d.call('asset', home, name='board', path='dist/index.html')['status'] == 404
    def native(*args, **kwargs):
        raise AssertionError('symlinked ancestor reached executable native host')
    call = _api(d, monkeypatch, native)
    assert call(home, authenticated=True)['status'] == 404


def test_plugin_directory_names_do_not_become_url_paths(dashboards):
    d = dashboards
    home = d.homes[0]
    original = home / 'plugins/board'
    renamed = home / 'plugins/board copy'
    original.rename(renamed)
    d.plugins[str(home)][0]['_dir'] = str(renamed / 'dashboard')
    result = d.call('asset', home, name='board', path='dist/index.html')
    assert result['status'] == 200
    import base64
    assert base64.b64decode(result['body']) == b'<p>alpha:board</p>'


def test_native_loader_uses_verified_source_and_preserves_module_location(dashboards, monkeypatch):
    import base64
    import importlib.util
    from pathlib import Path
    d = dashboards
    original = d.homes[0] / 'plugins/board/dashboard/api.py'
    source = b"from __future__ import annotations\nfrom pathlib import Path\nVALUE = 'verified'\nRESOURCE = Path(__file__).with_name('resource.txt').read_text()\n"
    original.write_bytes(source)
    original.with_name('resource.txt').write_text('adjacent profile resource')
    def native(name, root, api, *args, **kwargs):
        # An ordinary concurrent edit after validation must not change the entry source being loaded.
        original.write_bytes(source.replace(b"'verified'", b"'later edit'"))
        spec = importlib.util.spec_from_file_location('dashboard_fixture', Path(root) / api)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = {'value': module.VALUE, 'resource': module.RESOURCE, 'source': module.__file__,
                  'origin': module.__spec__.origin, 'loader_source': module.__loader__.get_filename(module.__name__)}
        return {'status': 200, 'body': json.dumps(result).encode(), 'headers': [('content-type', 'application/json')]}
    result = _api(d, monkeypatch, native)(authenticated=True)
    assert result['status'] == 200
    assert json.loads(base64.b64decode(result['body'])) == {
        'value': 'verified', 'resource': 'adjacent profile resource', 'source': str(original),
        'origin': str(original), 'loader_source': str(original)}


def test_source_snapshot_is_reused_and_retained_until_shutdown_after_timeout(dashboards, monkeypatch):
    from pathlib import Path
    from talaria_sidecar.methods.dashboard_plugins import close_dashboard_sources
    paths = []
    def native(name, root, api, *args, **kwargs):
        paths.append(Path(root) / api)
        assert paths[-1].is_file()
        raise TimeoutError()
    call = _api(dashboards, monkeypatch, native)
    assert call(authenticated=True)['status'] == 504
    assert call(authenticated=True)['status'] == 504
    assert paths[0] == paths[1], 'repeated requests must reuse the native cached app'
    assert paths[0].is_file(), 'a timed-out native load may still need its verified source'
    close_dashboard_sources()
    assert not paths[0].exists()
    from talaria_sidecar.errors import RpcError
    with pytest.raises(RpcError, match='shutting down'):
        call(authenticated=True)
    assert len(paths) == 2, 'shutdown must not recreate a source cache or start more native work'


def test_source_cache_exhaustion_refuses_before_starting_native_work(dashboards, monkeypatch):
    from talaria_sidecar.errors import RpcError
    monkeypatch.setattr('talaria_sidecar.methods.dashboard_plugins._MAX_SOURCE_BYTES', 0)
    def native(*args, **kwargs):
        raise AssertionError('exhausted source cache started native work')
    with pytest.raises(RpcError, match='source cache is full'):
        _api(dashboards, monkeypatch, native)(authenticated=True)


def test_cancel_during_source_preparation_never_dispatches_native_work(dashboards, monkeypatch):
    from talaria_sidecar.methods import dashboard_plugins
    d = dashboards
    prepare = dashboard_plugins._api_source
    def source(*args):
        result = prepare(*args)
        d.ctx.cancelled = True
        return result
    def check():
        if d.ctx.cancelled:
            raise Cancelled()
    def native(*args, **kwargs):
        raise AssertionError('cancelled source preparation started native work')
    monkeypatch.setattr(dashboard_plugins, '_api_source', source)
    d.ctx.check_cancelled = check
    with pytest.raises(Cancelled):
        _api(d, monkeypatch, native)(authenticated=True)


def test_native_load_trace_does_not_expand_the_entire_snapshot_source(dashboards, monkeypatch):
    import importlib.util
    import traceback
    from pathlib import Path
    from talaria_sidecar.errors import RpcError
    original = dashboards.homes[0] / 'plugins/board/dashboard/api.py'
    original.write_text("PRIVATE_SAMPLE = 'fixture_source_not_for_trace'\nraise RuntimeError('fixture load failure')\n")
    def native(name, root, api, *args, **kwargs):
        spec = importlib.util.spec_from_file_location('dashboard_fixture', Path(root) / api)
        spec.loader.exec_module(importlib.util.module_from_spec(spec))
    with pytest.raises(RpcError, match='Agent plugin request failed') as failure:
        _api(dashboards, monkeypatch, native)(authenticated=True)
    trace = ''.join(traceback.format_exception(type(failure.value), failure.value, failure.value.__traceback__))
    assert 'fixture load failure' in trace
    assert 'fixture_source_not_for_trace' not in trace


def _managed(d, monkeypatch):
    """Native boundary fake; real admission, routing and validation still run."""
    from talaria_sidecar.methods import managed_buffers
    d.plugins[str(d.homes[0])][0]['name'] = 'devkit'
    (d.homes[0] / 'plugins/board/dashboard/manifest.json').write_text('{"name":"devkit","api":"api.py"}')
    d.consent[str(d.homes[0])] = {'devkit'}
    state = NS(text='original', exists=True, present=True, calls=[], bad=None)
    def native(name, root, api, method, path, query, headers, body, *, timeout, authenticated):
        assert name == 'devkit' and authenticated and not query
        state.calls.append((method, path))
        if path == '/sessions':
            value = {'sessions': [{'session_id': 'one', 'dir': 'native-one', 'exists': state.exists,
                                  'buffers': [{'name': 'draft.txt', 'bytes': len(state.text.encode())}]}] if state.present else []}
        else:
            assert path == '/sessions/native-one/buffers/draft.txt'
            if method == 'PUT':
                state.text = json.loads(body)['content']
            value = {'name': 'draft.txt', 'bytes': len(state.text.encode()), 'path': '/private/plugin-data/devkit/draft.txt'}
            if method == 'GET':
                value.update(session_id='one', content=state.text)
        if state.bad is not None:
            value = state.bad
        return {'status': 200, 'body': json.dumps(value).encode(), 'headers': [('content-type', 'application/json')]}
    monkeypatch.setitem(sys.modules, 'hermes_cli.plugins', NS(get_plugin_manager=lambda: NS(_plugin_host=lambda: NS(asgi_request=native))))
    def call(action='list', **kwargs):
        return d.methods['plugins.buffers'](d.ctx, dict(profile_home=str(d.homes[0]), session_id='one', action=action, **kwargs))
    state.call = call
    state.limit = managed_buffers.MAX_BYTES
    return state


def test_managed_buffers_use_enabled_backend_without_a_web_panel_and_strip_native_paths(dashboards, monkeypatch):
    s = _managed(dashboards, monkeypatch)
    assert s.call()['buffers'] == [{'name': 'draft.txt', 'size': 8, 'read_only': False}]
    assert s.call('read', name='draft.txt')['content'] == 'original'
    assert s.call('save', name='draft.txt', content='edited')['size'] == 6
    result = s.call('read', name='draft.txt')
    assert result['content'] == 'edited'
    assert result['write_semantics'] == 'unconditional'
    assert '/private' not in json.dumps(result)
    assert all(method in ('GET', 'PUT') and not path.endswith('/clear') for method, path in s.calls)


@pytest.mark.parametrize('exists', [False, None, 'true'])
def test_managed_deleted_or_unknown_sessions_are_read_only(dashboards, monkeypatch, exists):
    from talaria_sidecar.errors import RpcError
    s = _managed(dashboards, monkeypatch)
    s.exists = exists
    assert s.call('read', name='draft.txt')['read_only'] is True
    with pytest.raises(RpcError, match='deleted or cannot be verified'):
        s.call('save', name='draft.txt', content='refused')
    assert s.text == 'original'
    assert not any(method == 'PUT' for method, _ in s.calls)


def test_managed_foreign_profile_disabled_and_cleanup_disappearance_do_not_fall_back(dashboards, monkeypatch):
    from talaria_sidecar.errors import RpcError
    d = dashboards
    s = _managed(d, monkeypatch)
    foreign = d.methods['plugins.buffers'](d.ctx, dict(profile_home=str(d.homes[1]), session_id='one', action='list'))
    assert foreign['supported'] is False
    d.consent[str(d.homes[0])].clear()
    assert s.call()['supported'] is False
    assert s.calls == []
    d.consent[str(d.homes[0])].add('devkit')
    s.present = False
    assert s.call()['buffers'] == []
    with pytest.raises(RpcError, match='no longer exists'):
        s.call('save', name='draft.txt', content='cannot recreate')
    assert not any(method == 'PUT' for method, _ in s.calls)


@pytest.mark.parametrize('bad', [{}, {'sessions': 'wrong'}, {'sessions': [None]}, {'sessions': [{'session_id': 'one', 'dir': '../escape', 'buffers': []}]}])
def test_managed_malformed_inventory_is_refused(dashboards, monkeypatch, bad):
    from talaria_sidecar.errors import RpcError
    s = _managed(dashboards, monkeypatch)
    s.bad = bad
    with pytest.raises(RpcError, match='invalid or too large'):
        s.call()


def test_managed_content_bounds_and_unknown_save_never_replay(dashboards, monkeypatch):
    from talaria_sidecar.errors import InvalidParams, RpcError
    s = _managed(dashboards, monkeypatch)
    for content in [None, {}, '\ud800', 'é' * (s.limit // 2 + 1)]:
        with pytest.raises(InvalidParams):
            s.call('save', name='draft.txt', content=content)
    s.text = 'x' * (s.limit + 1)
    with pytest.raises(RpcError, match='invalid or too large'):
        s.call()
    s.text = 'original'
    from talaria_sidecar.methods import managed_buffers
    real = managed_buffers.host._request
    def lost(ctx, plugin, params, **kwargs):
        reply = real(ctx, plugin, params, **kwargs)
        if params['method'] == 'PUT':
            reply['status'] = 504
        return reply
    monkeypatch.setattr(managed_buffers.host, '_request', lost)
    with pytest.raises(RpcError, match='outcome is unknown'):
        s.call('save', name='draft.txt', content='committed')
    assert s.call('read', name='draft.txt')['content'] == 'committed'
    assert sum(method == 'PUT' for method, _ in s.calls) == 1


@pytest.mark.parametrize('field,value', [('content', None), ('content', '\ud800'), ('content', 'x' * (256 * 1024 + 1)), ('session_id', 'foreign'), ('name', '../other')])
def test_managed_invalid_content_or_foreign_identity_never_reaches_the_editor(dashboards, monkeypatch, field, value):
    import base64
    from talaria_sidecar.errors import RpcError
    from talaria_sidecar.methods import managed_buffers
    s = _managed(dashboards, monkeypatch)
    real = managed_buffers.host._request
    def malformed(ctx, plugin, params, **kwargs):
        reply = real(ctx, plugin, params, **kwargs)
        if '/buffers/' in params['path']:
            body = json.loads(base64.b64decode(reply['body']))
            body[field] = value
            reply['body'] = base64.b64encode(json.dumps(body).encode()).decode()
        return reply
    monkeypatch.setattr(managed_buffers.host, '_request', malformed)
    with pytest.raises(RpcError, match='invalid or too large'):
        s.call('read', name='draft.txt')


def test_managed_revoked_consent_between_inventory_and_save_prevents_dispatch(dashboards, monkeypatch):
    from talaria_sidecar.errors import RpcError
    from talaria_sidecar.methods import managed_buffers
    d = dashboards
    s = _managed(d, monkeypatch)
    real = managed_buffers.host._request
    def revoke(ctx, plugin, params, **kwargs):
        reply = real(ctx, plugin, params, **kwargs)
        if params['path'] == '/sessions':
            d.consent[str(d.homes[0])].clear()
        return reply
    monkeypatch.setattr(managed_buffers.host, '_request', revoke)
    with pytest.raises(RpcError, match='changed or was disabled'):
        s.call('save', name='draft.txt', content='refused')
    assert s.text == 'original'
    assert not any(method == 'PUT' for method, _ in s.calls)


@pytest.mark.parametrize('identity', ['absent', 'one', 'foreign', None, 7])
def test_managed_save_acknowledgement_rejects_explicit_foreign_session(dashboards, monkeypatch, identity):
    import base64
    from talaria_sidecar.errors import RpcError
    from talaria_sidecar.methods import managed_buffers
    s = _managed(dashboards, monkeypatch)
    real = managed_buffers.host._request
    def acknowledgement(ctx, plugin, params, **kwargs):
        reply = real(ctx, plugin, params, **kwargs)
        if params['method'] == 'PUT' and identity != 'absent':
            body = json.loads(base64.b64decode(reply['body']))
            body['session_id'] = identity
            reply['body'] = base64.b64encode(json.dumps(body).encode()).decode()
        return reply
    monkeypatch.setattr(managed_buffers.host, '_request', acknowledgement)
    if identity in ('absent', 'one'):
        assert s.call('save', name='draft.txt', content='saved')['size'] == 5
    else:
        with pytest.raises(RpcError, match='outcome is unknown') as refused:
            s.call('save', name='draft.txt', content='uncertain')
        assert refused.value.data['condition'] == 'buffer_save_unconfirmed'
    assert sum(method == 'PUT' for method, _ in s.calls) == 1
