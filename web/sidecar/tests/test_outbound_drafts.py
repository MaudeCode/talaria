"""Real disposable SQLite store, with native registration/consent replaced at its boundary."""
import contextlib
import json
import sqlite3
import hashlib
import sys
from types import SimpleNamespace as NS

import pytest

from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import build_methods, outbound_drafts as drafts


@pytest.fixture
def backend(tmp_path, monkeypatch):
    home = tmp_path / 'profile'
    path = home / 'plugin-data/draft-cards/drafts.db'
    path.parent.mkdir(parents=True)
    fields = {'from': '', 'to': ['recipient@example.invalid'], 'cc': [], 'bcc': [], 'subject': 'Review', 'body': 'Exact content'}
    with sqlite3.connect(path) as conn:
        conn.executescript('''
            CREATE TABLE drafts (id TEXT PRIMARY KEY,kind TEXT,platform TEXT,session_id TEXT,status TEXT,status_detail TEXT,status_at REAL,approved_version INTEGER,created_at REAL,updated_at REAL);
            CREATE TABLE versions (draft_id TEXT,v INTEGER,card INTEGER,author TEXT,note TEXT,fields TEXT,created_at REAL,PRIMARY KEY(draft_id,v));
        ''')
        conn.execute("INSERT INTO drafts VALUES ('d_1234abcd','email','','session-alpha','draft','',1,NULL,1,1)")
        conn.execute("INSERT INTO versions VALUES ('d_1234abcd',1,1,'agent','',?,1)", (json.dumps(fields),))
    consent = {str(home): True}
    @contextlib.contextmanager
    def scope(selected, **kwargs):
        assert kwargs == {'load_plugins': False}
        yield selected
    monkeypatch.setattr(drafts.homes, 'scoped_home', scope)
    monkeypatch.setattr(drafts, '_producer', lambda selected: drafts._PIN if consent.get(str(selected)) else None)
    methods = build_methods(NS(load=lambda: None, ensure_current=lambda: None))
    params = {'profile_home': str(home), 'session_id': 'session-alpha', 'draft_id': 'd_1234abcd', 'card': 1}
    def call(action='read', **kwargs):
        return methods['drafts.review'](NS(check_cancelled=lambda: None), {**params, 'action': action, **kwargs})['draft']
    def act(action, shown=None, **kwargs):
        shown = shown or call()
        return call(action, version=shown['version'], revision=shown['revision'], **kwargs)
    return NS(home=home, path=path, fields=fields, call=call, act=act, consent=consent)


def test_native_content_and_approval_are_bound_to_session_version_and_consumed_once(backend):
    b = backend
    shown = b.call()
    assert shown['fields'] == b.fields and shown['version'] == 1 and shown['can_approve']
    assert b.call(session_id='foreign') is None
    assert b.call(profile_home=str(b.home / 'other')) is None
    approved = b.act('approve', shown)
    assert approved['state'] == 'approved' and not approved['can_approve']
    with pytest.raises(RpcError, match='already approved'):
        b.act('approve', shown)
    # Lost acknowledgment: a read confirms approval; the write is never replayed.
    assert b.call()['state'] == 'approved'
    with sqlite3.connect(b.path) as conn:
        assert conn.execute('SELECT count(*) FROM talaria_outbound_approvals').fetchone()[0] == 1
        assert conn.execute('SELECT approved_version FROM drafts').fetchone()[0] == 1


def test_edits_invalidate_approval_and_stale_or_superseded_cards_cannot_act(backend):
    b = backend
    first = b.call()
    b.act('approve', first)
    second = b.act('edit', fields={**b.fields, 'to': ['changed@example.invalid'], 'body': 'Changed content'})
    assert second['version'] == 2 and second['state'] == 'draft' and second['can_approve']
    with pytest.raises(RpcError):
        b.act('approve', first)
    with sqlite3.connect(b.path) as conn:
        conn.execute("INSERT INTO versions VALUES ('d_1234abcd',3,2,'agent','',?,3)", (json.dumps(b.fields),))
        conn.execute("UPDATE drafts SET status='draft',approved_version=NULL")
    assert b.call()['state'] == 'superseded'
    with pytest.raises(RpcError):
        b.act('edit', second, fields=b.fields)
    assert b.call(card=2)['version'] == 3


