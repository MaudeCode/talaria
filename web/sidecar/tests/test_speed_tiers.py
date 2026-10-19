"""Speed eligibility is the Agent resolver's decision, including older signatures."""
import sys
from types import ModuleType

import pytest
from talaria_sidecar.speed import fast_overrides, supported_speed_tiers


def install_models(monkeypatch, resolver=None):
    package = ModuleType('hermes_cli')
    models = ModuleType('hermes_cli.models')
    if resolver is not None:
        models.resolve_fast_mode_overrides = resolver
    package.models = models
    monkeypatch.setitem(sys.modules, 'hermes_cli', package)
    monkeypatch.setitem(sys.modules, 'hermes_cli.models', models)


def test_older_resolver_gets_route_and_never_downgrades_ultrafast(monkeypatch):
    calls = []
    def resolver(model, *, provider, base_url):
        calls.append((model, provider, base_url))
        return {'speed': 'fast'}
    install_models(monkeypatch, resolver)
    assert supported_speed_tiers('claude-opus-4-8', 'anthropic', 'https://api.anthropic.com') == [
        {'id': 'standard', 'service_tier': 'default'}, {'id': 'fast', 'service_tier': 'priority'},
    ]
    assert calls == [('claude-opus-4-8', 'anthropic', 'https://api.anthropic.com')]
    assert fast_overrides('claude-opus-4-8', 'anthropic', '', 'ultrafast') is None


def test_no_resolver_uses_legacy_gate_only_on_first_party_routes(monkeypatch):
    install_models(monkeypatch)
    assert fast_overrides('gpt-5.4', 'openai-api', '', 'priority') == {'service_tier': 'priority'}
    assert fast_overrides('o3', 'openai', 'https://api.openai.com/v1', 'priority') == {'service_tier': 'priority'}
    for model, provider, base, tier in [
        ('gpt-6-astra', 'openai-codex', '', 'priority'), ('gpt-5.4', 'openrouter', '', 'priority'),
        ('gpt-5.4', 'openai', 'https://proxy.example/v1', 'priority'), ('gpt-5.4', 'openai', '', 'ultrafast'),
    ]:
        assert fast_overrides(model, provider, base, tier) is None


def test_resolver_errors_are_not_mistaken_for_missing_capability(monkeypatch):
    def resolver(model, *, provider, base_url, tier):
        raise TypeError('broken resolver')
    install_models(monkeypatch, resolver)
    with pytest.raises(TypeError, match='broken resolver'):
        supported_speed_tiers('gpt-5.4', 'openai', '')


def install_codex_tiers(monkeypatch, offered=None):
    package = ModuleType('agent')
    tiers = ModuleType('agent.codex_service_tiers')
    if offered is not None:
        tiers.ultrafast_offered = offered
    package.codex_service_tiers = tiers
    monkeypatch.setitem(sys.modules, 'agent', package)
    monkeypatch.setitem(sys.modules, 'agent.codex_service_tiers', tiers)


@pytest.mark.parametrize('offered, expected', [
    (False, [{'id': 'standard', 'service_tier': 'default'}, {'id': 'priority', 'service_tier': 'priority'}]),
    (True, [{'id': 'standard', 'service_tier': 'default'}, {'id': 'priority', 'service_tier': 'priority'},
            {'id': 'ultrafast', 'service_tier': 'ultrafast'}]),
    (None, [{'id': 'standard', 'service_tier': 'default'}, {'id': 'priority', 'service_tier': 'priority'},
            {'id': 'ultrafast', 'service_tier': 'ultrafast'}]),
])
def test_codex_account_catalog_decides_ultrafast(monkeypatch, offered, expected):
    install_models(monkeypatch, lambda model, *, provider, base_url, tier: {'service_tier': tier})
    calls = []
    def ultrafast_offered(model, *, provider, base_url):
        calls.append((model, provider, base_url))
        return offered
    install_codex_tiers(monkeypatch, None if offered is None else ultrafast_offered)
    base = 'https://chatgpt.com/backend-api/codex'
    assert supported_speed_tiers('gpt-6-astra', 'openai-codex', base) == expected
    assert calls == ([] if offered is None else [('gpt-6-astra', 'openai-codex', base)])


def test_agent_without_codex_tier_module_keeps_route_gate(monkeypatch):
    install_models(monkeypatch, lambda model, *, provider, base_url, tier: {'service_tier': tier})
    monkeypatch.setitem(sys.modules, 'agent', None)
    assert [tier['id'] for tier in supported_speed_tiers('gpt-6-astra', 'openai-codex', '')] == ['standard', 'priority', 'ultrafast']
