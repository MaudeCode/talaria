"""``chat.start`` without a session override builds the Agent with the profile's ``platform_toolsets.cli``, resolved by
the pinned Agent's own ``_get_platform_tools`` under the turn's profile home; an override still replaces it."""

from __future__ import annotations

import json
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

# Runs on the Agent interpreter: real config loading and toolset resolution, a stand-in AIAgent that records its kwargs.
PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat
from toolsets import resolve_toolset

seen = []

class FakeAgent:
    def __init__(self, **kwargs):
        seen.append(kwargs.get("enabled_toolsets"))

    def run_conversation(self, **kwargs):
        return {"final_response": "ok", "messages": []}

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._agent_class = lambda: FakeAgent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
root = Path(os.environ["HERMES_HOME"])
cases = [("custom", None), ("plain", None), ("legacy", None), ("custom", ["memory"])]
for i, (profile, override) in enumerate(cases):
    home = root if profile == "custom" else root / "profiles" / profile
    params = {"profile_home": str(home), "session_id": f"s{i}", "stream_id": f"st{i}", "user_message": "hi", "model": "m", "model_provider": "p", "enabled_toolsets": override}
    with scoped_home(home):
        result = chat.start(Ctx(), params)
    assert result["status"] == "completed", result
print(json.dumps([seen, [sorted({tool for name in toolsets for tool in resolve_toolset(name)}) for toolsets in seen]]))
"""


@requires_agent
def test_turn_toolsets_follow_the_profile_config_unless_overridden(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "config.yaml").write_text("platform_toolsets:\n  cli: [web, file, memory]\n")
    (root / "profiles" / "plain").mkdir(parents=True)
    (root / "profiles" / "legacy").mkdir(parents=True)
    (root / "profiles" / "legacy" / "config.yaml").write_text("platform_toolsets:\n  cli: [hermes]\n")
    env = isolated_env(root)
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    (custom, plain, legacy, override), (_, plain_tools, legacy_tools, _) = json.loads(run.stdout.strip().splitlines()[-1])
    # The profile's saved CLI list, nothing it omitted.
    assert isinstance(custom, list) and {"web", "file", "memory"} <= set(custom), custom
    assert "terminal" not in custom and "browser" not in custom, custom
    # No saved list: the CLI default, with the Agent's default-off toolsets still off.
    assert isinstance(plain, list) and {"terminal", "file", "web"} <= set(plain), plain
    assert not {"homeassistant", "discord_admin", "kanban", "spotify"} & set(plain), plain
    # The legacy ``hermes`` name is never passed through and still grants every tool of the CLI default.
    assert isinstance(legacy, list) and "hermes" not in legacy and set(plain_tools) <= set(legacy_tools), legacy
    # A session-level override replaces the profile default.
    assert override == ["memory"]


POLICY_PROBE = r'''
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat
from model_tools import get_tool_definitions, _dispatch_bridge_tool
from agent import conversation_compression_manual as manual
from types import SimpleNamespace

seen = []
class Agent:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.session_id = kwargs['session_id']
        seen.append(self)
    def run_conversation(self, **kwargs):
        return {'final_response': 'ok', 'messages': []}
    def close(self):
        pass
class Ctx:
    cancelled = False
    def emit(self, *args):
        pass
chat._agent_class = lambda: Agent
chat._resolve_runtime = lambda *args: {'model': 'm', 'provider': 'p', 'api_key': 'synthetic'}
chat._discover_mcp_tools = lambda run: None
manual.compress_now = lambda *a, **k: SimpleNamespace(status='lock_skipped', after_messages=[], before_tokens=0, after_tokens=0, summary=None)
manual.render_compress_result = lambda result: []
root = Path(os.environ['HERMES_HOME'])
params = {'profile_home': str(root), 'session_id': 'policy-session', 'stream_id': 'one', 'model': 'm', 'model_provider': 'p', 'user_message': 'hi', 'enabled_toolsets': ['todo', 'file'], 'conversation_history': []}

def catalog(agent):
    kw = {k: agent.kwargs.get(k) for k in ('enabled_toolsets', 'disabled_toolsets')}
    raw = get_tool_definitions(**kw, quiet_mode=True, skip_tool_search_assembly=True)
    search, _ = _dispatch_bridge_tool('tool_search', {'queries': ['todo']}, **kw)
    describe, _ = _dispatch_bridge_tool('tool_describe', {'names': ['todo_list']}, **kw)
    return {'tools': [d['function']['name'] for d in raw], 'search': search, 'describe': describe}

with scoped_home(root):
    assert chat.start(Ctx(), params)['status'] == 'completed'
    initial = catalog(seen[-1])
(root / 'config.yaml').write_text('agent:\n  disabled_toolsets: [todo]\nplatform_toolsets:\n  cli: [file, todo]\n')
with scoped_home(root):
    assert chat.start(Ctx(), {**params, 'stream_id': 'two'})['status'] == 'completed'
    turn = catalog(seen[-1])
    chat.compress(Ctx(), params)
    compression = catalog(seen[-1])
print(json.dumps({'initial': initial, 'turn': turn, 'compression': compression, 'constructions': len(seen)}))
'''


@requires_agent
def test_disabled_toolsets_win_over_overrides_and_cached_agents(tmp_path) -> None:
    root = tmp_path / '.hermes'
    root.mkdir()
    (root / 'config.yaml').write_text('platform_toolsets:\n  cli: [file, todo]\n')
    run = subprocess.run([AGENT_PYTHON, '-c', POLICY_PROBE, str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    result = json.loads(run.stdout.strip().splitlines()[-1])
    assert 'todo_list' in result['initial']['tools']
    assert 'todo_list' in result['initial']['search']
    for path in ('turn', 'compression'):
        assert 'todo_list' not in result[path]['tools'], f'{path} re-enabled disabled todo: {result[path]}'
        assert 'read_file' in result[path]['tools']
        assert 'todo_list' not in json.dumps(result[path]['search'])
        # v0.22.3 reports a registered tool absent from the session under errors, earlier Agents under not_found.
        describe = json.loads(result[path]['describe'])
        assert 'todo_list' not in describe.get('tools', {})
        assert 'todo_list' in describe.get('not_found', []) or 'todo_list' in describe.get('errors', {})
    assert result['constructions'] == 3, 'a policy change must replace the cached Agent'


@requires_agent
def test_catalog_reports_profile_policy_and_preserves_unknown_selection(handshaken, hermes_home) -> None:
    (hermes_home / 'config.yaml').write_text('agent:\n  disabled_toolsets: "[\'todo\']"\nplatform_toolsets:\n  cli: [file, todo]\n')
    params = {'profile_home': str(hermes_home), 'enabled_toolsets': ['todo', 'file', 'missing-toolset']}
    result = handshaken.result('toolsets.catalog', params)
    rows = {r['name']: r for r in result['toolsets']}
    assert rows['todo']['available'] is False
    assert rows['todo']['unavailable_reason'] == 'disabled'
    assert rows['todo']['selected'] is True
    assert rows['file']['available'] is True
    assert rows['missing-toolset']['available'] is False
    assert result['selected_toolsets'] == params['enabled_toolsets']
    defaults = handshaken.result('toolsets.catalog', {**params, 'enabled_toolsets': None})
    assert defaults['using_defaults'] is True
    assert 'todo' not in defaults['selected_toolsets']
    named = hermes_home / 'profiles' / 'clean'
    named.mkdir(parents=True)
    (named / 'config.yaml').write_text('platform_toolsets:\n  cli: [todo]\n')
    clean = handshaken.result('toolsets.catalog', {'profile_home': str(named), 'enabled_toolsets': None})
    assert next(r for r in clean['toolsets'] if r['name'] == 'todo')['available'] is True


@requires_agent
def test_catalog_discovers_named_profile_plugin_before_any_turn(handshaken, hermes_home) -> None:
    named = hermes_home / 'profiles' / 'plugin-profile'
    plugin = named / 'plugins' / 'catalog-plugin'
    plugin.mkdir(parents=True)
    (plugin / 'plugin.yaml').write_text('name: catalog-plugin\nversion: 0.0.1\n')
    (plugin / '__init__.py').write_text('''def register(ctx):
    ctx.register_tool(name='catalog_probe', toolset='catalog_plugin',
        schema={'name': 'catalog_probe', 'description': 'Synthetic catalog tool', 'parameters': {'type': 'object', 'properties': {}}},
        handler=lambda args, **kwargs: '{}')
''')
    config = 'plugins:\n  isolation: in_process\n  enabled: [catalog-plugin]\nplatform_toolsets:\n  cli: [catalog_plugin]\n'
    (named / 'config.yaml').write_text(config)
    params = {'profile_home': str(named), 'enabled_toolsets': ['file']}
    rows = handshaken.result('toolsets.catalog', params)['toolsets']
    dynamic = [row for row in rows if row['name'] == 'catalog_plugin']
    assert len(dynamic) == 1, 'first-open catalog omitted the installed plugin toolset'
    assert dynamic[0]['available'] is True and dynamic[0]['selected'] is False
    defaults = handshaken.result('toolsets.catalog', {**params, 'enabled_toolsets': None})
    assert 'catalog_plugin' in defaults['selected_toolsets']
    (named / 'config.yaml').write_text(config + 'agent:\n  disabled_toolsets: [catalog_plugin]\n')
    rows = handshaken.result('toolsets.catalog', {**params, 'enabled_toolsets': ['catalog_plugin']})['toolsets']
    assert next(row for row in rows if row['name'] == 'catalog_plugin')['available'] is False
    other = handshaken.result('toolsets.catalog', {'profile_home': str(hermes_home), 'enabled_toolsets': None})
    assert not any(row['name'] == 'catalog_plugin' for row in other['toolsets'])


@requires_agent
def test_talaria_toolset_is_registered_listed_and_off_by_default(handshaken, hermes_home) -> None:
    """TAL-1164: the sidecar's own ``talaria`` toolset is in the catalog, never a profile default, and the picker turns it on."""
    defaults = handshaken.result('toolsets.catalog', {'profile_home': str(hermes_home), 'enabled_toolsets': None})
    row = next((r for r in defaults['toolsets'] if r['name'] == 'talaria'), None)
    assert row is not None, 'the talaria toolset is missing from the catalog'
    assert row['available'] is True and row['selected'] is False, row
    assert row['description'] == "List, start and message this profile's Talaria chats, wait on or stop their turns, and manage their queued messages."
    assert 'talaria' not in defaults['selected_toolsets']
    picked = handshaken.result('toolsets.catalog', {'profile_home': str(hermes_home), 'enabled_toolsets': ['file', 'talaria']})
    assert next(r for r in picked['toolsets'] if r['name'] == 'talaria')['selected'] is True
