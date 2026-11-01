"""Saved revision bytes are inspected without plugin execution, migration or model calls."""
from contextlib import contextmanager
import hashlib
import json
import shutil
from types import SimpleNamespace as NS
import sys

import pytest

from talaria_sidecar.errors import InvalidParams
from talaria_sidecar.methods import build_methods, skill_revisions as history, skills


@pytest.fixture
def store(tmp_path, monkeypatch):
    home = tmp_path / 'profile'
    path = home / 'skills/demo/SKILL.md'
    path.parent.mkdir(parents=True)
    texts = ['Original instructions.\n', 'Revised instructions.\n']
    path.write_text(texts[1])
    directory = home / 'hermetic/skill-versions/demo'
    directory.mkdir(parents=True)
    hashes = [hashlib.sha256(text.encode()).hexdigest() for text in texts]
    for text, sha in zip(texts, hashes):
        (directory / f'{sha[:16]}-SKILL.md').write_text(text)
    ledger = home / 'skills/.curator_ledger.jsonl'
    ledger.write_text('\n'.join(json.dumps(dict(skill='demo', actor='user', ts=f'2026-01-0{i+1}T00:00:00Z',
        after=[dict(path=str(path), sha256=sha)])) for i, sha in enumerate(hashes)))
    entries = [dict(load_name='demo', name='demo', path=path)]
    monkeypatch.setattr(skills, '_skill_helper', lambda _: lambda **kwargs: entries)
    consent = {str(home): True}
    monkeypatch.setattr(history.dashboard_plugins, 'reviewed_producer', lambda selected, *args: history._PIN if consent.get(str(selected)) else None)
    @contextmanager
    def scope(selected, **kwargs):
        assert kwargs == {'load_plugins': False, 'recover_processes': False}
        yield selected
    monkeypatch.setattr(skills, 'scoped_home', scope)
    methods = build_methods(NS(load=lambda: None, ensure_current=lambda: None))
    def call(**kwargs):
        return methods['skills.revisions'](NS(check_cancelled=lambda: None), dict(profile_home=str(home), name='demo') | kwargs)
    return NS(home=home, directory=directory, path=path, ledger=ledger, hashes=hashes, texts=texts, call=call, entries=entries, consent=consent)


def test_exact_saved_revisions_provenance_and_diff_are_read_only(store):
    b = store
    before = {str(p): p.read_bytes() for p in b.home.rglob('*') if p.is_file()}
    result = b.call()
    assert result['state'] == 'available' and result['replay_available'] is True
    assert [r['sha256'] for r in result['revisions']] == b.hashes[::-1]
    assert [r['current'] for r in result['revisions']] == [True, False]
    assert result['revisions'][0]['actor'] == 'user'
    assert result['revisions'][0]['saved_at'] == '2026-01-02T00:00:00+00:00'
    assert result['selected']['content'] == b.texts[1]
    assert '-Original instructions.' in result['comparison']['diff']
    assert '+Revised instructions.' in result['comparison']['diff']
    older, newer = result['revisions'][1]['id'], result['revisions'][0]['id']
    reverse = b.call(revision=older, compare_to=newer)
    assert reverse['selected']['content'] == b.texts[0]
    assert '+Original instructions.' in reverse['comparison']['diff']
    assert {str(p): p.read_bytes() for p in b.home.rglob('*') if p.is_file()} == before


def test_missing_history_never_fabricates_current_or_migrates_legacy(store):
    b = store
    b.directory.rename(b.directory.with_name('retired'))
    legacy = b.home / 'openrouter-meter/skill-versions/demo'
    legacy.mkdir(parents=True)
    assert b.call()['state'] == 'missing'
    assert b.call()['revisions'] == []
    assert not b.directory.exists() and legacy.exists()


def test_selection_is_bound_to_profile_skill_and_exact_saved_bytes(store):
    b = store
    selected = b.call()['selected']['revision']
    with pytest.raises(InvalidParams, match='no longer exists'):
        b.call(revision='0' * 64)
    assert b.call(profile_home=str(b.home / 'foreign'))['state'] == 'unavailable'
    assert b.call(name='foreign')['state'] == 'unavailable'
    b.entries.append(dict(load_name='other/demo', name='demo', path=b.path))
    assert b.call()['reason'] == 'identity_unavailable'
    b.entries.pop()
    (b.directory / f'{b.hashes[1][:16]}-SKILL.md').unlink()
    with pytest.raises(InvalidParams, match='no longer exists'):
        b.call(revision=selected)


