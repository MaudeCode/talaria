"""TAL-1514: the Meshy adapter over synthetic native responses, with real disposable files for asset custody."""
import base64
import contextlib
import json
import os
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from talaria_sidecar.errors import InvalidParams
from talaria_sidecar.methods import build_methods, meshy

TASK = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'
IMAGE_TASK = '0192a3b4-c5d6-7e8f-9a0b-aaaaaaaaaaaa'
THUMB = 'https://assets.meshy.ai/tasks/thumb.png?Expires=1&Signature=s'


@pytest.fixture
def native(tmp_path, monkeypatch):
    home = tmp_path / 'profile'
    data = home / 'plugin-data' / 'agent-plugin-meshy-0' / 'meshy_output' / TASK
    data.mkdir(parents=True)
    model = data / 'model.glb'
    model.write_bytes(b'glTF' + b'\0' * 16)
    images = home / 'plugin-data' / 'agent-plugin-meshy-0' / 'saved-assets' / IMAGE_TASK
    images.mkdir(parents=True)
    (images / 'image-1.png').write_bytes(b'\x89PNG')
    user = tmp_path / 'user'
    user.mkdir()
    monkeypatch.setattr(Path, 'home', classmethod(lambda cls: user))
    state = NS(home=home, model=model, image=images / 'image-1.png', consent=True, configured=True, calls=[], routes={}, supported=True)

    def local_files():
        return {'dir': str(data.parent), 'files': [
            {'path': str(model), 'name': 'model.glb', 'project': TASK, 'bytes': 20, 'modified': 3, 'task': TASK},
            {'path': str(state.image), 'images': [str(state.image)], 'name': 'image-1.png', 'task': IMAGE_TASK, 'kind': 'image',
             'prompt': 'A <b>robot</b>', 'download_incomplete': True, 'bytes': 4, 'modified': 2},
            *state.routes.get('extra_local', [])]}

    def route(method, path, query, body):
        if path in state.routes:
            return state.routes[path](method, query, body)
        if path == '/status':
            return 200, {'configured': state.configured, 'balance': 42, 'settings': {'auto_rotate': False}}
        if path == '/local':
            return 200, local_files()
        if path == '/models':
            return 200, {'configured': True, 'models': [
                {'task_id': TASK, 'task_type': 'text-to-3d', 'kind': 'model', 'prompt': 'robot', 'created_at': 5, 'thumbnail_url': THUMB,
                 'glb_url': 'https://assets.meshy.ai/x.glb', 'image_urls': [], 'expired': False, 'credits': None, 'local_path': str(model)},
                {'task_id': IMAGE_TASK, 'kind': 'image', 'thumbnail_url': 'https://evil.example/x.png', 'image_urls': ['http://assets.meshy.ai/a.png', 'https://assets.meshy.ai:8443/b.png', THUMB], 'credits': 3},
                {'task_id': '../../etc', 'kind': 'model'}]}
        if path == '/active':
            return 200, {'tasks': [{'task_id': TASK, 'status': 'IN_PROGRESS', 'progress': 140, 'stage': 'preview'}, {'task_id': 'nope'}]}
        if path == '/task':
            return 200, {'task': query.get('task'), 'status': 'SUCCEEDED', 'progress': 99, 'type': 'text-to-3d-preview', 'thumbnail': THUMB, 'credits': 20, 'has_model': True}
        return 404, {}

    def request(ctx, plugin, params, *, require_panel=True, timeout=10.0):
        assert plugin['name'] == 'meshy' and require_panel is False and params['authenticated'] is True
        from urllib.parse import parse_qsl
        query = dict(parse_qsl(params['query']))
        body = json.loads(base64.b64decode(params['body']) or b'null')
        state.calls.append((params['method'], params['path'], query, body, timeout))
        status, value = route(params['method'], params['path'], query, body)
        return {'status': status, 'body': base64.b64encode(json.dumps(value).encode()).decode(), 'content_type': 'application/json'}

    @contextlib.contextmanager
    def scope(selected, **kwargs):
        assert kwargs == {'load_plugins': False}
        yield selected

    monkeypatch.setattr(meshy.homes, 'scoped_home', scope)
    monkeypatch.setattr(meshy, '_producer', lambda selected: meshy._PIN if state.consent and str(selected) == str(home) else None)
    monkeypatch.setattr(meshy.host, '_supported', lambda: state.supported)
    monkeypatch.setattr(meshy.host, '_named', lambda selected, name, require_panel=True: {'name': name, '_dir': 'x', '_api_file': 'plugin_api.py'})
    monkeypatch.setattr(meshy.host, '_request', request)
    methods = build_methods(NS(load=lambda: None, ensure_current=lambda: None))

    def call(action, **params):
        return methods['plugins.meshy'](NS(check_cancelled=lambda: None), {'profile_home': str(home), 'action': action, **params})
    state.call = call
    return state


