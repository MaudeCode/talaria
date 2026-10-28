"""Reviewed Agent catalog and disabled installs. Agent owns cache, scan and publication."""
from __future__ import annotations

import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time

from ..errors import InvalidParams, RpcError

_receipts: dict[str, dict] = {}
_lock = threading.Lock()


def _agent():
    try:
        from hermes_cli import plugin_catalog as source, plugins_cmd as pc, plugins_cmd_catalog as native
        if 'before_swap' not in inspect.signature(native.install_catalog_entry).parameters:
            return None
        return source, pc, native
    except (ImportError, AttributeError):
        return None


def _refusal(entry, pc, native, *, removed_entries=None):
    try:
        if removed_entries is None:
            native.raise_if_removed(entry.name, entry.repo)
        else:
            from hermes_cli.plugin_catalog import match_removed
            if any(match_removed(value, removed_entries) for value in (entry.name, entry.repo)):
                return 'This plugin was removed from the catalog.'
        native._refuse_unsupported_catalog_platform(entry)
        from hermes_cli.plugins_manifest import requires_hermes_error
        reason = requires_hermes_error({'requires_hermes': entry.requires_hermes})
        if reason:
            return reason
        if not re.fullmatch(r'[a-f0-9]{40}', entry.sha):
            return 'The catalog has no immutable reviewed pin.'
    except pc.PluginOperationError as exc:
        return str(exc)
    return None


def _requirements(entry):
    caps = entry.capabilities
    values = []
    for label, items in [('Hermes', [entry.requires_hermes] if entry.requires_hermes else []),
                         ('Platforms', entry.platforms), ('Environment', caps.requires_env),
                         ('Tools', caps.provides_tools), ('Hooks', caps.provides_hooks),
                         ('Middleware', caps.provides_middleware)]:
        if items:
            values.append(f'{label}: {", ".join(items)}')
    return values + list(entry.known_issues)


def catalog(query='', offset=0, limit=20):
    if not isinstance(query, str) or len(query) > 200 or type(offset) is not int or not 0 <= offset <= 10000 or type(limit) is not int or not 1 <= limit <= 50:
        raise InvalidParams('Invalid catalog search or page')
    agent = _agent()
    if agent is None:
        return {'supported': False, 'entries': [], 'total': 0, 'next_offset': None}
    source, pc, native = agent
    # Read authoritative installer metadata only. Native discovery may load plugins or adopt old records.
    metadata = pc._read_install_metadata()
    rows = []
    for entry in sorted(source.load_catalog_live(), key=lambda e: e.name)[:10000]:
        if query.casefold() not in ' '.join([entry.name, entry.description, entry.tier, entry.category]).casefold():
            continue
        matches = [(key, record) for key, record in metadata.items() if isinstance(record, dict)
                   and isinstance(record.get('catalog'), dict) and record['catalog'].get('name') == entry.name
                   and (pc._plugins_dir() / key).is_dir()]
        key, record = matches[0] if len(matches) == 1 else (None, {})
        refusal = _refusal(entry, pc, native)
        rows.append({'name': entry.name, 'title': entry.title or entry.name, 'description': entry.description,
                     'repo': entry.repo, 'sha': entry.sha, 'tier': entry.tier, 'category': entry.category,
                     'requirements': _requirements(entry), 'installed_key': key,
                     'installed_sha': str(record.get('revision') or '') or None,
                     'can_install': not matches and refusal is None, 'refusal': refusal})
    end = offset + limit
    return {'supported': True, 'entries': rows[offset:end], 'total': len(rows), 'next_offset': end if end < len(rows) else None}


def _tree_digest(tree):
    # Git's mutable clone metadata is not part of the code being reviewed.
    digest = hashlib.sha256()
    count = total = 0
    for root, dirs, files in os.walk(tree, followlinks=False):
        base = Path(root)
        links = [name for name in dirs if (base / name).is_symlink()]
        dirs[:] = sorted(name for name in dirs if name not in {'.git', '__pycache__'} and name not in links)
        for name in sorted(files + links):
            path = base / name
            info = path.lstat()
            count += 1
            total += info.st_size
            if count > 10000 or total > 64 * 1024 * 1024:
                raise RpcError('The plugin tree exceeds the bounded review size.', condition='plugin_install_refused')
            digest.update(json.dumps([str(path.relative_to(tree)), info.st_mode, info.st_size]).encode() + b'\0')
            if path.is_symlink():
                digest.update(os.readlink(path).encode())
            else:
                with path.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
    return digest.hexdigest()


