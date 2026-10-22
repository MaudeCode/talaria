"""Real local Git pin, native scan and provenance; no account or dependency downloads."""
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
from talaria_sidecar.methods import Registry, commands

registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
commands.register(registry)
home = Path(os.environ['HERMES_HOME'])
home.mkdir(parents=True, exist_ok=True)

def call(method, **params):
    handler = registry.methods.get(method)
    return handler(None, {'profile_home': str(home), **params}) if handler else {'supported': False, 'entries': []}

try:
    from hermes_cli import plugin_catalog as catalog, plugins_cmd as pc, plugins_cmd_catalog as native
except ImportError:
    unsupported = call('plugins.catalog')
    assert unsupported['supported'] is False
    print('TYPED_CATALOG=' + json.dumps({'catalog': unsupported}))
    sys.exit(0)

repo = home.parent / 'source'
repo.mkdir()
def git(*args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
git('init', '-q')
git('config', 'user.name', 'Synthetic')
git('config', 'user.email', 'test@example.invalid')
(repo / 'plugin.yaml').write_text('name: catalog-probe\nversion: 1.0.0\n')
(repo / '__init__.py').write_text('def register(ctx):\n    pass\n')
(repo / 'pyproject.toml').write_text('[project]\nname="catalog-probe"\nversion="1.0.0"\ndependencies=[]\n')
git('add', '.')
git('commit', '-qm', 'synthetic reviewed package')
sha = git('rev-parse', 'HEAD')
entry = catalog.PluginCatalogEntry(name='catalog-probe', repo=repo.as_uri(), sha=sha,
                                   description='Synthetic pinned plugin', maintainer='Fixture', tier='official', category='tools')
with patch.object(catalog, 'load_catalog_live', return_value=[entry]), \
     patch.object(native, 'get_live_catalog_entry', return_value=entry), \
     patch.object(native, 'raise_if_removed'):
    rows = call('plugins.catalog', query='probe', offset=0, limit=20)
    assert [r['name'] for r in rows['entries']] == ['catalog-probe'], 'Plugins RPC must expose the reviewed native catalog'
    assert not (home / 'plugins' / 'catalog-probe').exists(), 'A read installed a plugin'
    review = call('plugins.install', name='catalog-probe')
    assert review['status'] == 'needs_consent', review
    assert not (home / 'plugins' / 'catalog-probe').exists()
    # A dangerous verdict at the reviewed pin still cannot reach publication.
    from tools import plugin_guard
    from tools.skills_guard import ScanResult
    with patch.object(plugin_guard, 'scan_plugin', return_value=ScanResult(skill_name='catalog-probe', source=str(repo), trust_level='official', verdict='dangerous')):
        blocked = call('plugins.install', name='catalog-probe', consent_token=review['consent_token'])
    assert blocked['status'] == 'blocked' and not (home / 'plugins' / 'catalog-probe').exists(), blocked
    review = call('plugins.install', name='catalog-probe')
    result = call('plugins.install', name='catalog-probe', consent_token=review['consent_token'])
    assert result['status'] == 'installed' and result['enabled'] is False, result
    record = json.loads((home / 'plugins' / '.install-metadata.json').read_text())['catalog-probe']
    assert record['catalog']['sha'] == sha and record['catalog']['pin'] == sha, record
    assert 'catalog-probe' not in pc._get_enabled_set()
    listed = call('plugins.list', selected_providers={})
    installed_row = next(row for row in listed['plugins'] if row['key'] == 'catalog-probe')
    assert installed_row['enabled'] is False, installed_row
    assert call('plugins.catalog', query='', offset=0, limit=20)['entries'][0]['installed_key'] == 'catalog-probe'
    # Use the native dependency-consent boundary; never run the package resolver for this fixture.
    (repo / 'pyproject.toml').write_text('[project]\nname="dependency-probe"\nversion="1.0.0"\ndependencies=["synthetic-never-install==1"]\n')
    consented, _reason = pc._install_plugin_python_deps({'name': 'dependency-probe'}, repo, pc._console(), assume_yes=False)
    assert consented is False, 'Nonempty dependencies were approved without owner consent'
print('TYPED_CATALOG=' + json.dumps({'catalog': rows, 'review': review, 'blocked': blocked, 'installed': result}))