def test_overview_bounds_native_rows_and_never_forwards_foreign_hosts_or_invalid_ids(native):
    result = native.call('overview')
    assert result['availability'] == 'ready' and result['balance'] == 42 and result['revision'] == meshy._PIN and result['auto_rotate'] is False
    assert [r['task_id'] for r in result['recent']] == [TASK, IMAGE_TASK]
    assert result['recent'][0]['thumbnail_url'] == THUMB and result['recent'][0]['credits'] is None
    # Only https on the asset host without a port: the http and :8443 links and the foreign thumbnail are dropped.
    assert result['recent'][1]['thumbnail_url'] is None and result['recent'][1]['image_urls'] == [THUMB]
    assert result['active'] == [{'task_id': TASK, 'status': 'in_progress', 'progress': 100, 'terminal': False, 'stage': 'preview', 'error': None}]
    assert [r['kind'] for r in result['local']] == ['model', 'image'] and result['local'][1]['download_incomplete'] is True


def test_states_are_explicit_for_missing_key_plugin_and_old_agent(native):
    native.configured = False
    result = native.call('overview')
    assert result['availability'] == 'missing_key' and result['recent'] == [] and len(result['local']) == 2
    assert not any(c[1] in ('/models', '/active') for c in native.calls)
    native.consent = False
    assert native.call('overview')['availability'] == 'plugin_unavailable'
    native.supported = False
    assert native.call('overview') == {'availability': 'agent_incompatible', 'message': None, 'balance': None, 'revision': None}


def test_revocation_while_native_code_runs_discards_its_answer(native, monkeypatch):
    real = native.routes.get
    def revoke(method, query, body):
        native.consent = False
        return 200, {'task': TASK, 'status': 'SUCCEEDED'}
    native.routes['/task'] = revoke
    result = native.call('task', task_id=TASK)
    assert result['availability'] == 'plugin_unavailable' and 'task' not in result
    assert real is not None


def test_asset_custody_requires_native_listing_and_refuses_links_hardlinks_and_unlisted_files(native, tmp_path):
    ok = native.call('asset', path=str(native.model))['asset']
    assert ok == {'path': str(native.model), 'anchor': str((native.home / 'plugin-data').resolve()), 'mime': 'model/gltf-binary', 'bytes': 20}
    assert native.call('asset', path=str(native.image))['asset']['mime'] == 'image/png'
    stray = native.model.parent / 'other.glb'
    stray.write_bytes(b'glTF')
    assert native.call('asset', path=str(stray))['asset'] is None, 'Not in the native inventory'
    link = native.model.parent / 'link.glb'
    link.symlink_to(tmp_path / 'outside.glb')
    (tmp_path / 'outside.glb').write_bytes(b'glTF')
    native.routes['extra_local'] = [{'path': str(link), 'task': TASK}]
    assert native.call('asset', path=str(link))['asset'] is None, 'A symlink escapes its anchor'
    hard = native.model.parent / 'hard.glb'
    os.link(native.model, hard)
    native.routes['extra_local'] = [{'path': str(hard), 'task': TASK}]
    assert native.call('asset', path=str(hard))['asset'] is None, 'A hard link may alias another file'
    gltf = native.model.parent / 'scene.gltf'
    gltf.write_text('{"buffers":[{"uri":"https://evil.example/b.bin"}]}')
    native.routes['extra_local'] = [{'path': str(gltf), 'task': TASK}]
    assert native.call('asset', path=str(gltf))['asset'] is None, 'A .gltf can name external resources'
    native.consent = False
    assert native.call('asset', path=str(native.model))['asset'] is None, 'Stale consent'
    assert not any(c[1] in ('/status', '/file', '/remote') for c in native.calls), 'Bytes are never read through native data URLs'
    with pytest.raises(InvalidParams):
        native.call('asset', path='relative/model.glb')