def install(name, consent_token=None):
    if not isinstance(name, str) or not re.fullmatch(r'[a-z0-9_-]{1,64}', name) or consent_token is not None and not isinstance(consent_token, str):
        raise InvalidParams('Choose a catalog name, without a URL or ref override')
    agent = _agent()
    if agent is None:
        raise RpcError('This Agent cannot install reviewed catalog plugins', condition='plugin_catalog_unsupported')
    source, pc, native = agent
    from hermes_constants import get_hermes_home
    from pm.plugin_declarations import read_python_declaration
    from pm.workspace import enabled_plugin_dirs
    from hermes_cli.plugin_capabilities import VALID_CAPABILITY_IDS

    with _lock:
        now = time.monotonic()
        for token in list(_receipts):
            if _receipts[token]['expires'] <= now:
                del _receipts[token]
        receipt = _receipts.pop(consent_token, None) if consent_token else None
    changed = 'Plugin confirmation expired or changed; review the plugin again.'
    def refuse_changed():
        raise RpcError(changed, condition='plugin_install_consent_changed')
    if consent_token and receipt is None:
        refuse_changed()
    entry = next((e for e in source.load_catalog_live() if e.name == name), None)
    if entry is None:
        raise RpcError('This plugin is no longer in the catalog', condition='plugin_install_refused')
    identity = [str(get_hermes_home().resolve()), entry.to_dict()]
    if receipt and receipt['identity'] != identity:
        refuse_changed()
    refusal = _refusal(entry, pc, native)
    if refusal:
        return {'name': name, 'status': 'blocked', 'findings': refusal}
    preview = {}
    findings = ''

    class ReviewNeeded(Exception):
        pass

    def check_tree(manifest, tree):
        nonlocal preview, findings
        key = manifest.get('name')
        if not isinstance(key, str) or not key:
            raise pc.PluginOperationError('The plugin needs an explicit manifest name for reviewed installation.')
        target = pc._sanitize_plugin_name(key, pc._plugins_dir())
        if target.exists() or target.is_symlink():
            raise pc.PluginOperationError('This plugin is already installed; use its existing controls.')
        if target.resolve() in enabled_plugin_dirs(installing=target):
            raise pc.PluginOperationError('This plugin is already selected in the profile. Review that selection before installing.')
        from hermes_cli.plugins_manifest import requires_hermes_error
        reason = requires_hermes_error(manifest)
        if reason:
            raise pc.PluginOperationError(reason)
        raw_caps = manifest.get('capabilities') or []
        if not isinstance(raw_caps, list) or any(not isinstance(c, str) or c not in VALID_CAPABILITY_IDS for c in raw_caps):
            raise pc.PluginOperationError('The plugin declares capabilities this Agent cannot verify.')
        deps = list(read_python_declaration(tree).install_requirements)
        preview = {'tree': _tree_digest(tree), 'key': key, 'dependencies': deps, 'capabilities': raw_caps}
        findings = '\n'.join([f'{entry.name} · {entry.tier} · {entry.sha}', entry.repo, *_requirements(entry),
                              *([f'Python dependencies, not approved: {", ".join(deps)}'] if deps else []),
                              *([f'Host capabilities, not granted: {", ".join(raw_caps)}'] if raw_caps else []),
                              'Installs disabled. No dependency, host capability or sidecar permission is granted.',
                              'Native Desktop contributions are unverified and do not run in Talaria.'])
        if not receipt:
            raise ReviewNeeded()
        if receipt['preview'] != preview:
            refuse_changed()
        # Revalidate removal/repin immediately before the native scan/publication path.
        current = next((e for e in source.load_catalog_live() if e.name == name), None)
        if current is None or current.to_dict() != entry.to_dict():
            refuse_changed()
        native.raise_if_removed(entry.name, entry.repo)
        return []

    try:
        # Same native core as dashboard_install_plugin(enable=False), with its staging hook binding review.
        target, _manifest, key = native.install_catalog_entry(entry, force=False, ref=entry.sha,
            allow_removed=False, assume_deps_consent=False, before_swap=check_tree)
        return {'name': name, 'key': key, 'status': 'installed', 'enabled': False}
    except ReviewNeeded:
        pass
    except pc.PluginScanBlocked as exc:
        return {'name': name, 'status': 'blocked', 'findings': str(exc)}
    except pc.PluginOperationError as exc:
        return {'name': name, 'status': 'blocked', 'findings': str(exc)}
    token = secrets.token_urlsafe(32)
    with _lock:
        if len(_receipts) >= 64:
            del _receipts[next(iter(_receipts))]
        _receipts[token] = {'identity': identity, 'preview': preview, 'expires': time.monotonic() + 300}
    return {'name': name, 'status': 'needs_consent', 'findings': findings, 'consent_token': token}


