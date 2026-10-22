"""Talaria preview ownership, paging and refusals run without an Agent or children."""
from dataclasses import dataclass, asdict, field
import sys
from types import ModuleType, SimpleNamespace

import pytest

from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import plugin_catalog as subject


@pytest.fixture
def catalog(monkeypatch, tmp_path):
    @dataclass
    class Entry:
        name: str = 'probe'
        title: str = 'Probe'
        repo: str = 'https://example.invalid/plugin'
        sha: str = 'a' * 40
        description: str = 'Synthetic calendar tools'
        tier: str = 'verified'
        category: str = 'tools'
        requires_hermes: str = ''
        platforms: list = field(default_factory=list)
        known_issues: list = field(default_factory=list)
        capabilities: object = field(default_factory=lambda: SimpleNamespace(requires_env=[], provides_tools=[], provides_hooks=[], provides_middleware=[]))
        def to_dict(self):
            return {**asdict(self), 'capabilities': vars(self.capabilities)}

    state = {'home': tmp_path / 'default', 'entries': [Entry()], 'now': 0, 'removed': False,
             'manifest': {'name': 'probe'}, 'deps': [], 'selected': False, 'scan': 'safe', 'tree': 'first', 'metadata': {}}
    effects = []
    class OperationError(Exception):
        pass
    class ScanBlocked(OperationError):
        def __init__(self, scan):
            self.scan_result = scan
            super().__init__(scan.report)
    def removed(*_):
        if state['removed']:
            raise OperationError('Removed by catalog owner')
    def transaction(entry, **kwargs):
        assert kwargs['force'] is False and kwargs['assume_deps_consent'] is False and kwargs['ref'] == entry.sha
        tree = tmp_path / 'stage'
        tree.mkdir(exist_ok=True)
        (tree / 'plugin.yaml').write_text(state['tree'])
        kwargs['before_swap'](state['manifest'], tree)
        scan = SimpleNamespace(verdict=state['scan'], report=state['scan'], scan_provenance={}, findings=[])
        if scan.verdict == 'dangerous':
            raise ScanBlocked(scan)
        effects.append(entry.name)
        return tree, state['manifest'], state['manifest']['name']
    pc = SimpleNamespace(PluginOperationError=OperationError, PluginScanBlocked=ScanBlocked,
        _read_install_metadata=lambda: state['metadata'], _plugins_dir=lambda: state['home'] / 'plugins',
        _sanitize_plugin_name=lambda name, root: root / name)
    native = SimpleNamespace(raise_if_removed=removed, _refuse_unsupported_catalog_platform=lambda _: None, install_catalog_entry=transaction)
    source = SimpleNamespace(load_catalog_live=lambda: state['entries'])
    monkeypatch.setattr(subject, '_agent', lambda: (source, pc, native))
    monkeypatch.setattr(subject, '_receipts', {})
    monkeypatch.setattr(subject, 'time', SimpleNamespace(monotonic=lambda: state['now']))
    def module(name, **values):
        m = ModuleType(name)
        m.__path__ = []
        m.__dict__.update(values)
        monkeypatch.setitem(sys.modules, name, m)
    module('hermes_constants', get_hermes_home=lambda: state['home'])
    module('hermes_cli')
    module('hermes_cli.plugins_manifest', requires_hermes_error=lambda m: 'Incompatible Hermes version' if m.get('requires_hermes') else None)
    module('hermes_cli.plugin_capabilities', VALID_CAPABILITY_IDS={'tools.override'})
    module('pm')
    module('pm.plugin_declarations', read_python_declaration=lambda _: SimpleNamespace(install_requirements=state['deps']))
    module('pm.workspace', enabled_plugin_dirs=lambda **_: {state['home'] / 'plugins' / 'probe'} if state['selected'] else set())
    module('tools')
    module('tools.plugin_guard', format_scan_report=lambda s: s.report)
    return state, effects, Entry


@pytest.mark.parametrize('change', ['profile', 'pin', 'source', 'requirements', 'tree', 'expired', 'removed', 'unknown', 'missing'])
def test_confirmation_cannot_cross_changed_evidence(catalog, change):
    state, effects, _ = catalog
    token = subject.install('probe')['consent_token']
    if change == 'profile': state['home'] = state['home'].parent / 'other'
    elif change == 'pin': state['entries'][0].sha = 'b' * 40
    elif change == 'source': state['entries'][0].repo += '/different'
    elif change == 'requirements': state['deps'] = ['synthetic-package']
    elif change == 'tree': state['tree'] = 'replacement'
    elif change == 'expired': state['now'] = 301
    elif change == 'removed': state['removed'] = True
    elif change == 'missing': state['entries'] = []
    else: token = 'unknown'
    try:
        result = subject.install('probe', token)
        assert result['status'] == 'blocked'
    except RpcError as exc:
        assert exc.data['condition'] in {'plugin_install_consent_changed', 'plugin_install_refused'}
    assert effects == []


def test_native_dangerous_refusal_cannot_be_overridden_and_tokens_are_single_use(catalog):
    state, effects, _ = catalog
    review = subject.install('probe')
    state['scan'] = 'dangerous'
    assert subject.install('probe', review['consent_token'])['status'] == 'blocked'
    assert effects == []
    state['scan'] = 'safe'
    review = subject.install('probe')
    assert subject.install('probe', review['consent_token'])['enabled'] is False
    assert effects == ['probe']
    with pytest.raises(RpcError): subject.install('probe', review['consent_token'])


@pytest.mark.parametrize('refusal', ['unknown_capability', 'selected', 'version'])
def test_unknown_or_incompatible_or_selected_plugin_is_not_published(catalog, refusal):
    state, effects, _ = catalog
    if refusal == 'unknown_capability': state['manifest']['capabilities'] = ['future.unknown']
    elif refusal == 'selected': state['selected'] = True
    else: state['manifest']['requires_hermes'] = '>=999'
    assert subject.install('probe')['status'] == 'blocked'
    assert effects == []


def test_read_is_bounded_searchable_and_uses_installer_identity(catalog):
    state, effects, Entry = catalog
    state['entries'] += [Entry(name='alpha'), Entry(name='omega', category='memory')]
    installed = state['home'] / 'plugins' / 'different-manifest-name'
    installed.mkdir(parents=True)
    state['metadata'] = {'different-manifest-name': {'revision': 'a' * 40, 'catalog': {'name': 'probe'}}}
    first = subject.catalog('', 0, 2)
    assert [e['name'] for e in first['entries']] == ['alpha', 'omega'] and first['next_offset'] == 2
    row = subject.catalog('verified', 2, 2)['entries'][0]
    assert row['installed_key'] == 'different-manifest-name' and row['can_install'] is False
    assert subject.catalog('memory', 0, 20)['total'] == 1
    assert effects == []


def test_tree_review_binds_permissions_and_refuses_oversized_content(tmp_path):
    file = tmp_path / 'script.py'
    file.write_text('pass\n')
    before = subject._tree_digest(tmp_path)
    file.chmod(0o755)
    assert subject._tree_digest(tmp_path) != before
    with file.open('wb') as stream:
        stream.truncate(64 * 1024 * 1024 + 1)
    with pytest.raises(RpcError, match='bounded review size'):
        subject._tree_digest(tmp_path)
