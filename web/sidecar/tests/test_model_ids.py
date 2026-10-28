"""`providers.model_ids` flags the Agent's curated placeholder for an unreachable catalog (TAL-799)."""
import sys
from types import ModuleType

from talaria_sidecar.methods import providers


def install_models(monkeypatch, answer, *, marker=True):
    package = ModuleType('hermes_cli')
    models = ModuleType('hermes_cli.models')

    class CuratedFallbackModels(list):
        pass

    if marker:
        models.CuratedFallbackModels = CuratedFallbackModels
    models.provider_model_ids = lambda provider, *, force_refresh=False: answer(CuratedFallbackModels)
    package.models = models
    monkeypatch.setitem(sys.modules, 'hermes_cli', package)
    monkeypatch.setitem(sys.modules, 'hermes_cli.models', models)
    monkeypatch.setattr(providers, '_unavailable_plugin', lambda provider_id: False)


def test_a_curated_fallback_list_is_flagged(monkeypatch):
    install_models(monkeypatch, lambda curated: curated(['claude-fable-5.1', 'claude-opus-5-5']))
    assert providers.model_ids('anthropic', force_refresh=False) == (['claude-fable-5.1', 'claude-opus-5-5'], True)


def test_a_live_list_is_not(monkeypatch):
    install_models(monkeypatch, lambda curated: ['claude-fable-5.1'])
    assert providers.model_ids('anthropic', force_refresh=False) == (['claude-fable-5.1'], False)


def test_an_agent_without_the_marker_never_flags_a_fallback(monkeypatch):
    install_models(monkeypatch, lambda curated: curated(['claude-opus-4-7']), marker=False)
    assert providers.model_ids('anthropic', force_refresh=False) == (['claude-opus-4-7'], False)


def test_native_plan_metadata_is_bounded_to_the_selected_provider(monkeypatch):
    import json
    from pathlib import Path
    from types import SimpleNamespace
    fixture = json.loads((Path(__file__).parents[3] / 'contracts/fixtures/plan-allowance.json').read_text())
    inventory = ModuleType('hermes_cli.inventory')
    usage = ModuleType('hermes_cli.model_picker_usage')
    inventory.load_picker_context = lambda: SimpleNamespace()
    inventory.build_model_options_payload = lambda context, **kwargs: {'providers': [
        {'slug': 'nous', **fixture, 'unavailable_models': [], 'api_key': 'synthetic-secret'},
        {'slug': 'foreign', 'plan_usage': {'plan': 'wrong account'}},
    ]}
    usage.nous_picker_usage = lambda: object()
    monkeypatch.setitem(sys.modules, 'hermes_cli.inventory', inventory)
    monkeypatch.setitem(sys.modules, 'hermes_cli.model_picker_usage', usage)
    result = providers.model_allowance_snapshot('nous', force_refresh=False)
    assert result['plan_usage'] == fixture['plan_usage']
    assert result['usage_levels'] == fixture['usage_levels']
    assert result['metadata_status'] == 'current'
    assert 'synthetic-secret' not in json.dumps(result)
    assert providers.model_allowance_snapshot('foreign', force_refresh=False) == {}


def test_pending_native_entitlement_is_unknown_not_unavailable(monkeypatch):
    inventory = ModuleType('hermes_cli.inventory')
    usage = ModuleType('hermes_cli.model_picker_usage')
    inventory.load_picker_context = lambda: None
    inventory.build_model_options_payload = lambda context, **kwargs: {'providers': [
        {'slug': 'nous', 'free_tier_pending': True, 'unavailable_models': ['model-a']},
    ]}
    usage.nous_picker_usage = lambda: None
    monkeypatch.setitem(sys.modules, 'hermes_cli.inventory', inventory)
    monkeypatch.setitem(sys.modules, 'hermes_cli.model_picker_usage', usage)
    result = providers.model_allowance_snapshot('nous', force_refresh=False)
    assert result['metadata_status'] == 'pending'
    assert result['unavailable_model_ids'] == []


def test_direct_usage_carries_native_gauge_and_omits_missing_capability(monkeypatch):
    from types import SimpleNamespace
    from talaria_sidecar.methods import chat
    native = ModuleType('gateway.session_usage')
    gauge = {'id': 'day', 'label': 'Today', 'used_bp': 8000, 'resets_at_ms': None}
    native.plan_gauge = lambda agent: gauge
    monkeypatch.setitem(sys.modules, 'gateway.session_usage', native)
    agent = SimpleNamespace(session_prompt_tokens=42)
    assert chat._usage(agent)['plan_gauge'] == gauge
    assert chat._usage(agent)['prompt_tokens'] == 42
    native.plan_gauge = lambda agent: None
    assert 'plan_gauge' not in chat._usage(agent)
    monkeypatch.setitem(sys.modules, 'gateway.session_usage', None)
    assert 'plan_gauge' not in chat._usage(agent)
