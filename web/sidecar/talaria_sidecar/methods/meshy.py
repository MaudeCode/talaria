"""TAL-1514: closed adapter over the reviewed Meshy plugin's native dashboard API.

Calls only fixed native routes of the installed, enabled plugin at the reviewed revision, through the Agent's own plugin
host (the plugin's code runs there, never here). Every answer is validated and bounded before it leaves: task ids,
asset hosts, text, numbers and local paths. Never runs a credit-spending tool or reaches Meshy itself.
"""
from __future__ import annotations

import base64
import json
import os
import re
import stat
import urllib.parse
from pathlib import Path

from .. import home as homes
from ..errors import InvalidParams
from . import dashboard_plugins as host

_NAME = 'meshy'
_PIN = 'c16e967d798d8dd3b1827a62673c18627f31e0ed'
_SOURCES = {'dashboard/plugin_api.py': 'fcfaefb64464ba9e1bbaccaf0e5f109713a7bb2efb971ac6494ce2b197192f9c',
            'dashboard/manifest.json': '55f3154bfcbd01da1620f3f174d96dc279595fbac4bee7d31d13450e781d0869',
            'plugin.json': '6a14fcfb4086fc6bc07405f9929926bbe9a06e3cba069fc31b2142ef6aee1b67'}
_TASK_ID = re.compile(r'^[0-9a-f][0-9a-f-]{15,63}$')
_FORMAT = re.compile(r'^(glb|fbx|obj|stl|usdz|3mf|blend)(?::([a-z0-9_]{1,40}))?$')
_ASSET_HOST = 'assets.meshy.ai'
# The native viewer's own cap for one served file.
_MAX_FILE = 128 * 1024 * 1024
_MIME = {'.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}
_STATUSES = {'PENDING': 'pending', 'IN_PROGRESS': 'in_progress', 'SUCCEEDED': 'succeeded', 'FAILED': 'failed',
             'CANCELED': 'canceled', 'EXPIRED': 'expired'}
_TERMINAL = {'succeeded', 'failed', 'canceled', 'expired'}
# A native save downloads from Meshy's asset host; give it the native timeout rather than the 10 s read budget.
_SAVE_TIMEOUT = 110.0
_SAVE_ERRORS = {400: 'Meshy needs an API key for downloads.', 404: 'Meshy has no such file for this task.',
                409: 'There is no free file name beside the model.', 410: 'This asset expired on Meshy. Open a saved copy if you have one.',
                413: 'The file is larger than the download limit.', 504: 'The download is still running or its outcome is unknown. Refresh to check before retrying.'}


def _producer(home):
    return host.reviewed_producer(home, _NAME, _PIN, _SOURCES)


def _text(value, limit=300):
    if not isinstance(value, str):
        return None
    value = ''.join(ch for ch in value if ch >= ' ' or ch in '\n\t').strip()
    return value[:limit] or None


def _num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) < 1e15 else None


def _int(value, low=0, high=None):
    value = _num(value)
    if value is None:
        return None
    value = int(value)
    return max(low, value if high is None else min(high, value))


def _task(value):
    return value if isinstance(value, str) and _TASK_ID.match(value) else None


def _asset_url(value):
    """A signed asset link only on Meshy's asset host over https: no userinfo, port or other host."""
    if not isinstance(value, str) or len(value) > 4096:
        return None
    try:
        parts = urllib.parse.urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != 'https' or parts.hostname != _ASSET_HOST or port is not None or parts.username or parts.password:
        return None
    return value


def _local_path(value):
    return value if isinstance(value, str) and value.startswith('/') and '\x00' not in value and len(value) <= 4096 else None


class _Native:
    """One admitted plugin; every call rechecks admission at the plugin host boundary."""

    def __init__(self, ctx, home, plugin):
        self.ctx, self.home, self.plugin = ctx, home, plugin

    def call(self, method, path, query=None, body=None, timeout=10.0):
        payload = b'' if body is None else json.dumps(body).encode()
        result = host._request(self.ctx, self.plugin, dict(
            profile_home=str(self.home), authenticated=True, method=method, path=path,
            query=urllib.parse.urlencode(query or {}), headers={'content-type': 'application/json', 'accept': 'application/json'},
            body=base64.b64encode(payload).decode()), require_panel=False, timeout=timeout)
        try:
            value = json.loads(base64.b64decode(result['body']) or b'null')
        except (ValueError, UnicodeDecodeError):
            value = None
        return result['status'], value if isinstance(value, dict) else {}


