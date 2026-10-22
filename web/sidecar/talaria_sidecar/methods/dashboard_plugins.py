"""Agent-owned dashboard discovery, consent and buffered HTTP. Never imports plugin code here."""
from __future__ import annotations

import base64
import inspect
import json
import os
import re
import stat
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


def _path(raw):
    if not isinstance(raw, str) or not raw or len(raw) > 512 or re.search(r'[\s\\?#\x00-\x1f]', raw):
        return None
    # No encoded path components: the caller decodes once before this trust boundary.
    if '%' in raw or any(not p or p.startswith('.') for p in raw.split('/')):
        return None
    return raw


def _read(root: Path, rel: str, limit=_MAX_ASSET):
    """Open each component beneath the discovered dashboard without following symlinks."""
    if not _path(rel) or root.is_symlink() or root.parent.is_symlink():
        return None
    fd = None
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        parts = rel.split('/')
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
        root = Path(plugin['_dir'])
        raw = _read(root, 'manifest.json', 64 * 1024)
        try:
            manifest = json.loads(raw) if raw else {}
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(manifest, dict):
            continue
        # The existing Web protocol's panel opt-in distinguishes Web documents from native Desktop SDK bundles.
        panel = manifest.get('panel')
        compatible = isinstance(panel, str) and len(panel) <= 256 and _path(panel) and panel.startswith(('dist/', 'static/')) and panel.endswith('.html')
        out.append({**plugin, 'panel': panel if compatible else None,
                    'enabled': _plugin_api_mount_skip_reason(plugin, enabled, disabled) is None})
    return out


def _named(home, name):
    return next((p for p in _plugins(home) if p['name'] == name and p['enabled'] and p['panel']), None)


def _reply(status=404, body=b'', content_type='application/octet-stream'):
    return {'status': status, 'body': base64.b64encode(body).decode('ascii'), 'content_type': content_type}


def _request(ctx, plugin, params):
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
    if not isinstance(api, str) or not _path(api) or _read(Path(plugin['_dir']), api) is None:
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
    try:
        result = get_plugin_manager()._plugin_host().asgi_request(
            plugin['name'], plugin['_dir'], api, method, path, query, headers, body,
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
    if _named(homes.profile_home_param(params), plugin['name']) is None:
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
            body = _read(Path(plugin['_dir']), path) if content_type else None
            ctx.check_cancelled()
            return _reply(200, body, content_type) if body is not None else _reply()

    for action in ('list', 'toggle', 'asset', 'request'):
        def handler(ctx, params, action=action):
            return run(ctx, params, action)
        registry.method(f'plugins.dashboard_{action}')(handler)
