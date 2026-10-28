"""Profile import adapter. Native planning runs on private snapshots; publication uses anchored descriptors."""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
import hashlib
import json
from itertools import islice
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
import time

from .. import home as homes
from ..errors import InvalidParams, RpcError
from . import config, memory, plugin_catalog

_SOURCES = {'claude-code': ('.claude', 'Claude Code'), 'codex': ('.codex', 'Codex CLI'), 'cursor': ('.cursor', 'Cursor')}
_CREDENTIALS = {'.credentials.json', 'auth.json', 'credentials.json', 'cli-config.json', '.env'}
_TARGETS = ('config.yaml', 'memories', 'skills', 'import-sync.json')
_MEMORY_FILES = {'memories/MEMORY.md', 'memories/USER.md'}
_PREVIEWS = {}
_MAX_FILES = 2048
_MAX_BYTES = 16 * 1024 * 1024
_LEDGER = '.talaria-agent-imports'


def _result(status, *, items=None, stripped=None, receipt=None, sources=None, message=None, can_apply=False, catalog_required=False):
    return dict(status=status, items=items or [], stripped_secrets=stripped or [], receipt=receipt,
                sources=sources or [], message=message, can_apply=can_apply, catalog_required=catalog_required)


@contextmanager
def _directory(path):
    """Open every ancestor without following links; the held descriptor owns all subsequent IO."""
    path = Path(path)
    if not path.is_absolute():
        raise OSError('An absolute directory is required')
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _read(fd, name):
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(child)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > _MAX_BYTES:
            raise OSError('Unsafe or oversized import file')
        with os.fdopen(os.dup(child), 'rb') as stream:
            body = stream.read(_MAX_BYTES + 1)
        after = os.fstat(child)
        if (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise OSError('Import input changed during read')
        return body, (info.st_dev, info.st_ino, info.st_mode, info.st_mtime_ns, info.st_ctime_ns)
    finally:
        os.close(child)


def _snapshot(path, names):
    """Bounded snapshot of only importer inputs. Credential stores are never read."""
    files, identities = {}, {}
    def walk(fd, name, rel):
        try:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if rel.endswith('.lock') and rel[:-5] in _MEMORY_FILES:
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise OSError('Unsafe memory lock')
            return
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                identities[rel] = (info.st_dev, info.st_ino, info.st_mode)
                if len(identities) > _MAX_FILES:
                    raise OSError('Import tree too large')
                with os.scandir(child) as entries:
                    names = [entry.name for entry in islice(entries, _MAX_FILES + 1)]
                if len(names) > _MAX_FILES:
                    raise OSError('Import directory too large')
                for entry in sorted(names):
                    if entry not in _CREDENTIALS and entry not in {'.git', '__pycache__'}:
                        walk(child, entry, rel + '/' + entry)
            finally:
                os.close(child)
        else:
            body, identity = _read(fd, name)
            files[rel], identities[rel] = body, identity
            if len(identities) > _MAX_FILES or sum(map(len, files.values())) > _MAX_BYTES:
                raise OSError('Import tree too large')
    with _directory(path) as fd:
        info = os.fstat(fd)
        identities['.'] = (info.st_dev, info.st_ino, info.st_mode)
        for name in names:
            walk(fd, name, name)
    return files, identities


def _source(agent):
    os_home = Path.home()
    source = os_home / _SOURCES[agent][0]
    names = {'claude-code': ['CLAUDE.md', 'settings.json', 'skills', 'commands'],
             'codex': ['AGENTS.md', 'config.toml', 'memories', 'skills'],
             'cursor': ['AGENTS.md', 'mcp.json', 'rules', 'skills']}[agent]
    files, identity = _snapshot(source, names)
    if agent == 'claude-code':
        extra, extra_identity = _snapshot(os_home, ['.claude.json'])
        files.update({'../' + k: v for k, v in extra.items()})
        identity.update({'../' + k: v for k, v in extra_identity.items()})
    return source, files, identity


def _stamp(snapshot):
    files, identities = snapshot
    return hashlib.sha256(json.dumps([identities, {k: hashlib.sha256(v).hexdigest() for k, v in files.items()}], sort_keys=True).encode()).hexdigest()


def _materialize(root, files, identities):
    root.mkdir()
    for name, info in identities.items():
        if name != '.' and stat.S_ISDIR(info[2]):
            (root / name).mkdir(parents=True, exist_ok=True)
    for name, body in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        path.chmod(stat.S_IMODE(identities[name][2]))


def _project(report):
    # No native reason, path, command, content or arbitrary detail crosses the boundary.
    kinds = {'source': 'Source', 'settings': 'Settings', 'claude-md': 'Claude Code instructions',
             'agents-md': 'Instructions', 'command-allowlist': 'Allowed commands', 'command-denylist': 'Denied commands',
             'mcp-servers': 'MCP servers', 'skills': 'Skills', 'skill': 'Skill', 'memories': 'Memories',
             'rules': 'Cursor rules', 'config': 'Configuration', 'slash-commands': 'Slash commands'}
    statuses = {'imported', 'skipped', 'conflict', 'error'}
    items = report.get('items')
    if not isinstance(items, list) or len(items) > _MAX_FILES:
        raise ValueError('Invalid native report')
    projected = []
    for item in items:
        if not isinstance(item, dict) or item.get('kind') not in kinds or item.get('status') not in statuses:
            raise ValueError('Invalid native disposition')
        projected.append(dict(kind=item['kind'], status=item['status'], label=kinds[item['kind']]))
    stripped = report.get('stripped_secrets', [])
    if not isinstance(stripped, list) or len(stripped) > _MAX_FILES:
        raise ValueError('Invalid stripped-secret names')
    return projected, [name for name in stripped if isinstance(name, str) and len(name) <= 200
                       and re.fullmatch(r'[A-Za-z0-9_.-]+', name)]


@contextmanager
def _parent(root_fd, rel, create=False):
    parts = Path(rel).parts
    if not parts or any(p in ('.', '..') for p in parts) or Path(rel).is_absolute():
        raise OSError('Unsafe output path')
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd, parts[-1]
    finally:
        os.close(fd)


def _write(root_fd, rel, body, *, exclusive=False, mode=0o600, expected=None):
    with _parent(root_fd, rel, create=True) as (fd, name):
        tmp = '.import-' + secrets.token_hex(16)
        child = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            with os.fdopen(child, 'wb') as stream:
                os.fchmod(stream.fileno(), stat.S_IMODE(mode) & 0o777)
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
            guard = memory.file_lock(Path(name), parent_fd=fd) if rel in _MEMORY_FILES else nullcontext()
            with guard:
                if expected is not None and _read(fd, name) != expected:
                    raise OSError('Import destination changed during publication')
                if exclusive:
                    os.link(tmp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                else:
                    # Replacing a link cannot follow it. Never mutate the old inode in place.
                    os.rename(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
                os.fsync(fd)
        finally:
            try:
                os.unlink(tmp, dir_fd=fd)
            except FileNotFoundError:
                pass


def _ledger(root_fd, token, result=None):
    name = _LEDGER + '/' + hashlib.sha256(token.encode()).hexdigest() + '.json'
    if result is not None:
        _write(root_fd, name, json.dumps(result).encode())
        return result
    try:
        with _parent(root_fd, name) as (fd, leaf):
            return json.loads(_read(fd, leaf)[0])
    except FileNotFoundError:
        return None


def _refresh_runtime(home):
    from .commands import _reload_mcp, _reload_skills
    try:
        with homes.scoped_home(home, load_plugins=False):
            _reload_skills()
            _reload_mcp(log_errors=False)
        return True
    except Exception:
        return False


def run(ctx, params):
    action, agent, token = params.get('action'), params.get('agent'), params.get('receipt')
    if action not in ('discover', 'preview', 'apply', 'result') or action == 'preview' and agent not in _SOURCES or action in ('apply', 'result') and (not isinstance(token, str) or not 0 < len(token) <= 128):
        raise InvalidParams('Invalid profile import request')
    home = homes.profile_home_param(params)
    with homes.scoped_home(home, load_plugins=False, read_only=True), plugin_catalog._lock:
        try:
            with _directory(home) as root_fd:
                # Read the durable consumption record before plugin/source checks. A retry is readback only.
                if action in ('apply', 'result'):
                    previous = _ledger(root_fd, token)
                    if previous is not None:
                        if 'expected' in previous:
                            files, _ = _snapshot(home, _TARGETS)
                            if all(name in files and hashlib.sha256(files[name]).hexdigest() == digest for name, digest in previous['expected'].items()):
                                return _ledger(root_fd, token, previous['confirmed'])
                            return previous['result']
                        return previous
                    if action == 'result':
                        # Fence a late apply that never reached the consumption record.
                        _PREVIEWS.pop(token, None)
                        return _result('changed', message='No import was confirmed. Preview again.')
                try:
                    config.assert_config_writable(home)
                except RpcError:
                    return _result('unavailable', message='Profile configuration is managed or its write policy cannot be verified. Import is unavailable.')
                native = plugin_catalog.reviewed_importer(home)
                if native is None:
                    return _result('unavailable', message='Install and enable Agent Importers from the plugin catalog.', catalog_required=True)
                importer, sync, plugin = native
                if action == 'discover':
                    sources = []
                    for name, (_, label) in _SOURCES.items():
                        try:
                            _source(name)
                            sources.append(dict(agent=name, label=label))
                        except OSError:
                            pass
                    return _result('available', sources=sources)
                now = time.monotonic()
                for old in list(_PREVIEWS):
                    if _PREVIEWS[old]['expires'] <= now:
                        del _PREVIEWS[old]
                receipt = _PREVIEWS.get(token) if action == 'apply' else None
                if action == 'apply' and (receipt is None or receipt['home'] != str(home)):
                    return _result('changed', message='Preview expired or belongs to another profile. Preview again.')
                agent = receipt['agent'] if receipt else agent
                source, source_files, source_identity = _source(agent)
                if home == source or home in source.parents or source in home.parents:
                    raise OSError('Source overlaps the active profile')
                target = _snapshot(home, _TARGETS)
                identity = [str(home), str(source), plugin, _stamp((source_files, source_identity)), _stamp(target)]
                if receipt and receipt['identity'] != identity:
                    return _result('changed', message='Source, profile or plugin changed. Preview again.')
                if ctx is not None:
                    ctx.check_cancelled()
                # Private temporary copies isolate the native path-based API from hostile path replacement.
                with tempfile.TemporaryDirectory(prefix='talaria-import-') as temp:
                    stage_source, stage_target = Path(temp).resolve() / 'source', Path(temp).resolve() / 'target'
                    _materialize(stage_source, source_files, source_identity)
                    _materialize(stage_target, *target)
                    report = importer(agent, stage_source, stage_target, execute=False, overwrite=False).run()
                    items, stripped = _project(report)
                    plan = json.dumps([items, stripped], sort_keys=True)
                    if receipt and plan != receipt['plan']:
                        return _result('changed', message='Import plan changed. Preview again.')
                    if action == 'preview':
                        if not any(i['status'] == 'imported' for i in items):
                            return _result('preview', items=items, stripped=stripped)
                        token = secrets.token_urlsafe(32)
                        if len(_PREVIEWS) >= 64:
                            del _PREVIEWS[next(iter(_PREVIEWS))]
                        _PREVIEWS[token] = dict(home=str(home), agent=agent, identity=identity, plan=plan, expires=now + 300)
                        return _result('preview', items=items, stripped=stripped, receipt=token,
                                       can_apply=any(i['status'] == 'imported' for i in items))
                    del _PREVIEWS[token]
                    unknown = _result('unknown', message='Import outcome is unknown. Check the profile before starting a new preview.')
                    # Fsync the consumed record before any native write. Restart or cancellation cannot replay it.
                    _ledger(root_fd, token, unknown)
                    try:
                        report = importer(agent, stage_source, stage_target, execute=True, overwrite=False).run()
                        items, stripped = _project(report)
                        sync.update_sync_manifest(agent, stage_source, stage_target, False, report,
                                                  refresh_digest=not any(i['status'] == 'error' for i in items))
                        manifest_path = stage_target / 'import-sync.json'
                        manifest = json.loads(manifest_path.read_text())
                        manifest['agents'][agent]['source'] = str(source)
                        manifest_path.write_text(json.dumps(manifest))
                        config.assert_config_writable(home)
                        output, output_identity = _snapshot(stage_target, _TARGETS)
                        # Check original objects again before publication; no write resolves a client/native path.
                        fresh_source = _source(agent)
                        if (plugin_catalog.reviewed_importer(home)[2] != plugin
                                or _stamp(fresh_source[1:]) != identity[3] or _stamp(_snapshot(home, _TARGETS)) != identity[4]):
                            return _ledger(root_fd, token, _result('changed', message='Import inputs changed before publication. Preview again.'))
                        result = _result('partial' if any(i['status'] == 'error' for i in items) else 'applied', items=items, stripped=stripped)
                        result['message'] = 'Files imported. Reload Skills and MCP before using the imported setup.'
                        _ledger(root_fd, token, dict(result=unknown, expected={k: hashlib.sha256(v).hexdigest() for k, v in output.items()}, confirmed=result))
                        for rel, body in output.items():
                            if target[0].get(rel) != body:
                                _write(root_fd, rel, body, exclusive=rel not in target[0], mode=output_identity[rel][2], expected=(target[0][rel], target[1][rel]) if rel in target[0] else None)
                        result = _result('partial' if any(i['status'] == 'error' for i in items) else 'applied', items=items, stripped=stripped)
                        if not _refresh_runtime(home):
                            result['message'] = 'Files imported. Reload Skills and MCP before using the imported setup.'
                        return _ledger(root_fd, token, result)
                    except Exception:
                        # Exceptions may include secret values. The durable unknown record is the only public result.
                        return unknown
        except (OSError, ValueError, TypeError, KeyError):
            return _result('unknown' if action == 'result' else 'changed' if action == 'apply' else 'unavailable', message='Import paths or state are unsafe, unavailable or changed. Check the profile before continuing.')


def register(registry):
    registry.method('profiles.import')(run)
