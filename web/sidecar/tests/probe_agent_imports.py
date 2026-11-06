"""Real pinned native structured API and Talaria adapter, with disposable profile/source trees."""
import dataclasses
import json
import os
from pathlib import Path
import shutil
import sqlite3
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
reviewed = json.loads((Path(plugin_catalog.__file__).parents[2] / 'agent_importer.json').read_text())['revisions']
entry = catalog.get_catalog_entry('agent-importers')
# The revision this Agent's catalog pins; an unreviewed or missing pin installs any reviewed tree and must refuse.
pin = entry.sha if entry is not None and entry.sha in reviewed else next(iter(reviewed))
shutil.copytree(Path(sys.argv[2]) / pin, plugin)
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
    # An unreviewed catalog pin or a changed reviewed file refuses admission.
    unreviewed = dataclasses.replace(entry, sha='0' * 40)
    with patch.object(catalog, 'load_catalog', return_value=[unreviewed]):
        assert plugin_catalog.reviewed_importer(home) is None, 'Unreviewed catalog pin was admitted'
    body = (plugin / 'importer.py').read_bytes()
    (plugin / 'importer.py').write_bytes(body + b'\n')
    assert plugin_catalog.reviewed_importer(home) is None, 'Changed reviewed file was admitted'
    (plugin / 'importer.py').write_bytes(body)
    assert plugin_catalog.reviewed_importer(home) is not None
    sources = {row['agent']: row for row in call('discover')['sources']}
    assert {'cursor', 'grok-bot', 'openbot'} <= sources.keys(), 'Grok Bot and OpenBot rows are missing: ' + repr(sources)
    assert sources['cursor']['available'] and sources['cursor']['input'] == 'none'
    assert sources['grok-bot']['available'] and sources['grok-bot']['input'] == 'file'
    assert 'grok-bot-export' in sources['grok-bot']['export_prompt']
    assert not sources['openbot']['available'] and sources['openbot']['input'] == 'none'
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
    # Grok Bot: a Bot-written export, never a path to a local folder or an MCP command.
    def snapshot(root):
        # Admission's config read leaves the Agent's own last-known-good copy after each config edit.
        return {str(p): p.read_bytes() for p in root.rglob('*') if p.is_file() and 'backups' not in p.relative_to(root).parts}
    def unchanged(before, why):
        after = snapshot(home)
        assert after == before, why + ': ' + repr([name for name in after.keys() | before.keys() if after.get(name) != before.get(name)])
    def jobs():
        return json.loads((home / 'cron/jobs.json').read_text())['jobs']
    private = Path.home() / 'private-skill'
    private.mkdir()
    (private / 'SKILL.md').write_text('---\nname: private\ndescription: d\n---\n\nDECOY-LOCAL-FOLDER\n')
    export = {'format': 'grok-bot-export', 'version': 1, 'bots': [{
        'name': 'Account Health', 'title': 'Customer success',
        'instructions': 'Own the weekly account review.',
        'memories': ['Churn signal: three weeks without a login', 'Token sk-abcdefghijklmnopqrstuvwx is old'],
        'user_facts': ['Works in America/New_York'],
        'skills': [{'name': 'Weekly review', 'description': 'Score accounts', 'instructions': 'Pull usage.'},
                   {'name': 'Local folder', 'path': str(private)}],
        'routines': [{'name': 'Morning list', 'instruction': 'Run the Weekly review skill.', 'trigger': 'schedule',
                      'schedule_cron': '0 8 * * 1-5', 'timezone': 'America/New_York', 'skills': ['Weekly review']},
                     {'name': 'Escalations', 'instruction': 'Reproduce it.', 'trigger': 'slack', 'trigger_details': '#escalations'}],
        'apps': [{'name': 'Linear', 'mcp_url': 'https://mcp.example.invalid/mcp'}],
        'mcp_servers': {'export_command': {'command': 'DECOY-COMMAND'}}}]}
    before = snapshot(home)
    grok = call('preview', agent='grok-bot', export_text=json.dumps(export))
    assert grok['status'] == 'preview' and grok['can_apply'], grok
    unchanged(before, 'Grok Bot preview changed the profile')
    importable = {item['kind']: item['label'] for item in grok['items'] if item['status'] == 'imported'}
    assert {'memories', 'user-facts', 'skill', 'routine', 'event-routines', 'mcp-servers'} <= importable.keys(), grok
    assert importable['routine'] == 'Routine (paused task)'
    assert grok['stripped_secrets'] == ['grok-bot-export.json: 1 token-like value(s) redacted'], grok
    assert 'DECOY' not in json.dumps(grok) and 'sk-abc' not in json.dumps(grok)
    assert call('apply', receipt=grok['receipt'])['status'] == 'applied'
    assert not (home / 'grok-bot-export.json').exists()
    [job] = jobs()
    assert job['name'] == 'Account Health: Morning list' and job['enabled'] is False and job['skills'] == ['weekly-review'], job
    assert 'Pull usage.' in (home / 'skills/grok-bot-imports/weekly-review/SKILL.md').read_text()
    assert not (home / 'skills/grok-bot-imports/local-folder').exists(), 'An export named a local folder'
    assert 'three weeks without a login' in (home / 'memories/MEMORY.md').read_text()
    assert 'sk-abc' not in (home / 'memories/MEMORY.md').read_text()
    assert 'America/New_York' in (home / 'memories/USER.md').read_text()
    assert 'Own the weekly account review.' in (home / 'SOUL.md').read_text()
    assert (home / 'grok-bot-import/account-health-event-routines.md').is_file()
    config = (home / 'config.yaml').read_text()
    assert 'mcp.example.invalid' in config and 'DECOY-COMMAND' not in config
    credential = {'format': 'grok-bot-export', 'version': 1, 'bots': [{'name': 'Leaky', 'api_key': 'DECOY-EXPORT-KEY', 'memories': ['Nothing']}]}
    before = snapshot(home)
    credential_refusal = call('preview', agent='grok-bot', export_text=json.dumps(credential))
    assert credential_refusal['status'] == 'preview' and not credential_refusal['can_apply'] and credential_refusal['receipt'] is None, credential_refusal
    assert ('export', 'error') in [(item['kind'], item['status']) for item in credential_refusal['items']], credential_refusal
    assert credential_refusal['message'] and 'DECOY' not in json.dumps(credential_refusal) and 'api_key' not in json.dumps(credential_refusal)
    unchanged(before, 'A refused export changed the profile')
    # OpenBot: read-only extract of its database plus each agent's skill folders.
    user_data = Path.home() / '.config/OpenBot'
    user_data.mkdir(parents=True)
    workspace = Path.home() / 'OpenBot/Agents/agent-1'
    for root, name, managed in (('.agents/skills', 'triage', False), ('.claude/skills', 'triage', False), ('.agents/skills', 'bundled', True)):
        folder = workspace / root / name
        folder.mkdir(parents=True)
        (folder / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: d\n---\n\nSort the inbox.\n')
        if managed:
            (folder / '.openbot-managed.json').write_text('{}')
    db = sqlite3.connect(user_data / 'openbot.db')
    db.execute('PRAGMA journal_mode = WAL')
    db.executescript('''
        CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, sort_order INTEGER, agent_json TEXT);
        CREATE TABLE projection_agent_memories (memory_id TEXT PRIMARY KEY, agent_id TEXT, text TEXT, created_at TEXT);
        CREATE TABLE projection_agent_routines (routine_id TEXT PRIMARY KEY, agent_id TEXT, name TEXT, instruction TEXT, active INTEGER, timezone TEXT, created_at TEXT);
        CREATE TABLE projection_routine_triggers (trigger_id TEXT PRIMARY KEY, routine_id TEXT, schedule_json TEXT);
        CREATE TABLE projection_mcp_servers (mcp_server_id TEXT PRIMARY KEY, name TEXT, transport TEXT, enabled INTEGER, command TEXT, args_json TEXT, env_json TEXT, env_passthrough_json TEXT, working_directory TEXT, url TEXT, headers_json TEXT, position INTEGER);
        CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY, text TEXT);
        INSERT INTO projection_thread_messages VALUES ('m1', 'DECOY-CHAT-HISTORY');
    ''')
    db.execute('INSERT INTO projection_agents VALUES (?, 0, ?)', ('agent-1', json.dumps({'name': 'Inbox Keeper', 'description': 'Keep the inbox at zero.', 'workspacePath': str(workspace)})))
    db.execute("INSERT INTO projection_agent_memories VALUES ('m1', 'agent-1', 'Archive newsletters on sight', 't')")
    db.execute("INSERT INTO projection_agent_routines VALUES ('r1', 'agent-1', 'Inbox sweep', 'Sweep the inbox.', 1, 'UTC', 't')")
    db.execute('INSERT INTO projection_routine_triggers VALUES (?, ?, ?)', ('t1', 'r1', json.dumps({'kind': 'daily', 'time': '07:30'})))
    db.execute("INSERT INTO projection_mcp_servers VALUES ('s1', 'openbot_tools', 'stdio', 1, 'probe', '[]', ?, '[]', '', '', '[]', 0)", (json.dumps([{'key': 'API_TOKEN', 'value': 'DECOY-MCP-SECRET'}, {'key': 'REGION', 'value': 'test'}]),))
    db.commit()
    db.close()
    database = (user_data / 'openbot.db').read_bytes()
    assert {row['agent']: row['available'] for row in call('discover')['sources']}['openbot'] is True
    before = snapshot(home)
    openbot = call('preview', agent='openbot')
    assert openbot['status'] == 'preview' and openbot['can_apply'], openbot
    unchanged(before, 'OpenBot preview changed the profile')
    assert openbot['stripped_secrets'] == ['mcp_servers.openbot_tools.env.API_TOKEN'], openbot
    assert 'DECOY' not in json.dumps(openbot)
    assert call('apply', receipt=openbot['receipt'])['status'] == 'applied'
    assert (user_data / 'openbot.db').read_bytes() == database, 'OpenBot source was modified'
    swept = next(job for job in jobs() if job['name'] == 'Inbox Keeper: Inbox sweep')
    assert swept['enabled'] is False and swept['schedule']['expr'] == '30 7 * * *', swept
    assert 'Sort the inbox.' in (home / 'skills/openbot-imports/triage/SKILL.md').read_text()
    assert not (home / 'skills/openbot-imports/bundled').exists()
    assert 'Archive newsletters on sight' in (home / 'memories/MEMORY.md').read_text()
    # SOUL.md already holds the Grok Bot role, so the second source's role joins memory.
    assert 'Keep the inbox at zero.' in (home / 'memories/MEMORY.md').read_text()
    config = (home / 'config.yaml').read_text()
    assert 'openbot_tools' in config and 'DECOY' not in config
    assert 'DECOY' not in json.dumps({k: v.decode(errors='replace') for k, v in snapshot(home).items()}), 'A decoy reached the profile'
    # A reviewed importer without the Bot modules reports both sources unavailable.
    older = next(sha for sha, files in reviewed.items() if 'grok_bot.py' not in files)
    current = (plugin.parent / '.install-metadata.json').read_text()
    shutil.move(plugin, home / 'reviewed-plugin')
    shutil.copytree(Path(sys.argv[2]) / older, plugin)
    (plugin.parent / '.install-metadata.json').write_text(current.replace(pin, older))
    for name in [name for name in sys.modules if name.startswith('_talaria_reviewed_agent_importers')]:
        del sys.modules[name]
    before = snapshot(home)
    with patch.object(catalog, 'load_catalog', return_value=[dataclasses.replace(entry, sha=older)]):
        rows = {row['agent']: row for row in call('discover')['sources']}
        assert not rows['grok-bot']['available'] and not rows['openbot']['available'], rows
        assert rows['grok-bot']['detail'] and rows['cursor']['available']
        assert call('preview', agent='grok-bot', export_text='{}')['status'] == 'unavailable'
        assert call('preview', agent='openbot')['status'] == 'unavailable'
    unchanged(before, 'An unavailable source changed the profile')
    shutil.rmtree(plugin)
    shutil.move(home / 'reviewed-plugin', plugin)
    (plugin.parent / '.install-metadata.json').write_text(current)
    for name in [name for name in sys.modules if name.startswith('_talaria_reviewed_agent_importers')]:
        del sys.modules[name]
    (source / 'mcp.json').write_text('{"mcpServers":{"managed_probe":{"command":"never-run"}}}')
    managed_preview = call('preview', agent='cursor')
    assert managed_preview['can_apply'], managed_preview
    (home / '.managed').write_text('nix')
    before_managed = {str(p): p.read_bytes() for p in home.rglob('*') if p.is_file()}
    refused = call('apply', receipt=managed_preview['receipt'])
    assert refused['status'] == 'unavailable', 'Package-managed config import must be refused: ' + repr(refused)
    assert {str(p): p.read_bytes() for p in home.rglob('*') if p.is_file()} == before_managed
    (home / '.managed').unlink()
    with patch('hermes_constants.get_managed_system', side_effect=RuntimeError('DECOY-POLICY-ERROR')):
        before_unknown = {str(p): p.read_bytes() for p in home.rglob('*') if p.is_file()}
        refused = call('preview', agent='cursor')
        assert refused['status'] == 'unavailable'
        assert 'DECOY' not in json.dumps(refused)
        assert {str(p): p.read_bytes() for p in home.rglob('*') if p.is_file()} == before_unknown
    (home / 'config.yaml').write_text('plugins:\n  disabled: [agent-importers]\n')
    assert call('discover')['status'] == 'unavailable'
print('NATIVE_IMPORT=' + json.dumps({'preview': preview, 'applied': result, 'grok': grok, 'credential_refusal': credential_refusal, 'openbot': openbot}))
