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
import sqlite3
import stat
import tempfile
import time

from .. import home as homes
from ..errors import InvalidParams, RpcError
from . import config, cron, memory, plugin_catalog
from .profiles import invalidate_skill_stats

_SOURCES = {'claude-code': ('.claude', 'Claude Code'), 'codex': ('.codex', 'Codex CLI'), 'cursor': ('.cursor', 'Cursor')}
# One-off sources through the plugin's Bot importers, present only on revisions that reviewed those modules.
_BOT_SOURCES = {'grok-bot': 'Grok Bot', 'openbot': 'OpenBot'}
_CREDENTIALS = {'.credentials.json', 'auth.json', 'credentials.json', 'cli-config.json', '.env'}
_TARGETS = ('config.yaml', 'memories', 'skills', 'import-sync.json')
_CRON_JOBS = 'cron/jobs.json'
_BOT_TARGETS = _TARGETS + ('SOUL.md', 'SOUL.md.bak.grok-bot', 'SOUL.md.bak.openbot', _CRON_JOBS, 'grok-bot-import', 'openbot-import')
_MEMORY_FILES = {'memories/MEMORY.md', 'memories/USER.md'}
_PREVIEWS = {}
_MAX_FILES = 2048
_MAX_BYTES = 16 * 1024 * 1024
_LEDGER = '.talaria-agent-imports'
_EXPORT = 'grok-bot-export.json'
_OPENBOT_ROWS = 'openbot-rows.json'
_OPENBOT_TABLES = ('projection_agents', 'projection_agent_memories', 'projection_agent_routines', 'projection_routine_triggers', 'projection_mcp_servers')
# The identity of a file Talaria composed itself; its stamp comes from its bytes alone.
_COMPOSED = (0, 0, stat.S_IFREG | 0o600, 0, 0)


_NEEDS_NEWER = 'Needs a newer Agent Importers'
_REFUSED = {'export': 'Export refused: unreadable or holds credentials.', 'database': "OpenBot's database could not be read."}


def _row(agent, label, *, available=True, input='none', detail=None, export_prompt=None):
    return dict(agent=agent, label=label, available=available, input=input, detail=detail, export_prompt=export_prompt)


def _result(status, *, items=None, stripped=None, receipt=None, sources=None, message=None, can_apply=False, catalog_required=False):
    return dict(status=status, items=items or [], stripped_secrets=stripped or [], receipt=receipt,
                sources=sources or [], message=message, can_apply=can_apply, catalog_required=catalog_required)


@contextmanager
def _directory(path):
    """Open every ancestor without following links; the held descriptor owns all subsequent IO."""
    path = Path(path)
    if not path.is_absolute():
        raise OSError('An absolute directory is required')
    if '..' in path.parts:
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
            try:
                with _parent(fd, name) as (parent, leaf):
                    walk(parent, leaf, name)
            except FileNotFoundError:
                pass
    return files, identities


def _agent_rows(tables):
    """Each OpenBot agent row with its decoded settings; the reviewed reader reports the undecodable ones."""
    table = tables.get('projection_agents')
    if table:
        at = table['columns'].index('agent_json')
        for row in table['rows']:
            try:
                agent = json.loads(row[at])
            except (TypeError, ValueError):
                continue
            if isinstance(agent, dict):
                yield row, at, agent


