"""Real pinned native structured API and Talaria adapter, with disposable profile/source trees."""
import json
import os
from pathlib import Path
import shutil
import sys
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
from talaria_sidecar.methods import build_methods
from talaria_sidecar.methods import plugin_catalog, agent_imports
from types import SimpleNamespace
from hermes_cli import plugin_catalog as catalog
from hermes_constants import get_hermes_home

home = get_hermes_home().resolve()
home.mkdir(parents=True)
plugin = home / 'plugins/agent-importers'
plugin.parent.mkdir()
shutil.copytree(sys.argv[2], plugin)
pin = 'b5932f1b03ccd0f7738cb4975318df990408f3a3'
repo = 'https://github.com/NousResearch/hermes-official-plugins'
(plugin.parent / '.install-metadata.json').write_text(json.dumps({'agent-importers': {'revision': pin, 'catalog': {'name': 'agent-importers', 'sha': pin, 'pin': pin, 'repo': repo}}}))
(home / 'config.yaml').write_text('plugins:\n  enabled: [agent-importers]\nmcp_servers:\n  existing:\n    command: keep-me\n')
source = Path.home() / '.cursor'
(source / 'rules').mkdir(parents=True)
(source / 'rules/fixture.mdc').write_text('---\nglobs: "*"\n---\n- Use synthetic examples.\n')
(source / 'mcp.json').write_text(json.dumps({'mcpServers': {'existing': {'command': 'do-not-overwrite'}, 'probe': {'command': 'probe', 'env': {'API_TOKEN': 'DECOY-SECRET', 'REGION': 'test'}}}}))
(source / 'cli-config.json').write_text('DECOY-CREDENTIAL')
(home / 'memories').mkdir()
(home / 'memories/MEMORY.md').write_text('Prior memory entry.\n')
for name in ('one', 'existing'):
    (source / 'skills' / name).mkdir(parents=True)
    (source / 'skills' / name / 'SKILL.md').write_text('Synthetic skill ' + name)
(source / 'skills/one/run.sh').write_text('#!/bin/sh\ntrue\n')
(source / 'skills/one/run.sh').chmod(0o755)
(source / 'skills/one/.env').write_text('API_TOKEN=DECOY-SKILL-SECRET')
(home / 'skills/cursor-imports/existing').mkdir(parents=True)
(home / 'skills/cursor-imports/existing/SKILL.md').write_text('Keep existing skill')
methods = build_methods(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
def call(action, **params):
    return methods['profiles.import'](None, dict(profile_home=str(home), action=action, **params))
entry = catalog.get_catalog_entry('agent-importers')
if entry is None or entry.sha != pin:
    before = {str(p): p.read_bytes() for p in home.rglob('*') if p.is_file()}
    unavailable = call('discover')
    assert unavailable['status'] == 'unavailable', unavailable
    after = {str(p): p.read_bytes() for p in home.rglob('*') if p.is_file()}
    assert after == before, 'Changed profile files: ' + repr([name for name in after.keys() | before.keys() if after.get(name) != before.get(name)])
    print('NATIVE_IMPORT=' + json.dumps({'unavailable': unavailable}))
    sys.exit(0)
with patch.object(catalog, 'fetch_live_catalog', side_effect=AssertionError('Import must never fetch the catalog')), patch.object(agent_imports, '_refresh_runtime', return_value=True):
    assert plugin_catalog.reviewed_importer(home) is not None, 'Reviewed native API admission failed'
    assert call('discover')['sources'] == [{'agent': 'cursor', 'label': 'Cursor'}]
    before = {str(p): p.read_bytes() for p in home.rglob('*') if p.is_file()}
    preview = call('preview', agent='cursor')
    assert preview['status'] == 'preview' and preview['can_apply'], preview
    assert {str(p): p.read_bytes() for p in home.rglob('*') if p.is_file()} == before, 'Preview changed the profile'
    assert 'DECOY' not in json.dumps(preview)
    result = call('apply', receipt=preview['receipt'])
    assert result['status'] == 'applied', result
    assert 'Use synthetic examples.' in (home / 'memories/MEMORY.md').read_text()
    assert 'globs' not in (home / 'memories/MEMORY.md').read_text()
    config = (home / 'config.yaml').read_text()
    assert 'keep-me' in config and 'do-not-overwrite' not in config and 'DECOY' not in config
    assert json.loads((home / 'import-sync.json').read_text())['agents']['cursor']['source'] == str(source)
    assert call('apply', receipt=preview['receipt']) == result
    assert call('result', receipt=preview['receipt']) == result
    assert list((home / 'memories').glob('MEMORY.md.bak.*')), 'Native memory backup was lost'
    assert (home / 'skills/cursor-imports/existing/SKILL.md').read_text() == 'Keep existing skill'
    assert (home / 'skills/cursor-imports/one/run.sh').stat().st_mode & 0o777 == 0o755
    assert not (home / 'skills/cursor-imports/one/.env').exists()
    for name, directory, instruction in [('codex', '.codex', 'AGENTS.md'), ('claude-code', '.claude', 'CLAUDE.md')]:
        folder = Path.home() / directory
        folder.mkdir()
        (folder / instruction).write_text('- Synthetic ' + name + ' instruction.')
        if name == 'codex':
            (folder / 'config.toml').write_text('[mcp_servers.codex_probe]\ncommand="probe"\n')
        else:
            (folder / 'settings.json').write_text('{"permissions":{"allow":["Bash(npm test:*)"]}}')
            (folder.parent / '.claude.json').write_text('{"mcpServers":{"claude_probe":{"command":"probe"}}}')
        next_preview = call('preview', agent=name)
        assert next_preview['can_apply'], next_preview
        assert call('apply', receipt=next_preview['receipt'])['status'] == 'applied'
        assert 'Synthetic ' + name + ' instruction.' in (home / 'memories/MEMORY.md').read_text()
    (home / 'config.yaml').write_text('plugins:\n  disabled: [agent-importers]\n')
    assert call('discover')['status'] == 'unavailable'
print('NATIVE_IMPORT=' + json.dumps({'preview': preview, 'applied': result}))
