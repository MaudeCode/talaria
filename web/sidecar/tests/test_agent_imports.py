"""Profile import boundary, using disposable trees and a native structured-API stub."""
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from talaria_sidecar.methods import Registry, build_methods


def test_profile_import_rpc_is_registered():
    methods = build_methods(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    assert 'profiles.import' in methods, 'The profile import discovery/preview/apply boundary is missing'


@pytest.fixture
def imports(monkeypatch, tmp_path):
    from talaria_sidecar.methods import agent_imports as subject
    root = tmp_path.resolve()
    source = root / '.cursor'
    source.mkdir()
    (source / 'AGENTS.md').write_text('Synthetic instructions')
    (source / 'auth.json').write_text('NEVER-READ-CREDENTIAL')
    target = root / 'profile'
    target.mkdir()
    (target / 'config.yaml').write_text('existing config')
    other = root / 'other-profile'
    other.mkdir()
    (other / 'config.yaml').write_text('untouched')
    effects = []
    state = {'pin': 'reviewed', 'supported': True, 'failure': None}

    class Importer:
        def __init__(self, agent, source_root, target_root, execute=False, overwrite=False):
            assert overwrite is False and agent == 'cursor'
            self.source, self.target, self.execute = Path(source_root), Path(target_root), execute
        def run(self):
            assert self.source != source and self.target != target
            assert not (self.source / 'auth.json').exists()
            if self.execute:
                effects.append('execute')
                if state['failure']:
                    raise RuntimeError('SECRET-NATIVE-ERROR')
                memory = self.target / 'memories'
                memory.mkdir(exist_ok=True)
                (memory / 'MEMORY.md').write_text((self.source / 'AGENTS.md').read_text())
            return {'dry_run': not self.execute, 'items': [{'kind': 'agents-md', 'status': 'imported', 'reason': 'SECRET-REPORT', 'source': 'SECRET-PATH'}, {'kind': 'mcp-servers', 'status': 'conflict'}], 'stripped_secrets': ['mcp_servers.fixture.env.API_TOKEN']}

    def sync(agent, src, dest, overwrite, report, **kwargs):
        assert not overwrite
        effects.append('sync')
        (dest / 'import-sync.json').write_text('{"agents":{"cursor":{"source":"temporary"}}}')
    monkeypatch.setattr(Path, 'home', lambda: root)
    monkeypatch.setattr(subject.homes, 'scoped_home', lambda *a, **kw: nullcontext())
    monkeypatch.setattr(subject.plugin_catalog, 'reviewed_importer', lambda _home: (Importer, SimpleNamespace(update_sync_manifest=sync), [state['pin']]) if state['supported'] else None)
    monkeypatch.setattr(subject.config, 'assert_config_writable', lambda _home: None)
    monkeypatch.setattr(subject, '_PREVIEWS', {})
    monkeypatch.setattr(subject, '_refresh_runtime', lambda _home: True)
    methods = build_methods(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    def call(action, **params):
        return methods['profiles.import'](None, dict(profile_home=str(target), action=action, **params))
    return SimpleNamespace(call=call, target=target, source=source, other=other, effects=effects, state=state, subject=subject, root=root)


def tree(path):
    return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob('*') if p.is_file()}


def test_preview_cancel_and_explicit_apply_are_isolated_and_redacted(imports):
    i = imports
    before, other = tree(i.target), tree(i.other)
    assert i.call('discover')['sources'] == [{'agent': 'cursor', 'label': 'Cursor'}]
    preview = i.call('preview', agent='cursor')
    assert preview['status'] == 'preview' and preview['can_apply']
    assert tree(i.target) == before and i.effects == []
    assert 'SECRET' not in str(preview)
    assert [item['status'] for item in preview['items']] == ['imported', 'conflict']
    assert preview['stripped_secrets'] == ['mcp_servers.fixture.env.API_TOKEN']
    result = i.call('apply', receipt=preview['receipt'])
    assert result['status'] == 'applied'
    assert (i.target / 'config.yaml').read_text() == 'existing config'
    assert (i.target / 'memories/MEMORY.md').read_text() == 'Synthetic instructions'
    assert tree(i.other) == other
    assert i.effects == ['execute', 'sync']
    assert i.call('apply', receipt=preview['receipt']) == result
    assert i.effects == ['execute', 'sync']
    import json
    assert json.loads((i.target / 'import-sync.json').read_text())['agents']['cursor']['source'] == str(i.source)


@pytest.mark.parametrize('change', ['source', 'target', 'pin', 'profile', 'expiry', 'symlink', 'hardlink'])
def test_changed_identity_never_reaches_native_execute(imports, monkeypatch, change):
    i = imports
    preview = i.call('preview', agent='cursor')
    if change == 'source': (i.source / 'AGENTS.md').write_text('changed')
    elif change == 'target': (i.target / 'config.yaml').write_text('changed')
    elif change == 'pin': i.state['pin'] = 'changed'
    elif change == 'profile':
        result = i.subject.run(None, dict(profile_home=str(i.other), action='apply', receipt=preview['receipt']))
        assert result['status'] == 'changed' and i.effects == []
        return
    elif change == 'expiry': monkeypatch.setattr(i.subject.time, 'monotonic', lambda: 1e20)
    elif change == 'symlink':
        (i.source / 'AGENTS.md').unlink()
        (i.source / 'AGENTS.md').symlink_to(i.other / 'config.yaml')
    else:
        import os
        (i.source / 'AGENTS.md').unlink()
        os.link(i.other / 'config.yaml', i.source / 'AGENTS.md')
    assert i.call('apply', receipt=preview['receipt'])['status'] == 'changed'
    assert i.effects == []
    assert (i.other / 'config.yaml').read_text() == 'untouched'


def test_unavailable_does_not_touch_profile_and_result_never_executes(imports):
    i = imports
    before = tree(i.target)
    i.state['supported'] = False
    assert i.call('discover')['status'] == 'unavailable'
    assert i.call('preview', agent='cursor')['status'] == 'unavailable'
    assert tree(i.target) == before
    i.state['supported'] = True
    preview = i.call('preview', agent='cursor')
    assert i.call('result', receipt=preview['receipt'])['status'] == 'changed'
    assert i.call('apply', receipt=preview['receipt'])['status'] == 'changed'
    assert i.effects == []


def test_unknown_outcome_is_durable_and_never_blindly_replayed(imports):
    i = imports
    preview = i.call('preview', agent='cursor')
    i.state['failure'] = True
    assert i.call('apply', receipt=preview['receipt'])['status'] == 'unknown'
    i.subject._PREVIEWS.clear()
    assert i.call('apply', receipt=preview['receipt'])['status'] == 'unknown'
    assert i.call('result', receipt=preview['receipt'])['status'] == 'unknown'
    assert i.effects == ['execute']
    assert 'SECRET' not in str(tree(i.target))


def test_input_changed_during_native_work_is_not_published(imports, monkeypatch):
    i = imports
    preview = i.call('preview', agent='cursor')
    original = i.subject._project
    def concurrent(report):
        if report.get('dry_run') is False:
            (i.target / 'config.yaml').write_text('concurrent edit')
        return original(report)
    monkeypatch.setattr(i.subject, '_project', concurrent)
    assert i.call('apply', receipt=preview['receipt'])['status'] == 'changed'
    assert (i.target / 'config.yaml').read_text() == 'concurrent edit'
    assert not (i.target / 'memories').exists()


def test_snapshot_preserves_empty_conflicts_and_script_modes(imports):
    i = imports
    empty = i.target / 'skills/cursor-imports/already-here'
    empty.mkdir(parents=True)
    script = i.target / 'skills/fixture/run.sh'
    script.parent.mkdir()
    script.write_text('#!/bin/sh\ntrue\n')
    script.chmod(0o755)
    snapshot = i.subject._snapshot(i.target, i.subject._TARGETS)
    copy = i.root / 'snapshot'
    i.subject._materialize(copy, *snapshot)
    assert (copy / 'skills/cursor-imports/already-here').is_dir()
    assert (copy / 'skills/fixture/run.sh').stat().st_mode & 0o777 == 0o755


def test_partial_publication_reconciles_exact_bytes_without_native_replay(imports, monkeypatch):
    i = imports
    preview = i.call('preview', agent='cursor')
    original = i.subject._ledger
    def lost_ack(root_fd, token, result=None):
        if result is not None and result.get('status') == 'applied':
            raise OSError('ack lost after publication')
        return original(root_fd, token, result)
    monkeypatch.setattr(i.subject, '_ledger', lost_ack)
    assert i.call('apply', receipt=preview['receipt'])['status'] == 'unknown'
    monkeypatch.setattr(i.subject, '_ledger', original)
    assert i.call('result', receipt=preview['receipt'])['status'] == 'applied'
    assert i.effects == ['execute', 'sync']


def test_live_memory_publication_excludes_a_save_at_the_final_rename(imports, monkeypatch):
    import fcntl
    import os

    i = imports
    memory = i.target / 'memories/MEMORY.md'
    memory.parent.mkdir()
    memory.write_text('Before preview')
    snapshot = i.subject._snapshot(i.target, i.subject._TARGETS)
    rename = os.rename
    attempts = []

    def competing_save(src, dst, **kwargs):
        if dst == 'MEMORY.md':
            # A native memory writer uses this exact lock inode before accepting a save.
            with (memory.parent / 'MEMORY.md.lock').open('a+') as writer:
                try:
                    fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    attempts.append('blocked')
                else:
                    memory.write_text('Accepted concurrent save')
                    attempts.append('accepted')
                    fcntl.flock(writer, fcntl.LOCK_UN)
        return rename(src, dst, **kwargs)

    monkeypatch.setattr(os, 'rename', competing_save)
    with i.subject._directory(i.target) as fd:
        i.subject._write(fd, 'memories/MEMORY.md', b'Imported memory', expected=(snapshot[0]['memories/MEMORY.md'], snapshot[1]['memories/MEMORY.md']))
    assert attempts == ['blocked'], 'Import overwrote a save accepted after its final identity check'
    assert memory.read_text() == 'Imported memory'


@pytest.mark.parametrize('name', ['MEMORY.md', 'USER.md'])
def test_import_waits_for_a_live_memory_save_and_rechecks_its_result(imports, monkeypatch, name):
    from contextlib import contextmanager
    import fcntl
    import threading

    i = imports
    path = i.target / 'memories' / name
    path.parent.mkdir()
    path.write_text('Before preview')
    rel = 'memories/' + name
    snapshot = i.subject._snapshot(i.target, i.subject._TARGETS)
    at_lock = threading.Event()
    finished = threading.Event()
    errors = []
    original = i.subject.memory.file_lock

    @contextmanager
    def observed(*args, **kwargs):
        at_lock.set()
        with original(*args, **kwargs):
            yield

    monkeypatch.setattr(i.subject.memory, 'file_lock', observed)
    def publish():
        try:
            with i.subject._directory(i.target) as fd:
                i.subject._write(fd, rel, b'Imported memory', expected=(snapshot[0][rel], snapshot[1][rel]))
        except OSError as error:
            errors.append(error)
        finally:
            finished.set()

    with path.with_name(name + '.lock').open('a+') as writer:
        fcntl.flock(writer, fcntl.LOCK_EX)
        thread = threading.Thread(target=publish)
        thread.start()
        try:
            assert at_lock.wait(5), 'Publication did not reach the shared memory lock'
            assert not finished.is_set(), 'Publication ignored the active memory writer'
            path.write_text('Accepted concurrent save')
        finally:
            fcntl.flock(writer, fcntl.LOCK_UN)
    thread.join(5)
    assert finished.is_set() and errors, 'A changed memory target was not refused after acquiring its lock'
    assert path.read_text() == 'Accepted concurrent save'
    assert rel + '.lock' not in i.subject._snapshot(i.target, i.subject._TARGETS)[0]


def test_import_rejects_an_escaped_memory_lock_before_publication(imports):
    i = imports
    (i.target / 'memories').mkdir()
    (i.target / 'memories/MEMORY.md.lock').symlink_to(i.other / 'config.yaml')
    before = tree(i.other)
    assert i.call('preview', agent='cursor')['status'] == 'unavailable'
    assert tree(i.other) == before
    assert i.effects == []


def test_import_rechecks_config_policy_after_native_staging(imports, monkeypatch):
    from talaria_sidecar.errors import RpcError

    i = imports
    preview = i.call('preview', agent='cursor')
    checks = []
    def policy(home):
        checks.append(home)
        if len(checks) > 1:
            raise RpcError('Configuration became managed', condition='config_write_refused')
    monkeypatch.setattr(i.subject.config, 'assert_config_writable', policy)
    assert i.call('apply', receipt=preview['receipt'])['status'] == 'unknown'
    assert (i.target / 'config.yaml').read_text() == 'existing config'
    assert not (i.target / 'memories').exists()
    assert i.call('result', receipt=preview['receipt'])['status'] == 'unknown'