def _status_of(native):
    status, body = native.call('GET', '/status')
    settings = body.get('settings') if isinstance(body.get('settings'), dict) else {}
    auto = settings.get('auto_rotate') is not False
    if status != 200:
        return {'availability': 'unavailable', 'message': 'The Meshy plugin did not answer.', 'balance': None, 'auto_rotate': auto}
    if body.get('configured') is not True:
        return {'availability': 'missing_key', 'message': 'Add a Meshy API key in Plugins to see generations and download files.', 'balance': None, 'auto_rotate': auto}
    error = _text(body.get('error'), 160)
    return {'availability': 'unavailable' if error else 'ready', 'message': error, 'balance': _num(body.get('balance')), 'auto_rotate': auto}


def _local(native, limit=200):
    status, body = native.call('GET', '/local', {'limit': limit})
    rows = body.get('files') if status == 200 and isinstance(body.get('files'), list) else []
    out = []
    for row in rows[:200]:
        if not isinstance(row, dict) or not (path := _local_path(row.get('path'))):
            continue
        image = row.get('kind') == 'image'
        images = [p for p in (row.get('images') or [])[:24] if _local_path(p)] if image else []
        out.append({'path': path, 'name': _text(row.get('name'), 200) or Path(path).name, 'kind': 'image' if image else 'model',
                    'task_id': _task(row.get('task')), 'prompt': _text(row.get('prompt')), 'modified': _num(row.get('modified')),
                    'bytes': _int(row.get('bytes')), 'images': images, 'download_incomplete': row.get('download_incomplete') is True})
    return out


def _recent(native):
    status, body = native.call('GET', '/models')
    rows = body.get('models') if status == 200 and isinstance(body.get('models'), list) else []
    out = []
    for row in rows[:60]:
        if not isinstance(row, dict) or not (task := _task(row.get('task_id'))):
            continue
        urls = [u for u in (row.get('image_urls') or [])[:24] if _asset_url(u)]
        out.append({'task_id': task, 'task_type': _text(row.get('task_type'), 40) or '', 'kind': 'image' if row.get('kind') == 'image' else 'model',
                    'prompt': _text(row.get('prompt')), 'created_at': _num(row.get('created_at')), 'credits': _num(row.get('credits')),
                    'thumbnail_url': _asset_url(row.get('thumbnail_url')), 'image_urls': urls, 'expired': row.get('expired') is True,
                    'local_path': _local_path(row.get('local_path'))})
    return out, (None if status == 200 else 'Meshy did not list recent generations.')


def _task_state(task_id, row):
    status = _STATUSES.get(str(row.get('status') or ''), 'unknown')
    return {'task_id': task_id, 'status': status, 'progress': 100 if status == 'succeeded' else _int(row.get('progress'), 0, 100) or 0,
            'terminal': status in _TERMINAL, 'stage': _text(row.get('stage') or row.get('task_type'), 60),
            'error': _text(row.get('error'), 200) if status in ('failed', 'canceled', 'expired') else None}


def _active(native):
    status, body = native.call('GET', '/active')
    rows = body.get('tasks') if status == 200 and isinstance(body.get('tasks'), list) else []
    return [_task_state(task, row) for row in rows[:20] if isinstance(row, dict) and (task := _task(row.get('task_id')))]


def _one_task(native, task_id):
    status, row = native.call('GET', '/task', {'task': task_id})
    if status != 200 or row.get('task') != task_id:
        return None
    return {**_task_state(task_id, {**row, 'stage': row.get('stage')}), 'prompt': _text(row.get('prompt')),
            'thumbnail_url': _asset_url(row.get('thumbnail')), 'credits': _num(row.get('credits')),
            'has_model': row.get('has_model') is True, 'task_type': _text(row.get('type'), 40)}


def _format_label(fmt):
    base, _, clip = fmt.partition(':')
    return base.upper() + (f' · {clip.replace("_", " ")}' if clip else '')