def test_identical_content_in_another_profile_cannot_consume_the_first_profiles_id(store):
    b = store
    identity = b.call()['selected']['revision']
    other = b.home.with_name('other')
    shutil.copytree(b.home, other)
    b.consent[str(other)] = True
    b.entries[0]['path'] = other / 'skills/demo/SKILL.md'
    assert b.call(profile_home=str(other))['selected']['revision'] != identity
    with pytest.raises(InvalidParams, match='no longer exists'):
        b.call(profile_home=str(other), revision=identity)


def test_comparison_preserves_missing_final_newline(store):
    b = store
    for file in b.directory.iterdir():
        file.unlink()
    for text in ('Same text', 'Same text\n'):
        sha = hashlib.sha256(text.encode()).hexdigest()
        (b.directory / f'{sha[:16]}-SKILL.md').write_text(text)
    assert '\\ No newline at end of file' in b.call()['comparison']['diff']


@pytest.mark.parametrize('fault', ['hash', 'symlink', 'directory_symlink', 'current_symlink', 'oversize', 'inventory', 'ledger', 'ledger_symlink', 'path'])
def test_corrupt_oversized_and_escaping_storage_fails_closed(store, tmp_path, fault):
    b = store
    file = b.directory / f'{b.hashes[0][:16]}-SKILL.md'
    if fault == 'hash':
        file.write_text('Changed under the same prefix')
    elif fault in ('symlink', 'current_symlink', 'ledger_symlink'):
        target = {'symlink': file, 'current_symlink': b.path, 'ledger_symlink': b.ledger}[fault]
        outside = tmp_path / 'outside'
        target.rename(outside)
        target.symlink_to(outside)
    elif fault == 'directory_symlink':
        outside = tmp_path / 'outside'
        b.directory.rename(outside)
        b.directory.symlink_to(outside, target_is_directory=True)
    elif fault == 'oversize':
        file.write_text('x' * (32 * 1024 + 1))
    elif fault == 'inventory':
        for i in range(65):
            (b.directory / str(i)).touch()
    elif fault == 'ledger':
        b.ledger.write_text('{broken')
    else:
        b.entries[0]['path'] = tmp_path / 'foreign/SKILL.md'
    assert b.call()['state'] == 'unavailable'
    assert b.call()['reason'] == 'invalid_history'
    assert b.call()['selected'] is None


def test_revoked_consent_refuses_before_and_after_readback(store, monkeypatch):
    b = store
    b.consent[str(b.home)] = False
    assert b.call()['reason'] == 'backend_unavailable'
    responses = iter([history._PIN, None])
    monkeypatch.setattr(history.dashboard_plugins, 'reviewed_producer', lambda *args: next(responses))
    assert b.call()['reason'] == 'backend_unavailable'


def test_reviewed_source_registration_and_profile_consent_are_required(tmp_path, monkeypatch):
    home = tmp_path / 'profile'
    root = home / 'plugins/hermetic'
    root.mkdir(parents=True)
    (root / 'plugin.yaml').write_bytes(b'synthetic reviewed producer')
    sources = {'plugin.yaml': hashlib.sha256(b'synthetic reviewed producer').hexdigest()}
    metadata = {'hermetic': {'revision': history._PIN, 'catalog': {'name': 'hermetic', 'sha': history._PIN}}}
    monkeypatch.setitem(sys.modules, 'hermes_cli', NS(plugins_cmd=NS(_read_install_metadata=lambda: metadata)))
    plugin = dict(name='hermetic', enabled=True, source='user', _dir=str(root / 'dashboard'), _asset_anchor=str(home))
    monkeypatch.setattr(history.dashboard_plugins, '_plugins', lambda selected: [plugin] if selected == home else [])
    verify = lambda: history.dashboard_plugins.reviewed_producer(home, 'hermetic', history._PIN, sources)
    assert verify() == history._PIN
    plugin['enabled'] = False
    assert verify() is None
    plugin['enabled'] = True
    metadata['hermetic']['revision'] = 'unreviewed'
    assert verify() is None
    metadata['hermetic']['revision'] = history._PIN
    (root / 'plugin.yaml').write_bytes(b'changed bytes at same pin')
    assert verify() is None