def _openbot_source(module):
    """Read-only extract of what the reviewed reader uses: the tables it queries and each agent's skill folders.
    Chat history, provider accounts and the browser profile stay behind, and unrelated app activity keeps a preview valid."""
    os_home = Path.home()
    user_data = next((os_home / d for d in module.USER_DATA_DIRS if (os_home / d / module.DATABASE).is_file()), None)
    if user_data is None:
        raise FileNotFoundError('OpenBot database not found')
    with _directory(user_data) as fd:
        info = os.stat(module.DATABASE, dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise OSError('Unsafe OpenBot database')
    tables = {}
    try:
        # SQLite opens by path, so the no-follow check above is the anchor; mode=ro cannot write through a swapped file.
        db = sqlite3.connect(f'{(user_data / module.DATABASE).as_uri()}?mode=ro', uri=True)
        try:
            for table in _OPENBOT_TABLES:
                if db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone():
                    cursor = db.execute(f'SELECT * FROM "{table}"')
                    rows = cursor.fetchmany(_MAX_FILES + 1)
                    if len(rows) > _MAX_FILES:
                        raise OSError('OpenBot database too large')
                    tables[table] = dict(columns=[column[0] for column in cursor.description], rows=[list(row) for row in rows])
        finally:
            db.close()
    except sqlite3.Error as error:
        raise OSError('Unreadable OpenBot database') from error
    files, identities = {}, {}
    id_at = tables['projection_agents']['columns'].index('agent_id') if 'projection_agents' in tables else 0
    for index, (row, at, agent) in enumerate(_agent_rows(tables)):
        prefix = f'workspaces/{index}'
        workspace = Path(agent.get('workspacePath') or os_home / 'OpenBot' / 'Agents' / str(row[id_at]))
        try:
            tree, tree_identity = _snapshot(workspace, module._SKILL_DIRS)
        except FileNotFoundError:
            tree, tree_identity = {}, {}
        files.update({f'{prefix}/{name}': body for name, body in tree.items()})
        identities.update({f'{prefix}/{name}': value for name, value in tree_identity.items()})
        agent['workspacePath'] = prefix
        row[at] = json.dumps(agent, sort_keys=True)
    files[_OPENBOT_ROWS], identities[_OPENBOT_ROWS] = json.dumps(tables, sort_keys=True).encode(), _COMPOSED
    if len(identities) > _MAX_FILES or sum(map(len, files.values())) > _MAX_BYTES:
        raise OSError('Import tree too large')
    return user_data, files, identities


def _stage_openbot(stage, module):
    """The private database the reviewed reader opens; only extracted rows, with workspaces inside the stage."""
    tables = json.loads((stage / _OPENBOT_ROWS).read_text())
    for row, at, agent in _agent_rows(tables):
        agent['workspacePath'] = str(stage / agent['workspacePath'])
        row[at] = json.dumps(agent)
    db = sqlite3.connect(stage / module.DATABASE)
    try:
        for table, data in tables.items():
            columns = ','.join('"' + name.replace('"', '""') + '"' for name in data['columns'])
            db.execute(f'CREATE TABLE "{table}" ({columns})')
            db.executemany(f'INSERT INTO "{table}" VALUES ({",".join("?" * len(data["columns"]))})', data['rows'])
        db.commit()
    finally:
        db.close()


def _export_bot(bot):
    """An export is Bot-written text. Only the local readers may name folders to copy or MCP commands to launch."""
    bot = {key: value for key, value in bot.items() if key != 'mcp_servers'}
    if isinstance(bot.get('skills'), list):
        bot['skills'] = [{key: value for key, value in skill.items() if key != 'path'} if isinstance(skill, dict) else skill for skill in bot['skills']]
    return bot


def _native(agent, importer, bots, source, target, execute):
    """Run the reviewed importer bound to the stage, so Agent helpers it reaches (config backups, cron) never touch the profile."""
    if agent == 'grok-bot':
        class Export(bots[agent].GrokBotImporter):
            def load_bots(self):
                return [(path, _export_bot(bot)) for path, bot in super().load_bots()]
        native = Export([source / _EXPORT], target, execute=execute, overwrite=False)
    elif agent == 'openbot':
        native = bots[agent].OpenBotImporter(source, target, execute=execute, overwrite=False)
    else:
        native = importer(agent, source, target, execute=execute, overwrite=False)
    with homes.scoped_home(target, load_plugins=False, read_only=True):
        return native.run()


def _source(agent, bots=None, export=None):
    if agent == 'grok-bot':
        return None, {_EXPORT: export}, {_EXPORT: _COMPOSED}
    if agent == 'openbot':
        return _openbot_source(bots[agent])
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
             'rules': 'Cursor rules', 'config': 'Configuration', 'slash-commands': 'Slash commands',
             'role': 'Instructions', 'user-facts': 'User facts', 'routines': 'Routines', 'routine': 'Routine (paused task)',
             'event-routines': 'Event routines (saved as notes)', 'apps': 'Connected apps', 'export': 'Export file',
             'bots': 'Other Bots', 'routine-check': 'Routines missing from the export', 'database': 'OpenBot database',
             'agents': 'OpenBot agents', 'mcp-env-passthrough': 'MCP environment variables'}
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
                       and re.fullmatch(r'[A-Za-z0-9_.:() -]+', name)]


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
    action, agent, token, export = params.get('action'), params.get('agent'), params.get('receipt'), params.get('export_text')
    if (action not in ('discover', 'preview', 'apply', 'result') or action == 'preview' and agent not in _SOURCES and agent not in _BOT_SOURCES
            or action == 'preview' and (agent == 'grok-bot') != (isinstance(export, str) and bool(export))
            or action in ('apply', 'result') and (not isinstance(token, str) or not 0 < len(token) <= 128)):
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
                            files, _ = _snapshot(home, _BOT_TARGETS)
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
                importer, sync, plugin, bots = native
                if action == 'discover':
                    sources = []
                    for name, (_, label) in _SOURCES.items():
                        try:
                            _source(name)
                            sources.append(_row(name, label))
                        except OSError:
                            pass
                    grok = bots.get('grok-bot')
                    sources.append(_row('grok-bot', _BOT_SOURCES['grok-bot'], available=grok is not None, input='file',
                                        detail=None if grok else _NEEDS_NEWER, export_prompt=grok.EXPORT_PROMPT if grok else None))
                    detail = _NEEDS_NEWER
                    if 'openbot' in bots:
                        try:
                            _source('openbot', bots)
                            detail = None
                        except (OSError, ValueError, TypeError):
                            # A malformed database costs only this row, never the sources beside it.
                            detail = 'Not found on this computer'
                    sources.append(_row('openbot', _BOT_SOURCES['openbot'], available=detail is None, detail=detail))
                    return _result('available', sources=sources)
                now = time.monotonic()
                for old in list(_PREVIEWS):
                    if _PREVIEWS[old]['expires'] <= now:
                        del _PREVIEWS[old]
                receipt = _PREVIEWS.get(token) if action == 'apply' else None
                if action == 'apply' and (receipt is None or receipt['home'] != str(home)):
                    return _result('changed', message='Preview expired or belongs to another profile. Preview again.')
                agent = receipt['agent'] if receipt else agent
                if agent in _BOT_SOURCES and agent not in bots:
                    return _result('unavailable', message='Update Agent Importers from the plugin catalog to import this source.', catalog_required=True)
                export = receipt['export'] if receipt else export.encode() if agent == 'grok-bot' else None
                targets = _BOT_TARGETS if agent in _BOT_SOURCES else _TARGETS
                source, source_files, source_identity = _source(agent, bots, export)
                if source is not None and (home == source or home in source.parents or source in home.parents):
                    raise OSError('Source overlaps the active profile')
                target = _snapshot(home, targets)
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
                    if agent == 'openbot':
                        _stage_openbot(stage_source, bots[agent])
                    report = _native(agent, importer, bots, stage_source, stage_target, False)
                    items, stripped = _project(report)
                    plan = json.dumps([items, stripped], sort_keys=True)
                    if receipt and plan != receipt['plan']:
                        return _result('changed', message='Import plan changed. Preview again.')
                    if action == 'preview':
                        if not any(i['status'] == 'imported' for i in items):
                            refused = next((_REFUSED[i['kind']] for i in items if i['status'] == 'error' and i['kind'] in _REFUSED), None)
                            return _result('preview', items=items, stripped=stripped, message=refused)
                        token = secrets.token_urlsafe(32)
                        if len(_PREVIEWS) >= 64:
                            del _PREVIEWS[next(iter(_PREVIEWS))]
                        _PREVIEWS[token] = dict(home=str(home), agent=agent, identity=identity, plan=plan, expires=now + 300, export=export)
                        return _result('preview', items=items, stripped=stripped, receipt=token,
                                       can_apply=any(i['status'] == 'imported' for i in items))
                    del _PREVIEWS[token]
                    unknown = _result('unknown', message='Import outcome is unknown. Check the profile before starting a new preview.')
                    # Fsync the consumed record before any native write. Restart or cancellation cannot replay it.
                    _ledger(root_fd, token, unknown)
                    try:
                        report = _native(agent, importer, bots, stage_source, stage_target, True)
                        items, stripped = _project(report)
                        # Bot sources are one-off imports, never registered for re-sync.
                        if agent not in _BOT_SOURCES:
                            sync.update_sync_manifest(agent, stage_source, stage_target, False, report,
                                                      refresh_digest=not any(i['status'] == 'error' for i in items))
                            manifest_path = stage_target / 'import-sync.json'
                            manifest = json.loads(manifest_path.read_text())
                            manifest['agents'][agent]['source'] = str(source)
                            manifest_path.write_text(json.dumps(manifest))
                        config.assert_config_writable(home)
                        output, output_identity = _snapshot(stage_target, targets)
                        # Check original objects again before publication; no write resolves a client/native path.
                        fresh_source = _source(agent, bots, export)
                        if (plugin_catalog.reviewed_importer(home)[2] != plugin
                                or _stamp(fresh_source[1:]) != identity[3] or _stamp(_snapshot(home, targets)) != identity[4]):
                            return _ledger(root_fd, token, _result('changed', message='Import inputs changed before publication. Preview again.'))
                        result = _result('partial' if any(i['status'] == 'error' for i in items) else 'applied', items=items, stripped=stripped)
                        result['message'] = 'Files imported. Reload Skills and MCP before using the imported setup.'
                        _ledger(root_fd, token, dict(result=unknown, expected={k: hashlib.sha256(v).hexdigest() for k, v in output.items()}, confirmed=result))
                        for rel, body in output.items():
                            if target[0].get(rel) != body:
                                # The live store's jobs lock spans the final identity check and rename, excluding a scheduler tick.
                                with cron._store(home, transaction=True) if rel == _CRON_JOBS else nullcontext():
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


def _run(ctx, params):
    try:
        return run(ctx, params)
    finally:
        if params.get('action') == 'apply':
            invalidate_skill_stats(homes.profile_home_param(params))


def register(registry):
    registry.method('profiles.import')(_run)
