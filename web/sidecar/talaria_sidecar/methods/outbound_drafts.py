"""Typed adapter for the reviewed Draft Cards store. Never imports producer code or sends."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import json
from pathlib import Path
import re
import sqlite3
import time
from contextlib import closing

from .. import home as homes
from ..errors import InvalidParams, RpcError
from . import dashboard_plugins

_KEY = secrets.token_bytes(32)
_PIN = '6e6ca659ece59b0ce1c28b3b188393491ee5a415'
_SOURCES = {'__init__.py': '73388811ddc4f7cfc336c2a278dad9c0c032b0b15e4183ce8a157e61ce13695b',
            'plugin.yaml': 'e2a8a92847f4519f1636ec542ae2b1599050d9552fb9a61d9c6d6afaca83d6eb',
            'dashboard/manifest.json': '14e906a0e492669f0950e091f42d98ad607486dbea524b2a8e8691faa2139941',
            'dashboard/plugin_api.py': '98e38f618c23ec266f1e171a958ffcf048339ea3c7876d1faa2d0b8910839336',
            'store.py': '5815d4b106082b7f51d1b7e9d239fc655fa247a5e61ff7465e8c1865476eaaf6',
            'tools.py': '29271409488efc39206a048dc2852effc156d9ca5d91721632e1219840f14db1'}
_STATES = {'draft', 'approved', 'sent', 'saved', 'failed', 'discarded'}


def _producer(home):
    return dashboard_plugins.reviewed_producer(home, 'draft-cards', _PIN, _SOURCES)


def _database(home):
    """Only the producer's existing profile-local database; never creates storage on a read."""
    path = Path(home) / 'plugin-data' / 'draft-cards' / 'drafts.db'
    # No caller supplies a filesystem path, and no symlink may redirect native state.
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise OSError('Symlink in draft storage')
    if not path.is_file():
        raise OSError('Draft storage unavailable')
    connection = sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


def _fields(value):
    if not isinstance(value, dict) or set(value) != {'from', 'to', 'cc', 'bcc', 'subject', 'body'}:
        raise InvalidParams('Invalid draft fields')
    for key, limit in [('from', 320), ('subject', 300), ('body', 20_000)]:
        if not isinstance(value[key], str) or len(value[key]) > limit or '\x00' in value[key]:
            raise InvalidParams('Invalid draft fields')
    for key in ('to', 'cc', 'bcc'):
        if not isinstance(value[key], list) or len(value[key]) > 50 or any(
                not isinstance(item, str) or len(item) > 320 or re.search(r'[\r\n\x00]', item) for item in value[key]):
            raise InvalidParams('Invalid draft recipients')
    if not value['body'].strip():
        raise InvalidParams('A draft body is required')
    return value


