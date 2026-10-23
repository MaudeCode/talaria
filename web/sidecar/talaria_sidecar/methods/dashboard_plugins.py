"""Agent-owned dashboard discovery, consent and buffered HTTP. Never imports plugin code here."""
from __future__ import annotations

import base64
import hashlib
import inspect
import json
import os
import re
import stat
import tempfile
import threading
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

from .. import home as homes
from ..errors import InvalidParams, RpcError

_NAME = re.compile(r'^[a-z][a-z0-9_-]{0,63}$')
_MIME = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
         '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
         '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
         '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
         '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8'}
# An allowlist, rather than a denylist, keeps current and future gateway/Talaria credentials out.
_HEADERS = {'accept', 'content-type', 'if-none-match', 'if-modified-since'}
_QUERY_CREDENTIALS = {'token', 'ticket', 'internal', 'display_ticket', 'attach', 'profile', 'native_dial', 'api_key', 'access_token'}
_MAX_ASSET = 8 * 1024 * 1024
_MAX_API = 512 * 1024
# Resolve only the operator-selected launch home, never a plugin-controlled descendant.
_RAW_BASE_HOME = homes._PROCESS_HOME.parent.parent if homes._PROCESS_HOME.parent.name == 'profiles' else homes._PROCESS_HOME
_BASE_HOME = _RAW_BASE_HOME.resolve()
_SOURCE_LOCK = threading.Lock()
_SOURCE_DIRECTORY = None
_SOURCES = {}
_SOURCE_BYTES = 0
_SOURCE_CLOSED = False
_MAX_SOURCE_BYTES = 64 * 1024 * 1024


def close_dashboard_sources():
    """Release the native loader's source cache after the RPC server has stopped admitting calls."""
    global _SOURCE_DIRECTORY, _SOURCE_BYTES, _SOURCE_CLOSED
    with _SOURCE_LOCK:
        _SOURCE_CLOSED = True
        if _SOURCE_DIRECTORY is not None:
            _SOURCE_DIRECTORY.cleanup()
            _SOURCE_DIRECTORY = None
        _SOURCES.clear()
        _SOURCE_BYTES = 0


def _api_source(root, api, source):
    """Give the unchanged native loader a private, stable copy of the bytes we verified.

    Preserve the plugin module's original location for relative resources and tracebacks.
    Content-addressing reuses its cached app; retain files through timeouts/late host work,
    bounded by count/bytes and owned by the sidecar until shutdown.
    """
    global _SOURCE_DIRECTORY, _SOURCE_BYTES
    origin = str(Path(root) / api)
    key = hashlib.sha256(os.fsencode(origin) + b'\0' + source).hexdigest()
    with _SOURCE_LOCK:
        if _SOURCE_CLOSED:
            raise RpcError('Agent dashboard source cache is shutting down', condition='plugin_host_unavailable')
        if key in _SOURCES:
            return _SOURCES[key]
        payload = (f'__talaria_source__ = {source!r}\n'
                   f'__file__ = {origin!r}\n'
                   "__loader__ = __import__('importlib.machinery', fromlist=['SourceFileLoader']).SourceFileLoader(__name__, __file__)\n"
                   "__cached__ = __import__('importlib.util', fromlist=['cache_from_source']).cache_from_source(__file__)\n"
                   "if __spec__ is not None:\n    __spec__.origin = __file__\n    __spec__.loader = __loader__\n    __spec__.cached = __cached__\n"
                   "exec(compile(globals().pop('__talaria_source__'), __file__, 'exec'), globals())\n").encode()
        if len(_SOURCES) >= 512 or _SOURCE_BYTES + len(payload) > _MAX_SOURCE_BYTES:
            raise RpcError('Agent dashboard source cache is full', condition='plugin_host_unavailable')
        path = None
        try:
            if _SOURCE_DIRECTORY is None:
                _SOURCE_DIRECTORY = tempfile.TemporaryDirectory(prefix='talaria-dashboard-source-')
            path = Path(_SOURCE_DIRECTORY.name) / f'{key}.py'
            with path.open('xb') as file:
                file.write(payload)
            path.chmod(0o400)
        except OSError as exc:
            if path is not None:
                path.unlink(missing_ok=True)
            raise RpcError('Agent dashboard source unavailable', condition='plugin_host_unavailable') from exc
        _SOURCES[key] = (str(path.parent), path.name)
        _SOURCE_BYTES += len(payload)
        return _SOURCES[key]


