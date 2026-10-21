"""Real Agent Git/cache/scan compatibility; final PM publication uses disposable trees."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
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
    print('cached local update, caution consent, dangerous refusal and refreshed listing passed')
