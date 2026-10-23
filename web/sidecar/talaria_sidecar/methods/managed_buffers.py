"""Fixed devkit REST adapter through the existing admitted Agent plugin host."""
import base64
import json
import re

from .. import home as homes
from ..errors import InvalidParams, RpcError
from . import dashboard_plugins as host

MAX_BYTES = 256 * 1024
_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}')
_DIR = re.compile(r'[A-Za-z0-9_-]{1,96}')


def _text_size(value):
    try:
        return len(value.encode('utf-8')) if isinstance(value, str) else -1
    except UnicodeError:
        return -1


def _bad():
    raise RpcError('Managed buffer response is invalid or too large', condition='buffer_invalid')


def _json(ctx, plugin, home, method, path, content=None):
    # Recheck admission for each native call, including the PUT after inventory.
    current = host._named(home, 'devkit', require_panel=False)
    if current is None or current['_dir'] != plugin['_dir'] or current.get('_api_file') != plugin.get('_api_file'):
        raise RpcError('Managed buffer backend changed or was disabled', condition='buffer_unavailable')
    body = b'' if content is None else json.dumps({'content': content}, ensure_ascii=False).encode()
    result = host._request(ctx, plugin, dict(profile_home=str(home), authenticated=True, method=method, path=path, query='',
        headers={'content-type': 'application/json'}, body=base64.b64encode(body).decode()), require_panel=False)
    if result['status'] != 200:
        # A PUT may have committed before an error or malformed acknowledgement. Never replay it here.
        raise RpcError('Managed buffer unavailable' if method == 'GET' else 'Save outcome is unknown; reload before retrying',
                       condition='buffer_unavailable' if method == 'GET' else 'buffer_save_unconfirmed')
    try:
        value = json.loads(base64.b64decode(result['body']))
    except (ValueError, UnicodeDecodeError):
        _bad()
    if not isinstance(value, dict):
        _bad()
    return value


def run(ctx, params):
    action, sid = params.get('action'), params.get('session_id')
    if action not in ('list', 'read', 'save') or not isinstance(sid, str) or not 0 < len(sid) <= 200:
        raise InvalidParams('Invalid managed buffer request')
    name = params.get('name')
    if action != 'list' and (not isinstance(name, str) or not _NAME.fullmatch(name)):
        raise InvalidParams('Invalid managed buffer name')
    content = params.get('content')
    if action == 'save' and (not 0 <= _text_size(content) <= MAX_BYTES):
        raise InvalidParams('Managed buffer content is too large or is not text')
    home = homes.profile_home_param(params)
    with homes.scoped_home(home, load_plugins=False):
        plugin = host._named(home, 'devkit', require_panel=False) if host._supported() else None
        result = {'supported': plugin is not None, 'buffers': [], 'write_semantics': 'unconditional'}
        if plugin is None:
            if action != 'list':
                raise RpcError('Enable and approve the devkit backend in Plugins', condition='buffer_unavailable')
            return result
        rows = _json(ctx, plugin, home, 'GET', '/sessions').get('sessions')
        if not isinstance(rows, list) or len(rows) > 2000 or any(not isinstance(r, dict) for r in rows):
            _bad()
        matches = [r for r in rows if r.get('session_id') == sid]
        if len(matches) > 1:
            _bad()
        row = matches[0] if matches else None
        if row is None:
            if action != 'list':
                raise RpcError('Managed buffer no longer exists', condition='buffer_unavailable')
            return result
        directory, buffers = row.get('dir'), row.get('buffers')
        if not isinstance(directory, str) or not _DIR.fullmatch(directory) or not isinstance(buffers, list) or len(buffers) > 200:
            _bad()
        seen = set()
        for buf in buffers:
            if not isinstance(buf, dict):
                _bad()
            key, size = buf.get('name'), buf.get('bytes')
            if not isinstance(key, str) or not _NAME.fullmatch(key) or key in seen or type(size) is not int or not 0 <= size <= MAX_BYTES:
                _bad()
            seen.add(key)
            result['buffers'].append({'name': key, 'size': size, 'read_only': row.get('exists') is not True})
        if action == 'list':
            return result
        selected = next((b for b in result['buffers'] if b['name'] == name), None)
        if selected is None:
            raise RpcError('Managed buffer no longer exists', condition='buffer_unavailable')
        if action == 'save' and selected['read_only']:
            raise RpcError('Managed session is deleted or cannot be verified', condition='buffer_read_only')
        value = _json(ctx, plugin, home, 'PUT' if action == 'save' else 'GET', f'/sessions/{directory}/buffers/{name}', content if action == 'save' else None)
        if action == 'read':
            text = value.get('content')
            if value.get('session_id') != sid or value.get('name') != name or not 0 <= _text_size(text) <= MAX_BYTES:
                _bad()
            result.update(content=text, size=_text_size(text), read_only=selected['read_only'])
        else:
            # Native PUT acknowledgements may omit session_id, but an explicit identity must match.
            if value.get('session_id', sid) != sid or value.get('name') != name or type(value.get('bytes')) is not int or not 0 <= value['bytes'] <= MAX_BYTES:
                raise RpcError('Save outcome is unknown; reload before retrying', condition='buffer_save_unconfirmed')
            result.update(size=value['bytes'], read_only=False)
        return result


def register(registry):
    registry.method('plugins.buffers')(run)