def _path(raw):
    if not isinstance(raw, str) or not raw or len(raw) > 512 or re.search(r'[\s\\?#\x00-\x1f]', raw):
        return None
    # No encoded path components: the caller decodes once before this trust boundary.
    if '%' in raw or any(not p or p.startswith('.') for p in raw.split('/')):
        return None
    return raw


def _asset_root(plugin, home):
    root = Path(plugin['_dir'])
    if plugin.get('source') == 'user':
        allowed = {Path(home) / 'plugins', _RAW_BASE_HOME / 'plugins', _BASE_HOME / 'plugins'}
        if root.parent.parent not in allowed:
            return None
        for base in (_RAW_BASE_HOME, _BASE_HOME):
            try:
                relative = root.relative_to(base)
            except ValueError:
                continue
            return _BASE_HOME / relative, _BASE_HOME
        return None
    from hermes_cli.plugins import get_bundled_plugins_dir
    bundled = Path(get_bundled_plugins_dir())
    if root.parent.parent not in {bundled, bundled / 'memory'}:
        return None
    # The Agent source is trusted; its plugins directory and every descendant are still opened no-follow.
    anchor = bundled.parent.resolve()
    return anchor / root.relative_to(bundled.parent), anchor


def _read(root: Path, rel: str, limit=_MAX_ASSET, *, anchor: Path):
    """Open from the trusted home/source, rejecting symlinks in every root and asset component."""
    if not _path(rel):
        return None
    fd = None
    try:
        relative = root.relative_to(anchor)
        if any(part == '..' for part in relative.parts):
            return None
        # Even an ancestor replaced after anchor canonicalization cannot redirect this traversal.
        parts = [*anchor.parts[1:], *relative.parts, *rel.split('/')]
        fd = os.open(anchor.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for i, part in enumerate(parts):
            child = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                            (os.O_DIRECTORY if i < len(parts) - 1 else 0), dir_fd=fd)
            os.close(fd)
            fd = child
        if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_size > limit:
            return None
        with os.fdopen(fd, 'rb') as file:
            fd = None
            body = file.read(limit + 1)
        return body if len(body) <= limit else None
    except (OSError, ValueError):
        return None
    finally:
        if fd is not None:
            os.close(fd)


def _supported():
    if not getattr(os, 'O_NOFOLLOW', 0) or os.open not in os.supports_dir_fd:
        return False
    try:
        from hermes_cli.plugin_host import PluginHost
        from hermes_cli.web_server_plugin_profiles import _scan_profile_plugins  # noqa: F401
        return 'authenticated' in inspect.signature(PluginHost.asgi_request).parameters
    except (ImportError, AttributeError, ValueError):
        return False


def _plugins(home):
    from hermes_cli.web_server_plugin_profiles import _scan_profile_plugins
    from hermes_cli.web_server_dashboard import _plugin_api_mount_skip_reason, _plugin_enable_sets_here
    enabled, disabled = _plugin_enable_sets_here()
    out = []
    for plugin in _scan_profile_plugins(home):
        name = plugin.get('name')
        if not isinstance(name, str) or not _NAME.fullmatch(name) or plugin.get('source') not in ('user', 'bundled'):
            continue
        located = _asset_root(plugin, home)
        if located is None:
            continue
        root, anchor = located
        raw = _read(root, 'manifest.json', 64 * 1024, anchor=anchor)
        try:
            manifest = json.loads(raw) if raw else {}
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(manifest, dict):
            continue
        # The existing Web protocol's panel opt-in distinguishes Web documents from native Desktop SDK bundles.
        panel = manifest.get('panel')
        compatible = isinstance(panel, str) and len(panel) <= 256 and _path(panel) and panel.startswith(('dist/', 'static/')) and panel.endswith('.html')
        out.append({**plugin, '_dir': str(root), '_asset_anchor': str(anchor), 'panel': panel if compatible else None,
                    'enabled': _plugin_api_mount_skip_reason(plugin, enabled, disabled) is None})
    return out


def _named(home, name, *, require_panel=True):
    return next((p for p in _plugins(home) if p['name'] == name and p['enabled'] and (p['panel'] if require_panel else p.get('_api_file'))), None)


def _reply(status=404, body=b'', content_type='application/octet-stream'):
    return {'status': status, 'body': base64.b64encode(body).decode('ascii'), 'content_type': content_type}


