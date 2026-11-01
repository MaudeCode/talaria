"""Read the reviewed Hermetic store without executing its API or migrating legacy data."""
from contextlib import contextmanager
from datetime import datetime, timezone
import difflib
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import stat

from ..errors import InvalidParams
from . import dashboard_plugins

_PIN = 'f7026c949d8831b26910f2ebd3434e8c58cdff89'
_SOURCES = {
    '__init__.py': '9dfb815be185965bf06c7c5a0fec401f6f376569d1a6830497502898fffcf01d',
    'plugin.yaml': 'b4fbd03f70f50d2cc391e530b3e4079ecbe249ab6e5c2e4702d475911327b50e',
    'dashboard/manifest.json': '466cada1eb3345f6fa7e12a5eaef44f8a19bb02546b9456fa0576d81ff89b6c1',
    'dashboard/plugin_api.py': '23f1c612559f0086ff5c7da6d3cc8fe0c596a05c6f6eaa89db94c8c4d8c99d1d',
}
_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._ -]{0,127}')
_FILE = re.compile(r'([a-f0-9]{16})-SKILL[.]md')
_MAX_TEXT = 32 * 1024
_MAX_REVISIONS = 64


@contextmanager
def _directory(anchor, parts=()):
    """Hold every traversal no-follow, including the profile's ancestors, through the read."""
    anchor = Path(anchor).absolute()
    components = (*anchor.parts[1:], *parts)
    if any(p in ('', '.', '..') or '/' in p or '\\' in p for p in components):
        raise ValueError('Invalid history path')
    fd = os.open(anchor.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in components:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _read(fd, name, limit):
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(child, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('History file is too large or not regular')
        data = file.read(limit + 1)
        if len(data) > limit:
            raise ValueError('History file is too large')
        return data, info.st_mtime


def _timestamp(value):
    try:
        date = datetime.fromtimestamp(value, timezone.utc) if type(value) in (int, float) else datetime.fromisoformat(value.replace('Z', '+00:00'))
        return date.astimezone(timezone.utc).isoformat() if date.tzinfo else None
    except (TypeError, ValueError, OverflowError, OSError, AttributeError):
        return None


def _result(state, reason=None, **fields):
    return dict(state=state, reason=reason, backend_revision=None, revisions=[], selected=None,
                comparison=None, replay_available=False) | fields


def _identity(catalog, name):
    entries = catalog(skip_disabled=True, include_hidden=True)
    matches = [entry for entry in entries if entry.get('load_name') == name]
    if len(matches) != 1:
        return None
    selected = matches[0]
    declared = selected.get('name')
    # Hermetic keys storage by declared name; two catalog copies cannot be attributed safely.
    if not isinstance(declared, str) or not _NAME.fullmatch(declared) or '..' in declared:
        return None
    return selected if len([entry for entry in entries if entry.get('name') == declared]) == 1 else None


def inspect_revisions(home, name, revision=None, compare_to=None):
    from .skills import _skill_helper

    if not isinstance(name, str) or not 0 < len(name) <= 256:
        raise InvalidParams('Invalid skill identity')
    if any(v is not None and (not isinstance(v, str) or not re.fullmatch('[a-f0-9]{64}', v)) for v in (revision, compare_to)):
        raise InvalidParams('Invalid revision identity')
    if not getattr(os, 'O_NOFOLLOW', 0) or not dashboard_plugins.reviewed_producer(home, 'hermetic', _PIN, _SOURCES):
        return _result('unavailable', 'backend_unavailable')
    try:
        catalog = _skill_helper('skill_catalog')
        selected = _identity(catalog, name) if catalog else None
        if selected is None:
            return _result('unavailable', 'identity_unavailable')
        declared = selected['name']
        local = Path(selected['path']).relative_to(home / 'skills')
        if local.name != 'SKILL.md':
            raise ValueError('Not a local skill')
        with _directory(home, ('skills', *local.parts[:-1])) as fd:
            current, _ = _read(fd, 'SKILL.md', _MAX_TEXT)
        provenance = {}
        with _directory(home, ('skills',)) as fd:
            try:
                ledger, _ = _read(fd, '.curator_ledger.jsonl', 256 * 1024)
            except FileNotFoundError:
                ledger = b''
        for line in ledger.decode('utf-8').splitlines():
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError('Invalid ledger')
            if row.get('skill') == declared:
                after = row.get('after') or []
                if not isinstance(after, list):
                    raise ValueError('Invalid ledger provenance')
                for item in after:
                    if isinstance(item, dict) and isinstance(item.get('sha256'), str):
                        actor = row.get('actor')
                        actor = actor if isinstance(actor, str) and len(actor) <= 80 and not any(ord(c) < 32 for c in actor) else None
                        provenance[item['sha256']] = (_timestamp(row.get('ts')), actor)
        try:
            with _directory(home, ('hermetic', 'skill-versions', declared)) as fd:
                with os.scandir(fd) as iterator:
                    files = list(itertools.islice(iterator, _MAX_REVISIONS + 1))
                if len(files) > _MAX_REVISIONS:
                    raise ValueError('Too many revisions')
                rows = []
                for file in files:
                    match = _FILE.fullmatch(file.name)
                    if not match:
                        continue
                    data, modified = _read(fd, file.name, _MAX_TEXT)
                    sha = hashlib.sha256(data).hexdigest()
                    if not sha.startswith(match[1]):
                        raise ValueError('Revision hash does not match saved bytes')
                    text = data.decode('utf-8')
                    if len(text.splitlines()) > 512:
                        raise ValueError('Too many revision lines')
                    saved_at, actor = provenance.get(sha, (_timestamp(modified), None))
                    identity = hashlib.sha256(json.dumps([str(home), name, sha]).encode()).hexdigest()
                    rows.append(dict(id=identity, sha256=sha, label=sha[:12], saved_at=saved_at, actor=actor,
                                     current=sha == hashlib.sha256(current).hexdigest(), content=text))
        except FileNotFoundError:
            rows = []
        if not rows:
            if revision or compare_to:
                raise InvalidParams('Revision no longer exists; reload history')
            return _result('missing', 'history_unavailable', backend_revision=_PIN)
        rows.sort(key=lambda row: (row['saved_at'] or '', row['sha256']), reverse=True)
        by_id = {row['id']: row for row in rows}
        target = by_id.get(revision) if revision else rows[0]
        if target is None:
            raise InvalidParams('Revision no longer exists; reload history')
        source = by_id.get(compare_to) if compare_to else next((r for r in rows if r['id'] != target['id']), None)
        if compare_to and source is None:
            raise InvalidParams('Revision no longer exists; reload history')
        comparison = None
        if source:
            lines = difflib.unified_diff(source['content'].splitlines(keepends=True), target['content'].splitlines(keepends=True),
                                        fromfile=source['label'], tofile=target['label'])
            diff = ''.join(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n' for line in lines)
            comparison = dict(from_revision=source['id'], to_revision=target['id'], diff=diff)
        # Native admission can be revoked while filesystem reads are in progress.
        if not dashboard_plugins.reviewed_producer(home, 'hermetic', _PIN, _SOURCES):
            return _result('unavailable', 'backend_unavailable')
        if _identity(catalog, name) != selected:
            return _result('unavailable', 'identity_unavailable')
        return dict(state='available', reason=None, backend_revision=_PIN,
                    revisions=[{k: v for k, v in row.items() if k != 'content'} for row in rows],
                    selected=dict(revision=target['id'], content=target['content']), comparison=comparison, replay_available=comparison is not None)
    except InvalidParams:
        raise
    except (ImportError, AttributeError, OSError, ValueError, TypeError, KeyError):
        return _result('unavailable', 'invalid_history')