def reviewed_importer(home):
    """Load only attested native structured APIs, sharing catalog identity and enablement policy."""
    import sys
    import types
    from . import dashboard_plugins
    reviewed = json.loads((Path(__file__).parents[2] / 'agent_importer.json').read_text())
    pin, hashes = reviewed['revision'], reviewed['files']
    agent = _agent()
    if agent is None or not dashboard_plugins._supported():
        return None
    source, pc, native = agent
    try:
        from pm.workspace import enabled_plugin_dirs
        from hermes_cli.web_server_dashboard import _plugin_enable_sets_here
        enabled, disabled = _plugin_enable_sets_here()
        if not (Path(home) / 'plugins').is_dir():
            return None
        metadata = pc._read_install_metadata()
        matches = [(key, record) for key, record in metadata.items() if isinstance(record, dict)
                   and isinstance(record.get('catalog'), dict) and record['catalog'].get('name') == 'agent-importers']
        if len(matches) != 1:
            return None
        key, record = matches[0]
        root = pc._sanitize_plugin_name(key, Path(home) / 'plugins')
        # Admission must not fetch or populate the profile's live catalog cache on a preview.
        entry = next((e for e in source.load_catalog() if e.name == 'agent-importers'), None)
        cached = dashboard_plugins._read(Path(home), 'cache/plugin-catalog.json', 4 * 1024 * 1024, anchor=Path(home))
        if cached is None and ((Path(home) / 'cache/plugin-catalog.json').exists() or (Path(home) / 'cache/plugin-catalog.json').is_symlink()):
            return None
        cached = json.loads(cached) if cached is not None else {}
        if not isinstance(cached, dict) or not isinstance(cached.get('entries', []), list):
            return None
        if any(e.get('name') == 'agent-importers' and e.get('sha') != pin for e in cached.get('entries', []) if isinstance(e, dict)):
            return None
        removed = source.load_removed_list() + source._removed_from_list(cached.get('removed'))
        if (entry is None or entry.sha != pin or _refusal(entry, pc, native, removed_entries=removed)
                or record.get('revision') != pin or record['catalog'].get('sha') != pin
                or record['catalog'].get('repo') != entry.repo
                or key not in enabled or key in disabled or root.resolve() not in {p.resolve() for p in enabled_plugin_dirs()}):
            return None
        bodies = {name: dashboard_plugins._read(root, name, anchor=Path(home)) for name in hashes}
        if any(body is None or hashlib.sha256(body).hexdigest() != hashes[name] for name, body in bodies.items()):
            return None
        # Compile verified bytes, never re-open a mutable plugin path or execute its entry point.
        package = '_talaria_reviewed_agent_importers'
        if package not in sys.modules:
            module = types.ModuleType(package)
            module.__path__ = []
            sys.modules[package] = module
            for name in ('importer', 'sync'):
                module = types.ModuleType(f'{package}.{name}')
                module.__package__ = package
                sys.modules[module.__name__] = module
                exec(compile(bodies[name + '.py'], f'<reviewed-agent-importers/{name}.py>', 'exec'), module.__dict__)
        return sys.modules[package + '.importer'].AgentImporter, sys.modules[package + '.sync'], [pin, str(root), _tree_digest(root)]
    except (ImportError, AttributeError, OSError, ValueError, TypeError, RpcError):
        return None
