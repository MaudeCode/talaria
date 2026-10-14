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