def _draft(row, id_):
    message = _text(row.get('message'), 2000)
    if not message:
        return None
    return {'id': id_, 'label': _text(row.get('label'), 60) or id_, 'cost': _num(row.get('cost')),
            'affordable': row['affordable'] if isinstance(row.get('affordable'), bool) else None, 'draft': message}


def _links(rows):
    return [{'task_id': t, 'tool': _text(r.get('tool'), 60)} for r in (rows or [])[:20] if isinstance(r, dict) and (t := _task(r.get('task_id')))]


def _details(native, task_id, beside):
    query = {'task': task_id, **({'beside': beside} if beside else {})}
    status, formats = native.call('GET', '/formats', query)
    listed = formats.get('formats') if status == 200 and isinstance(formats.get('formats'), list) else []
    out_formats = [{'format': f['format'], 'label': _format_label(f['format']), 'saved': bool(f.get('saved'))}
                   for f in listed[:40] if isinstance(f, dict) and isinstance(f.get('format'), str) and _FORMAT.match(f['format'])]
    conversions = []
    for row in (formats.get('conversions') or [])[:10] if status == 200 else []:
        if isinstance(row, dict) and isinstance(row.get('format'), str) and _FORMAT.match(row['format']):
            draft = _draft({**row, 'label': f'Convert to {row["format"].upper()}'}, 'convert-' + row['format'])
            if draft:
                conversions.append(draft)
    status_a, acts = native.call('GET', '/actions', {'task': task_id})
    actions = [d for row in ((acts.get('actions') or [])[:12] if status_a == 200 else [])
               if isinstance(row, dict) and isinstance(row.get('id'), str) and re.fullmatch(r'[a-z_-]{1,30}', row['id']) and (d := _draft(row, row['id']))]
    status_d, det = native.call('GET', '/details', {'task': task_id})
    provenance = None
    if status_d == 200 and det.get('task') == task_id:
        settings = det.get('settings') if isinstance(det.get('settings'), dict) else {}
        image = _text(det.get('image'), 1024)
        provenance = {
            'prompt': _text(det.get('prompt'), 800), 'prompt_inherited': bool(det.get('prompt_from')),
            'texture_prompt': _text(det.get('texture_prompt'), 800), 'style_prompt': _text(det.get('style_prompt'), 800),
            'negative_prompt': _text(det.get('negative_prompt'), 800),
            # Name the source image only: a local path or a signed URL never leaves the server.
            'source_image': (Path(urllib.parse.urlsplit(image).path).name[:200] or None) if image else None,
            'settings': [{'key': k[:40], 'value': str(v)[:80]} for k, v in list(settings.items())[:20]
                         if isinstance(k, str) and isinstance(v, (str, int, float, bool))],
            'seed': _num(det.get('seed')), 'credits': _num(det.get('credits')), 'created_at': _num(det.get('created_at')),
            'parents': _links(det.get('parents')), 'children': _links(det.get('children')), 'recorded': det.get('recorded') is True}
    balance = _num(acts.get('balance')) if status_a == 200 else None
    return {'task_id': task_id, 'formats': out_formats, 'conversions': conversions, 'actions': actions,
            'provenance': provenance, 'is_preview': formats.get('is_preview') is True}, balance


def _anchor(path: Path, home: Path):
    """The trusted directory a listed file is opened beneath, no-follow: the profile's plugin data, else the user home."""
    for root in (home / 'plugin-data', Path.home()):
        try:
            resolved = root.resolve(strict=True)
        except OSError:
            continue
        if path.is_relative_to(resolved) and path != resolved:
            return resolved
    return None


def _asset(native, home, raw):
    """A file the native inventory lists, refused when any component is a link, it is not regular, or too large."""
    path = _local_path(raw)
    if path is None or Path(path).suffix.lower() not in _MIME:
        return None
    listed = any(row['path'] == path or path in row['images'] for row in _local(native))
    if not listed:
        return None
    try:
        if os.path.realpath(path) != path:
            return None
        st = os.lstat(path)
    except OSError:
        return None
    anchor = _anchor(Path(path), Path(home))
    if anchor is None or not stat.S_ISREG(st.st_mode) or st.st_size > _MAX_FILE or st.st_nlink > 1:
        return None
    return {'path': path, 'anchor': str(anchor), 'mime': _MIME[Path(path).suffix.lower()], 'bytes': st.st_size}


