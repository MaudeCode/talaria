"""Real Agent Git/cache/scan, catalog re-pin and unattended-update compatibility; final PM publication uses disposable trees."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
from hermes_cli import plugins_cmd as pc, plugins_cadence as cadence, plugins_transaction as transaction
from talaria_sidecar.methods import Registry, commands
from talaria_sidecar.errors import RpcError
from talaria_sidecar.home import scoped_home

registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
commands.register(registry)

def call(method, **params):
    return registry.methods[method](None, {"profile_home": str(home), **params})

home = Path(os.environ['HERMES_HOME'])
home.mkdir(parents=True, exist_ok=True)
repo = home.parent / 'upstream'
repo.mkdir()

def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], text=True).strip()

git(repo, 'init', '-q')
git(repo, 'config', 'user.email', 'probe@example.invalid')
git(repo, 'config', 'user.name', 'Probe')
(repo / 'plugin.yaml').write_text('name: update-probe\nversion: 1.0.0\n')
(repo / '__init__.py').write_text('def register(ctx):\n    pass\n')
git(repo, 'add', '.')
git(repo, 'commit', '-qm', 'initial')
old = git(repo, 'rev-parse', 'HEAD')
target = home / 'plugins' / 'update-probe'
target.parent.mkdir()
git(home, 'clone', '-q', str(repo), str(target))
metadata = {'update-probe': {'source': str(repo), 'revision': old, 'pinned': False}}
other_home = home / 'profiles' / 'other'
other_target = other_home / 'plugins' / 'update-probe'
other_target.parent.mkdir(parents=True)
git(home, 'clone', '-q', str(repo), str(other_target))
(other_target.parent / '.install-metadata.json').write_text(json.dumps(metadata))
(target.parent / '.install-metadata.json').write_text(json.dumps(metadata))
(repo / 'plugin.yaml').write_text('name: update-probe\nversion: 2.0.0\n')
git(repo, 'add', '.')
git(repo, 'commit', '-qm', 'new revision')
latest = git(repo, 'rev-parse', 'HEAD')

with scoped_home(home):
    if not hasattr(cadence, 'cached_git_updates'):
        rows = call('plugins.list')['plugins']
        assert rows and all('update_available' not in row and 'latest_revision' not in row for row in rows)
        try:
            call('plugins.update', key='update-probe', accept_caution=False)
        except RpcError as exc:
            assert exc.data['condition'] == 'plugin_update_unsupported', exc.to_json()
        else:
            raise AssertionError('legacy Agent must refuse plugin updates')
        print('legacy Agent: no update fields; registered update handler refuses unsupported Agent')
        sys.exit(0)
    cadence.record_check_results([{'name': 'update-probe', 'class': 'git', 'update_available': True, 'latest': latest}], metadata)
    row = next(row for row in call('plugins.list')['plugins'] if row['key'] == 'update-probe')
    assert row.get('update_available') is True, row
    assert row.get('latest_revision') == latest, row

    publications = []
    def publish(staged, dest, old_metadata, new_metadata, **kwargs):
        publications.append(str(dest))
        shutil.rmtree(dest)
        shutil.copytree(staged, dest)
        pc._write_install_metadata(new_metadata)

    from tools import plugin_guard
    from tools.skills_guard import ScanResult
    def scan(verdict):
        return ScanResult(skill_name='update-probe', source=str(repo), trust_level='community', verdict=verdict)

    for verdict, accept, expected in [('caution', False, 'needs_consent'), ('dangerous', False, 'blocked'), ('dangerous', True, 'blocked')]:
        with patch.object(plugin_guard, 'scan_plugin', return_value=scan(verdict)), patch.object(transaction, 'publish_plugin', side_effect=publish):
            result = call('plugins.update', key='update-probe', accept_caution=accept)
        assert result['status'] == expected, result
        assert result['verdict'] == verdict and result['findings'], result
        assert git(target, 'rev-parse', 'HEAD') == old
        assert not publications

    with patch.object(plugin_guard, 'scan_plugin', return_value=scan('caution')), patch.object(transaction, 'publish_plugin', side_effect=publish):
        review = call('plugins.update', key='update-probe', accept_caution=False)
        try:
            call('plugins.update', profile_home=str(other_home), key='update-probe', accept_caution=True,
                 consent_token=review.get('consent_token', 'pre-fix-missing-token'))
        except RpcError as exc:
            assert exc.data['condition'] == 'plugin_update_consent_changed', exc.to_json()
        assert not publications, 'Caution consent crossed into another profile installation'
        assert git(other_target, 'rev-parse', 'HEAD') == old
        review = call('plugins.update', key='update-probe', accept_caution=False)
        (repo / 'plugin.yaml').write_text('name: update-probe\nversion: 3.0.0\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-qm', 'revision changed during consent')
        try:
            call('plugins.update', key='update-probe', accept_caution=True, consent_token=review['consent_token'])
        except RpcError as exc:
            assert exc.data['condition'] == 'plugin_update_consent_changed', exc.to_json()
        assert not publications and git(target, 'rev-parse', 'HEAD') == old
        git(repo, 'reset', '--hard', latest)
        review = call('plugins.update', key='update-probe', accept_caution=False)
        result = call('plugins.update', key='update-probe', accept_caution=True, consent_token=review['consent_token'])
    assert result['status'] == 'updated', result
    assert git(target, 'rev-parse', 'HEAD') == latest
    assert len(publications) == 1
    row = next(row for row in call('plugins.list')['plugins'] if row['key'] == 'update-probe')
    assert row['version'] == '2.0.0' and row['update_available'] is False, row

    # TAL-1914: a catalog install re-pins through the Agent, and a widened pin needs the single-use consent.
    from hermes_cli import plugin_catalog, plugins_cmd_catalog as native

    @contextmanager
    def reviewed_catalog(live):
        # Offline: only the named synthetic entries, a safe scan and a disposable publication.
        with patch.object(plugin_catalog, 'fetch_live_catalog', return_value=None), patch.object(plugin_catalog, 'load_catalog_live', return_value=list(live.values())), \
             patch.object(native, 'get_live_catalog_entry', side_effect=live.get), patch.object(native, 'raise_if_removed'), patch.object(native, 'refuse_if_installed_removed'), \
             patch.object(transaction, 'publish_plugin', side_effect=publish), patch.object(plugin_guard, 'scan_plugin', return_value=scan('safe')):
            yield

    def refused(method, condition, **params):
        try:
            call(method, **params)
        except RpcError as exc:
            assert exc.data['condition'] == condition, exc.to_json()
            return str(exc)
        raise AssertionError(f'{method} must refuse with {condition}')

    catalog_repo = home.parent / 'catalog-upstream'
    catalog_repo.mkdir()
    git(catalog_repo, 'init', '-q')
    git(catalog_repo, 'config', 'user.email', 'probe@example.invalid')
    git(catalog_repo, 'config', 'user.name', 'Probe')
    (catalog_repo / 'plugin.yaml').write_text('name: catalog-probe\nversion: 1.0.0\n')
    (catalog_repo / '__init__.py').write_text('def register(ctx):\n    pass\n')
    git(catalog_repo, 'add', '.')
    git(catalog_repo, 'commit', '-qm', 'reviewed')
    catalog_old = git(catalog_repo, 'rev-parse', 'HEAD')
    (catalog_repo / 'plugin.yaml').write_text('name: catalog-probe\nversion: 2.0.0\nprovides_tools:\n  - widened_tool\n')
    git(catalog_repo, 'add', '.')
    git(catalog_repo, 'commit', '-qm', 'adds a tool')
    catalog_new = git(catalog_repo, 'rev-parse', 'HEAD')
    catalog_target = home / 'plugins' / 'catalog-probe'
    git(home, 'clone', '-q', str(catalog_repo), str(catalog_target))
    git(catalog_target, 'checkout', '-q', catalog_old)
    block = {'name': 'catalog-probe', 'repo': catalog_repo.as_uri(), 'tier': 'official', 'pin': catalog_old, 'sha': catalog_old}
    catalog_record = {'source': catalog_repo.as_uri(), 'revision': catalog_old, 'pinned': True, 'catalog': block}
    records = pc._read_install_metadata()
    pc._write_install_metadata({**records, 'catalog-probe': catalog_record})
    entry = plugin_catalog.PluginCatalogEntry(name='catalog-probe', repo=catalog_repo.as_uri(), sha=catalog_new, description='Synthetic',
                                              maintainer='Fixture', tier='official', category='tools')
    from hermes_cli.plugins import discover_plugins
    discover_plugins(force=True)

    with reviewed_catalog({'catalog-probe': entry}):
        row = next(row for row in call('plugins.list')['plugins'] if row['key'] == 'catalog-probe')
        assert row['update_available'] is True and row['latest_revision'] == catalog_new, row
        listed = call('plugins.catalog', query='catalog-probe', offset=0, limit=20)['entries'][0]
        assert listed['installed_key'] == 'catalog-probe' and listed['can_update'] is True, listed
        before = len(publications)
        review = call('plugins.update', key='catalog-probe', accept_caution=False)
        assert review['status'] == 'needs_consent' and review['verdict'] == 'widened' and 'widened_tool' in review['findings'], review
        assert len(publications) == before and git(catalog_target, 'rev-parse', 'HEAD') == catalog_old
        result = call('plugins.update', key='catalog-probe', accept_caution=True, consent_token=review['consent_token'])
        assert result['status'] == 'updated' and len(publications) == before + 1, result
        record = pc._read_install_metadata()['catalog-probe']
        assert record['pinned'] is True and record['catalog']['pin'] == catalog_new and record['revision'] == catalog_new, record
        row = next(row for row in call('plugins.list')['plugins'] if row['key'] == 'catalog-probe')
        assert row['update_available'] is False, row
        assert call('plugins.catalog', query='catalog-probe', offset=0, limit=20)['entries'][0]['can_update'] is False

    try:
        from hermes_cli import plugins_auto_update as auto
    except ImportError:
        assert call('plugins.auto_update') == {'supported': False, 'auto_apply': False, 'check_hours': 0}
        refused('plugins.auto_update_set', 'plugin_update_unsupported', enabled=True)
        refused('plugins.update_all', 'plugin_update_unsupported')
        print('Agent before v0.23.0: catalog re-pin passed; neither unattended control is offered')
        sys.exit(0)

    assert call('plugins.auto_update') == {'supported': True, 'auto_apply': False, 'check_hours': 24}
    assert call('plugins.auto_update_set', enabled=True)['auto_apply'] is True
    assert call('plugins.auto_update')['auto_apply'] is True
    assert call('plugins.auto_update', profile_home=str(other_home))['auto_apply'] is False, 'The switch crossed into another profile'
    assert call('plugins.auto_update_set', enabled=False)['auto_apply'] is False
    with patch('hermes_cli.config.is_managed', return_value=True):
        assert 'managed' in refused('plugins.auto_update_set', 'plugin_update_refused', enabled=True)
    assert call('plugins.auto_update')['auto_apply'] is False

    # A second updater holds the plugin's lock in another thread: the real file lock refuses and nothing moves.
    held, release = threading.Event(), threading.Event()
    def hold_lock():
        with scoped_home(home), auto.plugin_update_lock(target):
            held.set()
            release.wait(30)
    holder = threading.Thread(target=hold_lock)
    holder.start()
    assert held.wait(30)
    try:
        before = len(publications)
        assert 'already being updated' in refused('plugins.update', 'plugin_update_refused', key='update-probe', accept_caution=False)
        assert len(publications) == before
    finally:
        release.set()
        holder.join()

    # Update all over synthetic install records; only the plain update moves.
    def behind(name, revised_manifest):
        upstream = home.parent / f'{name}-upstream'
        upstream.mkdir()
        git(upstream, 'init', '-q')
        git(upstream, 'config', 'user.email', 'probe@example.invalid')
        git(upstream, 'config', 'user.name', 'Probe')
        (upstream / 'plugin.yaml').write_text(f'name: {name}\nversion: 1.0.0\n')
        (upstream / '__init__.py').write_text('def register(ctx):\n    pass\n')
        git(upstream, 'add', '.')
        git(upstream, 'commit', '-qm', 'initial')
        first = git(upstream, 'rev-parse', 'HEAD')
        installed = home / 'plugins' / name
        git(home, 'clone', '-q', str(upstream), str(installed))
        (upstream / 'plugin.yaml').write_text(revised_manifest)
        git(upstream, 'add', '.')
        git(upstream, 'commit', '-qm', 'revised')
        return upstream, installed, first

    _, moved, moved_old = behind('moved-probe', 'name: moved-probe\nversion: 2.0.0\n')
    wider_repo, wider, wider_old = behind('wider-probe', 'name: wider-probe\nversion: 2.0.0\nprovides_tools:\n  - new_tool\n')
    held_repo, held_target, held_old = behind('held-probe', 'name: held-probe\nversion: 2.0.0\n')
    records = pc._read_install_metadata()
    pc._write_install_metadata({**records,
        'moved-probe': {'source': str(home.parent / 'moved-probe-upstream'), 'revision': moved_old, 'pinned': False},
        'wider-probe': {'source': str(wider_repo), 'revision': wider_old, 'pinned': False},
        'held-probe': {'source': str(held_repo), 'revision': held_old, 'pinned': True, 'catalog': {'name': 'held-probe', 'repo': str(held_repo), 'tier': 'official', 'sha': held_old}}})
    published_before = len(publications)
    held_entry = plugin_catalog.PluginCatalogEntry(name='held-probe', repo=str(held_repo), sha=git(held_repo, 'rev-parse', 'HEAD'), description='Synthetic',
                                                   maintainer='Fixture', tier='official', category='tools')
    with reviewed_catalog({'catalog-probe': entry, 'held-probe': held_entry}):
        outcome = call('plugins.update_all')
    statuses = {row['name']: row['status'] for row in outcome['results']}
    assert statuses.get('moved-probe') == 'updated', outcome
    assert statuses.get('wider-probe') == 'needs_review', outcome
    assert statuses.get('held-probe') == 'skipped', outcome
    assert 'held with --ref' in next(row['detail'] for row in outcome['results'] if row['name'] == 'held-probe'), outcome
    assert len(publications) == published_before + 1, outcome
    assert git(moved, 'rev-parse', 'HEAD') != moved_old
    assert git(wider, 'rev-parse', 'HEAD') == wider_old, 'A widened update moved without review'
    assert git(held_target, 'rev-parse', 'HEAD') == held_old, 'Update all moved a --ref hold'
    print('catalog re-pin, profile-scoped switch, managed refusal, busy lock and Update all rows passed')