@pytest.mark.parametrize('state', ['discarded', 'sent', 'saved'])
def test_terminal_native_state_and_revoked_producer_refuse_both_actions(backend, state):
    b = backend
    shown = b.call()
    with sqlite3.connect(b.path) as conn:
        conn.execute('UPDATE drafts SET status=?', (state,))
    assert b.call()['state'] == state
    for action in ('approve', 'edit'):
        with pytest.raises(RpcError):
            b.act(action, shown, fields=b.fields)
    b.consent[str(b.home)] = False
    assert b.call() is None
    with pytest.raises(RpcError):
        b.act('approve', shown)


def test_same_number_with_changed_recipient_or_body_invalidates_the_review(backend):
    b = backend
    shown = b.call()
    with sqlite3.connect(b.path) as conn:
        conn.execute('UPDATE versions SET fields=?', (json.dumps({**b.fields, 'body': 'Different raw content'}),))
    with pytest.raises(RpcError):
        b.act('approve', shown)
    assert b.call()['can_approve']


def test_revocation_during_read_or_approval_discards_content_and_rolls_back(backend, monkeypatch):
    b = backend
    shown = b.call()
    snapshot = drafts._snapshot
    def revoke(conn, *args):
        result = snapshot(conn, *args)
        b.consent[str(b.home)] = False
        return result
    monkeypatch.setattr(drafts, '_snapshot', revoke)
    assert b.call() is None
    b.consent[str(b.home)] = True
    with pytest.raises(RpcError):
        b.act('approve', shown)
    with sqlite3.connect(b.path) as conn:
        assert conn.execute('SELECT status FROM drafts').fetchone()[0] == 'draft'


def test_native_writer_cannot_change_content_between_review_check_and_approval(backend, monkeypatch):
    b = backend
    shown = b.call()
    snapshot = drafts._snapshot
    attempted = []
    def race(conn, *args):
        result = snapshot(conn, *args)
        with sqlite3.connect(b.path, timeout=0) as writer:
            with pytest.raises(sqlite3.OperationalError, match='locked'):
                writer.execute('UPDATE versions SET fields=?', (json.dumps({**b.fields, 'body': 'Unreviewed'}),))
        attempted.append(True)
        return result
    monkeypatch.setattr(drafts, '_snapshot', race)
    # Call the owning transaction directly so the read preflight is not confused with the mutation.
    approved = b.act('approve', shown)
    assert attempted and approved['fields']['body'] == 'Exact content' and approved['state'] == 'approved'


def test_no_missing_database_or_symlink_is_created_or_followed(backend, tmp_path):
    b = backend
    outside = tmp_path / 'outside.db'
    b.path.rename(outside)
    assert b.call() is None and not b.path.exists()
    b.path.symlink_to(outside)
    assert b.call() is None


def test_registration_requires_reviewed_native_source_identity_and_current_profile_consent(tmp_path, monkeypatch):
    home = tmp_path / 'profile'
    root = home / 'plugins/draft-cards'
    root.mkdir(parents=True)
    (root / 'store.py').write_bytes(b'synthetic reviewed producer')
    monkeypatch.setattr(drafts, '_SOURCES', {'store.py': hashlib.sha256(b'synthetic reviewed producer').hexdigest()})
    metadata = {'draft-cards': {'revision': drafts._PIN, 'catalog': {'name': 'draft-cards', 'sha': drafts._PIN}}}
    monkeypatch.setitem(sys.modules, 'hermes_cli', NS(plugins_cmd=NS(_read_install_metadata=lambda: metadata)))
    plugin = {'name': 'draft-cards', 'enabled': True, 'source': 'user', '_dir': str(root / 'dashboard'), '_asset_anchor': str(home)}
    monkeypatch.setattr(drafts.dashboard_plugins, '_plugins', lambda selected: [plugin] if selected == home else [])
    assert drafts._producer(home) == drafts._PIN
    assert drafts._producer(tmp_path / 'foreign') is None
    plugin['enabled'] = False
    assert drafts._producer(home) is None
    plugin['enabled'] = True
    plugin['source'] = 'project'
    assert drafts._producer(home) is None
    plugin['source'] = 'user'
    metadata['draft-cards']['revision'] = 'different producer revision'
    assert drafts._producer(home) is None
    metadata['draft-cards']['revision'] = drafts._PIN
    (root / 'store.py').write_bytes(b'mutated source at same pin')
    assert drafts._producer(home) is None