def test_card_resolves_a_directive_only_through_the_native_inventory(native):
    card = native.call('card', task_id=TASK, path=str(native.model))
    assert [row['path'] for row in card['local']] == [str(native.model)]
    assert card['task']['status'] == 'succeeded' and card['task']['progress'] == 100 and card['task']['terminal']
    foreign = native.call('card', path='/etc/passwd.glb')
    assert foreign['local'] == [] and foreign['task'] is None


def test_details_ship_server_drafts_and_never_locate_the_source_image(native):
    native.routes['/formats'] = lambda m, q, b: (200, {'formats': [{'format': 'glb', 'saved': '/x/model.glb'}, {'format': 'glb:walking', 'saved': None}, {'format': 'exe'}],
                                                       'conversions': [{'format': 'fbx', 'cost': 1, 'message': 'Meshy task: convert it to FBX (1 credit).'}], 'is_preview': True})
    native.routes['/actions'] = lambda m, q, b: (200, {'balance': None, 'actions': [{'id': 'remesh', 'label': 'Remesh', 'cost': 5, 'affordable': True, 'message': 'Meshy task: remesh it (5 credits).'},
                                                                                    {'id': 'Bad Id', 'message': 'x'}]})
    native.routes['/details'] = lambda m, q, b: (200, {'task': TASK, 'prompt': 'robot', 'image': '/home/me/secret/ref.png', 'settings': {'topology': 'quad', 'nested': {}},
                                                       'parents': [{'task_id': IMAGE_TASK, 'tool': 'meshy_text_to_image'}], 'children': [], 'recorded': True})
    result = native.call('details', task_id=TASK, path=str(native.model))
    details = result['details']
    assert [f['format'] for f in details['formats']] == ['glb', 'glb:walking'] and details['formats'][0] == {'format': 'glb', 'label': 'GLB', 'saved': True}
    assert details['conversions'] == [{'id': 'convert-fbx', 'label': 'Convert to FBX', 'cost': 1, 'affordable': None, 'draft': 'Meshy task: convert it to FBX (1 credit).'}]
    assert [a['id'] for a in details['actions']] == ['remesh']
    assert details['provenance']['source_image'] == 'ref.png' and details['provenance']['settings'] == [{'key': 'topology', 'value': 'quad'}]
    assert result['balance'] == 42, 'Unknown balance from /actions keeps the status balance; nothing is invented'
    assert ('GET', '/formats', {'task': TASK, 'beside': str(native.model)}, None, 10.0) in native.calls


def test_downloads_are_explicit_never_overwrite_and_report_partial_image_sets(native):
    native.routes['/save'] = lambda m, q, b: (200, {'path': str(native.model.parent / 'model.fbx'), 'bytes': 9})
    saved = native.call('save', task_id=TASK, format='fbx', path=str(native.model))
    assert saved['saved'] == ['model.fbx'] and saved['complete'] is True
    assert ('POST', '/save', {}, {'task': TASK, 'format': 'fbx', 'beside': str(native.model)}, meshy._SAVE_TIMEOUT) in native.calls
    native.routes['/save'] = lambda m, q, b: (409, {'detail': 'no free file name'})
    refused = native.call('save', task_id=TASK, format='fbx')
    assert refused['complete'] is False and 'free file name' in refused['error'] and refused['saved'] == []
    native.routes['/save-images'] = lambda m, q, b: (502, {'detail': 'Meshy asset download failed'})
    partial = native.call('save_images', task_id=IMAGE_TASK)
    assert partial == {**partial, 'complete': False, 'saved': ['image-1.png']} and partial['error']
    with pytest.raises(InvalidParams):
        native.call('save', task_id=TASK, format='exe')
    with pytest.raises(InvalidParams):
        native.call('save', task_id='../x', format='glb')
    native.configured = False
    assert native.call('save', task_id=TASK, format='glb')['complete'] is False
    assert not [c for c in native.calls if c[1] == '/save' and c[3]['format'] == 'glb'], 'No native write without a key'