def _snapshot(conn, home, params, producer):
    row = conn.execute('SELECT * FROM drafts WHERE id = ?', (params['draft_id'],)).fetchone()
    if row is None or not row['session_id'] or row['session_id'] != params['session_id']:
        return None
    versions = conn.execute('SELECT * FROM versions WHERE draft_id = ? ORDER BY v LIMIT 61', (params['draft_id'],)).fetchall()
    if not versions or len(versions) > 60 or row['kind'] not in ('email', 'message') or row['status'] not in _STATES:
        return None
    matches = [v for v in versions if v['card'] == params['card']]
    if not matches:
        return None
    selected, latest = matches[-1], versions[-1]
    fields = _fields(json.loads(selected['fields']))
    state = row['status'] if selected['v'] == latest['v'] else 'superseded'
    if state == 'approved' and row['approved_version'] != latest['v']:
        state = 'unavailable'
    consumed = False
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='talaria_outbound_approvals'").fetchone():
        consumed = conn.execute('SELECT 1 FROM talaria_outbound_approvals WHERE draft_id = ? AND version = ?',
                                (row['id'], selected['v'])).fetchone() is not None
    revision = hmac.new(_KEY, json.dumps([str(home), producer, dict(row), [dict(v) for v in versions], consumed],
                                        sort_keys=True, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()
    editable = state in ('draft', 'failed', 'approved')
    return {'producer': 'draft-cards', 'producer_revision': producer, 'draft_id': row['id'], 'card': selected['card'],
            'kind': row['kind'], 'platform': str(row['platform'])[:40], 'version': selected['v'], 'revision': revision,
            'fields': fields, 'state': state, 'can_edit': editable, 'can_approve': state in ('draft', 'failed') and not consumed,
            'masked': False}


def _conflict():
    raise RpcError('The draft changed or this version was already approved. Review it again.', condition='outbound_draft_conflict')


def review(ctx, params):
    ctx.check_cancelled()
    action = params.get('action')
    if (action not in ('read', 'edit', 'approve') or not isinstance(params.get('draft_id'), str)
            or not re.fullmatch(r'd_[0-9a-f]{8}', params['draft_id']) or type(params.get('card')) is not int
            or params['card'] < 1 or not isinstance(params.get('session_id'), str) or not params['session_id']):
        raise InvalidParams('Invalid outbound draft reference')
    home = homes.profile_home_param(params)
    with homes.scoped_home(home, load_plugins=False):
        producer = _producer(home)
        if producer is None:
            if action != 'read':
                _conflict()
            return {'draft': None}
        try:
            with closing(_database(home)) as conn, conn:
                # The native tool writers share this database lock. Check and mutation have one snapshot.
                conn.execute('BEGIN IMMEDIATE' if action != 'read' else 'BEGIN')
                draft = _snapshot(conn, home, params, producer)
                if action == 'read':
                    ctx.check_cancelled()
                    return {'draft': draft if _producer(home) == producer else None}
                if (draft is None or params.get('version') != draft['version'] or params.get('revision') != draft['revision']
                        or not draft['can_' + action] or _producer(home) != producer):
                    _conflict()
                now = time.time()
                if action == 'edit':
                    fields = _fields(params.get('fields'))
                    if fields == draft['fields']:
                        return {'draft': draft}
                    if conn.execute('SELECT count(*) FROM versions WHERE draft_id = ?', (draft['draft_id'],)).fetchone()[0] >= 60:
                        _conflict()
                    conn.execute("INSERT INTO versions (draft_id,v,card,author,note,fields,created_at) VALUES (?,?,?,'user','Edited in Talaria',?,?)",
                                 (draft['draft_id'], draft['version'] + 1, draft['card'], json.dumps(fields, ensure_ascii=False), now))
                    conn.execute("UPDATE drafts SET status='draft', approved_version=NULL, status_detail='', status_at=?, updated_at=? WHERE id=?",
                                 (now, now, draft['draft_id']))
                else:
                    # Additive native-store state: Stable producer readers ignore this per-version receipt.
                    conn.execute('CREATE TABLE IF NOT EXISTS talaria_outbound_approvals (draft_id TEXT NOT NULL, version INTEGER NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(draft_id,version))')
                    conn.execute('INSERT INTO talaria_outbound_approvals VALUES (?,?,?)', (draft['draft_id'], draft['version'], draft['revision']))
                    conn.execute("UPDATE drafts SET status='approved', approved_version=?, status_detail='', status_at=?, updated_at=? WHERE id=?",
                                 (draft['version'], now, now, draft['draft_id']))
                ctx.check_cancelled()
                if _producer(home) != producer:
                    _conflict()
                return {'draft': _snapshot(conn, home, params, producer)}
        except (OSError, sqlite3.Error, ValueError, KeyError, TypeError, InvalidParams) as exc:
            if action != 'read':
                raise RpcError('Draft outcome unconfirmed; read its state before trying again.', condition='outbound_draft_unconfirmed') from exc
            return {'draft': None}


def register(registry):
    registry.method('drafts.review')(review)