def _saved_names(paths):
    return [Path(p).name[:200] for p in paths[:24] if isinstance(p, str) and p]


def run(ctx, params):
    ctx.check_cancelled()
    action = params.get('action')
    if action not in ('overview', 'card', 'task', 'details', 'save', 'save_images', 'asset'):
        raise InvalidParams('Unknown Meshy action')
    task_id = params.get('task_id')
    if task_id is not None and not _task(task_id):
        raise InvalidParams('Invalid Meshy task id')
    if action in ('task', 'details', 'save', 'save_images') and task_id is None:
        raise InvalidParams('A Meshy task id is required')
    fmt = params.get('format')
    if action == 'save' and (not isinstance(fmt, str) or not _FORMAT.match(fmt)):
        raise InvalidParams('Unknown Meshy format')
    path = params.get('path')
    if path is not None and _local_path(path) is None:
        raise InvalidParams('Invalid Meshy path')
    base = {'availability': 'plugin_unavailable', 'message': None, 'balance': None, 'revision': None}
    if not host._supported():
        return {**base, 'availability': 'agent_incompatible'}
    home = homes.profile_home_param(params)
    with homes.scoped_home(home, load_plugins=False):
        producer = _producer(home)
        plugin = host._named(home, _NAME, require_panel=False) if producer else None
        if plugin is None:
            return {**base, 'asset': None} if action == 'asset' else base
        native = _Native(ctx, home, plugin)
        result = _dispatch(native, home, action, task_id, fmt, path)
        ctx.check_cancelled()
        # Consent or the reviewed revision changed while native code ran: discard what it answered.
        if _producer(home) != producer:
            return {**base, 'asset': None} if action == 'asset' else base
        return {'revision': producer, 'message': None, 'balance': None, **result}


def _dispatch(native, home, action, task_id, fmt, path):
    if action == 'asset':
        # Without a path: only the admission and revision check, for a remote asset grant.
        return {'availability': 'ready', 'asset': _asset(native, home, path) if path else None}
    status = _status_of(native)
    head = {k: status[k] for k in ('availability', 'message', 'balance')}
    configured = status['availability'] != 'missing_key'
    if action == 'overview':
        recent, problem = _recent(native) if configured else ([], None)
        return {**head, 'message': head['message'] or problem, 'auto_rotate': status['auto_rotate'], 'recent': recent,
                'local': _local(native, 100), 'active': _active(native) if configured else []}
    if action == 'card':
        local = [row for row in _local(native) if (path and (row['path'] == path or path in row['images']))
                 or (task_id and row['task_id'] == task_id)]
        return {**head, 'local': local, 'task': _one_task(native, task_id) if task_id and configured else None}
    if action == 'task':
        return {**head, 'task': _one_task(native, task_id) if configured else None}
    if not configured:
        return {**head, 'saved': [], 'complete': False, 'error': head['message']} if action in ('save', 'save_images') else head
    if action == 'details':
        details, balance = _details(native, task_id, path)
        return {**head, 'balance': balance if balance is not None else head['balance'], 'details': details}
    if action == 'save':
        body = {'task': task_id, 'format': fmt, **({'beside': path} if path else {})}
        code, saved = native.call('POST', '/save', body=body, timeout=_SAVE_TIMEOUT)
        if code == 200 and _local_path(saved.get('path')):
            return {**head, 'saved': _saved_names([saved['path']]), 'complete': True, 'error': None}
        return {**head, 'saved': [], 'complete': False, 'error': _SAVE_ERRORS.get(code, 'The download failed. Nothing was overwritten.')}
    code, saved = native.call('POST', '/save-images', body={'task': task_id}, timeout=_SAVE_TIMEOUT)
    if code == 200 and isinstance(saved.get('paths'), list):
        return {**head, 'saved': _saved_names(saved['paths']), 'complete': True, 'error': None}
    # The native writer records each image it finished: report what is on disk, never a whole set.
    done = next((row['images'] for row in _local(native) if row['kind'] == 'image' and row['task_id'] == task_id), [])
    return {**head, 'saved': _saved_names(done), 'complete': False,
            'error': _SAVE_ERRORS.get(code, 'Some images did not download. Retry to resume.')}


def register(registry):
    registry.method('plugins.meshy')(run)
