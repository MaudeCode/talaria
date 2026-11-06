"""Turn setup shares one Agent config read without retaining its mutable values."""

import copy
import dataclasses
import sys
import types
from unittest.mock import Mock

import pytest

from talaria_sidecar.methods import chat
from talaria_sidecar.methods import config as config_methods
from test_chat_turn import Ctx, FakeAgent, _params


def _stub_turn(monkeypatch, tmp_path, cfg, session_id):
    """One session whose turns read ``cfg`` through a stubbed Agent config; returns that config module and the turn params."""
    config = types.ModuleType('hermes_cli.config')
    config.load_config = Mock(side_effect=lambda: copy.deepcopy(cfg))
    config.load_config_readonly = Mock(side_effect=lambda: cfg)
    config.DEFAULT_CONFIG = {'checkpoints': {'enabled': False, 'max_snapshots': 3, 'max_total_size_mb': 20, 'max_file_size_mb': 2}}
    modules = {
        'hermes_cli': {},
        'hermes_cli.config': vars(config),
        'hermes_cli.tools_config': {'_get_platform_tools': lambda c, platform: c.get('platform_toolsets', {}).get(platform, ['file'])},
        'hermes_cli.fallback_config': {'get_fallback_chain': lambda c: c.get('fallback_providers')},
        'hermes_cli.cli_config_load': {'_resolve_prefill_messages_file': lambda c: None, '_load_prefill_messages': lambda path, home: None},
        'hermes_cli.models': {'normalize_provider': lambda provider: provider},
        'hermes_constants': {'get_hermes_home': lambda: tmp_path},
        'agent.skill_utils': {'parse_config_string_list': lambda value: value or []},
    }
    for name, attrs in modules.items():
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(chat, '_resolve_runtime', lambda *args: {'model': 'm', 'provider': 'p'})
    monkeypatch.setattr(chat, '_discover_mcp_tools', lambda run: None)
    FakeAgent.instances.clear()
    monkeypatch.setattr(chat, '_agent_class', lambda: FakeAgent)
    return config, {**_params(session_id, str(tmp_path)), 'profile_home': str(tmp_path)}


@pytest.mark.parametrize('override', [None, ['file']])
@pytest.mark.parametrize('configured', [False, True])
def test_turn_reads_config_once_and_refreshes_between_turns(monkeypatch, tmp_path, override, configured):
    cfg = {
        'model': {'default': 'm', 'extra_body': {'nested': ['original']}},
        'agent': {'disabled_toolsets': ['todo']},
        'platform_toolsets': {'cli': ['web']},
        'provider_routing': {'only': ['provider-a']},
        'checkpoints': {'enabled': True, 'max_snapshots': 7},
        'fallback_providers': [{'provider': 'backup', 'model': 'fallback'}],
    } if configured else {}
    original = copy.deepcopy(cfg)
    config, params = _stub_turn(monkeypatch, tmp_path, cfg, 'config-first')
    params = {**params, 'enabled_toolsets': override}
    for index in range(2):
        config.load_config.reset_mock()
        config.load_config_readonly.reset_mock()
        assert chat.start(Ctx(), {**params, 'stream_id': f'config-{index}'})['status'] == 'completed'
        reads = config.load_config.call_count + config.load_config_readonly.call_count
        assert reads <= 1, f'turn setup loaded the config {reads} times'
        config.load_config_readonly.assert_called_once_with()
        kwargs = FakeAgent.instances[-1].kwargs
        assert kwargs['disabled_toolsets'] == (['todo' if index == 0 else 'changed'] if configured else [])
        assert kwargs['checkpoints_enabled'] is configured
        assert kwargs['enabled_toolsets'] == (override if override is not None else ['web'] if configured else ['file'])
        if configured:
            assert kwargs['providers_allowed'] == ['provider-a']
            assert kwargs['checkpoint_max_snapshots'] == 7 + index
            assert kwargs['fallback_model'][0]['model'] == 'fallback'
            assert kwargs['request_overrides']['extra_body']['nested'] == ['original']
        if configured and index == 1:
            kwargs['providers_allowed'].append('agent-edit')
            kwargs['fallback_model'][0]['model'] = 'agent-edit'
            kwargs['request_overrides']['extra_body']['nested'].append('agent-edit')
            assert cfg == original, 'Agent kwargs mutated the shared read-only config'
        if index == 0:
            cfg['agent'] = {'disabled_toolsets': ['changed'] if configured else []}
            cfg['checkpoints'] = {'enabled': configured, 'max_snapshots': 8 if configured else 3}
            original = copy.deepcopy(cfg)


def test_a_prepare_ahead_change_rebuilds_the_resident_agent(monkeypatch, tmp_path):
    """TAL-1825: the Agent reads ``compression.prepare_ahead`` once, at construction."""
    cfg = {'compression': {'prepare_ahead': False}}
    _config, params = _stub_turn(monkeypatch, tmp_path, cfg, 'prepare-ahead')
    built = []
    for index, value in enumerate((False, False, True)):
        cfg['compression'] = {'prepare_ahead': value}
        assert chat.start(Ctx(), {**params, 'stream_id': f'prepare-ahead-{index}'})['status'] == 'completed'
        built.append(len(FakeAgent.instances))
    assert built == [1, 1, 2]


@pytest.mark.parametrize(('key', 'declared'), [('compression.prepare_ahead', True), ('compression.absent', False), ('compression.threshold.deeper', False), ('absent.prepare_ahead', False)])
def test_declares_key_walks_the_agent_defaults(monkeypatch, key, declared):
    module = types.ModuleType('hermes_cli.config')
    module.DEFAULT_CONFIG = {'compression': {'threshold': 0.5, 'prepare_ahead': False}}
    monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
    monkeypatch.setitem(sys.modules, 'hermes_cli.config', module)
    assert config_methods.declares_key(key) is declared


def _discussion_limits_module(monkeypatch, *fields):
    """TAL-1828: an Agent's ``gateway.hosted_room_discussion``; no fields means the module predates the limits."""
    module = types.ModuleType('gateway.hosted_room_discussion')
    if fields:
        module.DiscussionLimits = dataclasses.make_dataclass('DiscussionLimits', fields)
    monkeypatch.setitem(sys.modules, 'gateway', types.ModuleType('gateway'))
    monkeypatch.setitem(sys.modules, 'gateway.hosted_room_discussion', module)
    config_module = types.ModuleType('hermes_cli.config')
    config_module.DEFAULT_CONFIG = {}
    monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
    monkeypatch.setitem(sys.modules, 'hermes_cli.config', config_module)


@pytest.mark.parametrize(('key', 'declared'), [('hosted_rooms.discussion.max_rounds', True), ('hosted_rooms.discussion.max_messages', True), ('hosted_rooms.discussion.absent', False), ('hosted_rooms.discussion', False), ('other.max_rounds', False)])
def test_declares_key_answers_for_the_discussion_limits_the_agent_reads_without_a_default(monkeypatch, key, declared):
    _discussion_limits_module(monkeypatch, 'max_rounds', 'max_messages')
    assert config_methods.declares_key(key) is declared


def test_declares_key_denies_the_discussion_limits_on_an_agent_without_them(monkeypatch):
    _discussion_limits_module(monkeypatch)
    assert config_methods.declares_key('hosted_rooms.discussion.max_rounds') is False
