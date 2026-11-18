"""Speed eligibility is the Agent resolver's decision."""
import sys
from types import ModuleType

import pytest
from talaria_sidecar.speed import supported_speed_tiers


def install_models(monkeypatch, resolver):
    package = ModuleType('hermes_cli')
    models = ModuleType('hermes_cli.models')
    models.resolve_fast_mode_overrides = resolver
    package.models = models
    monkeypatch.setitem(sys.modules, 'hermes_cli', package)
    monkeypatch.setitem(sys.modules, 'hermes_cli.models', models)


def test_a_speed_override_is_offered_as_the_fast_tier(monkeypatch):
    calls = []
    def resolver(model, *, provider, base_url, tier):
        calls.append((model, provider, base_url, tier))
        return {'speed': 'fast'} if tier == 'priority' else None
    install_models(monkeypatch, resolver)
    assert supported_speed_tiers('claude-opus-4-8', 'anthropic', 'https://api.anthropic.com') == [
        {'id': 'standard', 'service_tier': 'default'}, {'id': 'fast', 'service_tier': 'priority'},
    ]
    assert calls == [('claude-opus-4-8', 'anthropic', 'https://api.anthropic.com', tier) for tier in ('priority', 'ultrafast')]


def test_resolver_errors_are_not_mistaken_for_missing_capability(monkeypatch):
    def resolver(model, *, provider, base_url, tier):
        raise TypeError('broken resolver')
    install_models(monkeypatch, resolver)
    with pytest.raises(TypeError, match='broken resolver'):
        supported_speed_tiers('gpt-5.4', 'openai', '')


def install_codex_tiers(monkeypatch, offered):
    package = ModuleType('agent')
    tiers = ModuleType('agent.codex_service_tiers')
    tiers.ultrafast_offered = offered
    package.codex_service_tiers = tiers
    monkeypatch.setitem(sys.modules, 'agent', package)
    monkeypatch.setitem(sys.modules, 'agent.codex_service_tiers', tiers)


@pytest.mark.parametrize('offered, expected', [
    (False, [{'id': 'standard', 'service_tier': 'default'}, {'id': 'priority', 'service_tier': 'priority'}]),
    (True, [{'id': 'standard', 'service_tier': 'default'}, {'id': 'priority', 'service_tier': 'priority'},
            {'id': 'ultrafast', 'service_tier': 'ultrafast'}]),
])
def test_codex_account_catalog_decides_ultrafast(monkeypatch, offered, expected):
    install_models(monkeypatch, lambda model, *, provider, base_url, tier: {'service_tier': tier})
    calls = []
    def ultrafast_offered(model, *, provider, base_url):
        calls.append((model, provider, base_url))
        return offered
    install_codex_tiers(monkeypatch, ultrafast_offered)
    base = 'https://chatgpt.com/backend-api/codex'
    assert supported_speed_tiers('gpt-6-astra', 'openai-codex', base) == expected
    assert calls == [('gpt-6-astra', 'openai-codex', base)]