def _request(ctx, plugin, params, *, require_panel=True):
    ctx.check_cancelled()
    if params.get('authenticated') is not True:
        return _reply()
    path = params.get('path', '')
    rel = path.lstrip('/')
    if path != '/' and (_path(rel) is None or path != '/' + rel):
        return _reply()
    headers = [(k.lower(), str(v)) for k, v in params.get('headers', {}).items() if k.lower() in _HEADERS]
    if params.get('websocket') or any(k == 'accept' and 'text/event-stream' in v.lower() for k, v in headers):
        return _reply(501, b'Agent plugin host supports buffered HTTP only', 'text/plain; charset=utf-8')
    api = plugin.get('_api_file')
    if not isinstance(api, str) or not _path(api):
        return _reply()
    source = _read(Path(plugin['_dir']), api, anchor=Path(plugin['_asset_anchor']))
    if source is None:
        return _reply()
    from hermes_cli.plugins import get_plugin_manager
    body = base64.b64decode(params.get('body') or '', validate=True)
    if len(body) > _MAX_API:
        return _reply(413)
    query = urlencode([(k, v) for k, v in parse_qsl(params.get('query', ''), keep_blank_values=True)
                       if k.lower() not in _QUERY_CREDENTIALS])
    method = params.get('method', 'GET')
    if method not in {'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'}:
        raise InvalidParams('Unsupported plugin HTTP method')
    root, snapshot_api = _api_source(plugin['_dir'], api, source)
    ctx.check_cancelled()
    try:
        result = get_plugin_manager()._plugin_host().asgi_request(
            plugin['name'], root, snapshot_api, method, path, query, headers, body,
            timeout=10.0, authenticated=True)
    except TimeoutError:
        ctx.check_cancelled()
        return _reply(504)
    except Exception as exc:
        # Third-party errors may contain credentials or file paths.
        raise RpcError('Agent plugin request failed', condition='plugin_host_unavailable') from exc
    ctx.check_cancelled()
    content_type = next((v for k, v in result.get('headers', []) if k.lower() == 'content-type'), 'application/octet-stream')
    if 'text/event-stream' in content_type.lower():
        return _reply(501, b'Agent plugin host supports buffered HTTP only', 'text/plain; charset=utf-8')
    if _named(homes.profile_home_param(params), plugin['name'], require_panel=require_panel) is None:
        return _reply()
    raw = result.get('body', b'')
    if not isinstance(raw, bytes) or len(raw) > _MAX_API:
        return _reply(502)
    status = result.get('status', 502)
    return _reply(status if isinstance(status, int) and 200 <= status <= 599 else 502, raw, content_type)


def register(registry):
    def run(ctx, params, action):
        ctx.check_cancelled()
        if not _supported():
            if action == 'list':
                return {'supported': False, 'plugins': []}
            if action == 'toggle':
                raise RpcError('Agent dashboard host unsupported', condition='agent_incompatible')
            return _reply(501)
        home = homes.profile_home_param(params)
        with homes.scoped_home(home, load_plugins=False):
            if action == 'list':
                return {'supported': True, 'plugins': [
                    {'name': p['name'], 'label': str(p.get('label') or p['name'])[:80],
                     'version': str(p.get('version') or '')[:40], 'description': str(p.get('description') or '')[:300],
                     'enabled': p['enabled'], 'panel': p['panel'], 'has_api': bool(p.get('_api_file'))}
                    for p in _plugins(home)]}
            name = params.get('name')
            if not isinstance(name, str) or not _NAME.fullmatch(name):
                if action == 'toggle':
                    raise InvalidParams('Unknown Web dashboard plugin')
                return _reply()
            if action == 'toggle':
                plugin = next((p for p in _plugins(home) if p['name'] == name and p['panel']), None)
                if plugin is None or not isinstance(params.get('enabled'), bool):
                    raise InvalidParams('Unknown Web dashboard plugin or invalid enablement')
                from hermes_cli.plugins_cmd import _activate_key, _resolve_plugin_key
                key = _resolve_plugin_key(name)
                if key is None:
                    raise InvalidParams('Plugin is not installed')
                # Use the Agent admission transaction, without activate_plugin_now (in-process imports).
                _activate_key(key, enable=params['enabled'])
                return {'ok': True}
            plugin = _named(home, name)
            if plugin is None:
                return _reply()
            if action == 'request':
                return _request(ctx, plugin, params)
            path = params.get('path', '')
            if not isinstance(path, str) or not path.startswith(('dist/', 'static/')):
                return _reply()
            content_type = _MIME.get(Path(path).suffix.lower())
            body = _read(Path(plugin['_dir']), path, anchor=Path(plugin['_asset_anchor'])) if content_type else None
            ctx.check_cancelled()
            return _reply(200, body, content_type) if body is not None else _reply()

    for action in ('list', 'toggle', 'asset', 'request'):
        def handler(ctx, params, action=action):
            return run(ctx, params, action)
        registry.method(f'plugins.dashboard_{action}')(handler)
