"""
Tests for #1228 — model picker loses provider identity when multiple
providers expose the same model ID.

Covers:
- _deduplicate_model_ids() post-process in api/config.py
- Frontend norm() regex in ui.js that strips @provider: prefixes
"""
import copy
import unittest


class TestDeduplicateModelIds(unittest.TestCase):
    """Backend: _deduplicate_model_ids() in api/config.py"""

    def _call(self, groups):
        from api.config import _deduplicate_model_ids
        groups = copy.deepcopy(groups)
        _deduplicate_model_ids(groups)
        return groups

    # ── No collision ────────────────────────────────────────────────

    def test_unique_ids_unchanged(self):
        """When all model IDs are unique across groups, nothing changes."""
        groups = [
            {"provider": "Anthropic", "provider_id": "anthropic", "models": [
                {"id": "claude-sonnet-4.6", "label": "Claude Sonnet 4.6"},
            ]},
            {"provider": "OpenAI", "provider_id": "openai-codex", "models": [
                {"id": "gpt-5.4", "label": "GPT-5.4"},
            ]},
        ]
        result = self._call(groups)
        assert result[0]["models"][0]["id"] == "claude-sonnet-4.6"
        assert result[1]["models"][0]["id"] == "gpt-5.4"

    def test_single_group_unchanged(self):
        """A single group never triggers deduplication."""
        groups = [
            {"provider": "Anthropic", "provider_id": "anthropic", "models": [
                {"id": "claude-sonnet-4.6", "label": "Claude Sonnet 4.6"},
                {"id": "claude-opus-4.6", "label": "Claude Opus 4.6"},
            ]},
        ]
        result = self._call(groups)
        ids = [m["id"] for m in result[0]["models"]]
        assert "claude-sonnet-4.6" in ids
        assert "claude-opus-4.6" in ids

    def test_empty_groups(self):
        """Empty groups list is a no-op."""
        result = self._call([])
        assert result == []

    # ── Collision: two providers, same bare model ID ────────────────

    def test_two_providers_same_model_prefixes_second(self):
        """When two providers share the same bare model ID, the second
        gets @provider_id: prefix and a disambiguated label."""
        groups = [
            {"provider": "Edith", "provider_id": "custom:edith", "models": [
                {"id": "gpt-5.4", "label": "GPT-5.4"},
            ]},
            {"provider": "OpenAI Codex", "provider_id": "openai-codex", "models": [
                {"id": "gpt-5.4", "label": "GPT-5.4"},
            ]},
        ]
        result = self._call(groups)
        # First stays bare for backward compat
        assert result[0]["models"][0]["id"] == "gpt-5.4"
        assert result[0]["models"][0]["label"] == "GPT-5.4"
        # Second gets prefixed
        assert result[1]["models"][0]["id"] == "@openai-codex:gpt-5.4"
        assert "OpenAI Codex" in result[1]["models"][0]["label"]

    def test_three_providers_same_model(self):
        """With three providers sharing the same model, first stays bare,
        the other two get prefixed."""
        groups = [
            {"provider": "A", "provider_id": "alpha", "models": [
                {"id": "gpt-5.4", "label": "GPT-5.4"},
            ]},
            {"provider": "B", "provider_id": "beta", "models": [
                {"id": "gpt-5.4", "label": "GPT-5.4"},
            ]},
            {"provider": "C", "provider_id": "gamma", "models": [
                {"id": "gpt-5.4", "label": "GPT-5.4"},
            ]},
        ]
        result = self._call(groups)
        assert result[0]["models"][0]["id"] == "gpt-5.4"
        assert result[1]["models"][0]["id"] == "@beta:gpt-5.4"
        assert result[2]["models"][0]["id"] == "@gamma:gpt-5.4"

    # ── Already-prefixed IDs / slash IDs ───────────────────────────

    def test_already_prefixed_ids_and_unique_slash_ids_unchanged(self):
        """Already-qualified IDs stay untouched; unique slash IDs are still allowed."""
        groups = [
            {"provider": "Anthropic", "provider_id": "anthropic", "models": [
                {"id": "@anthropic:claude-sonnet-4.6", "label": "Claude Sonnet 4.6"},
            ]},
            {"provider": "OpenRouter", "provider_id": "openrouter", "models": [
                {"id": "anthropic/claude-sonnet-4.6", "label": "Claude Sonnet 4.6 (OR)"},
            ]},
        ]
        result = self._call(groups)
        assert result[0]["models"][0]["id"] == "@anthropic:claude-sonnet-4.6"
        assert result[1]["models"][0]["id"] == "anthropic/claude-sonnet-4.6"

    def test_two_providers_same_slash_qualified_model_prefixes_second(self):
        """Slash-qualified duplicates must also be made unique (#1313)."""
        groups = [
            {"provider": "Alpha", "provider_id": "custom:alpha", "models": [
                {"id": "google/gemma-4-27b", "label": "Gemma 4 27B"},
            ]},
            {"provider": "Beta", "provider_id": "custom:beta", "models": [
                {"id": "google/gemma-4-27b", "label": "Gemma 4 27B"},
            ]},
        ]
        result = self._call(groups)
        assert result[0]["models"][0]["id"] == "google/gemma-4-27b"
        assert result[1]["models"][0]["id"] == "@custom:beta:google/gemma-4-27b"
        assert result[1]["models"][0]["label"] == "Gemma 4 27B (Beta)"

    # ── Mixed: some unique, some colliding ─────────────────────────

    def test_mixed_unique_and_colliding(self):
        """Only colliding IDs get prefixed; unique ones stay bare."""
        groups = [
            {"provider": "Edith", "provider_id": "custom:edith", "models": [
                {"id": "gpt-5.4", "label": "GPT-5.4"},
                {"id": "claude-sonnet-4.6", "label": "Claude Sonnet 4.6"},
            ]},
            {"provider": "OpenAI Codex", "provider_id": "openai-codex", "models": [
                {"id": "gpt-5.4", "label": "GPT-5.4"},
                {"id": "o3-pro", "label": "O3 Pro"},
            ]},
        ]
        result = self._call(groups)
        # gpt-5.4 collides → second gets prefixed
        assert result[0]["models"][0]["id"] == "gpt-5.4"
        assert result[1]["models"][0]["id"] == "@openai-codex:gpt-5.4"
        # claude-sonnet-4.6 is unique → stays bare
        assert result[0]["models"][1]["id"] == "claude-sonnet-4.6"
        # o3-pro is unique → stays bare
        assert result[1]["models"][1]["id"] == "o3-pro"

    # ── Label disambiguation ────────────────────────────────────────

    def test_label_differs_from_id_when_custom_label(self):
        """When the original label differs from the bare ID, the
        disambiguated label preserves the custom label + adds provider."""
        groups = [
            {"provider": "Edith", "provider_id": "custom:edith", "models": [
                {"id": "gpt-5.4", "label": "GPT 5.4 Turbo"},
            ]},
            {"provider": "Codex", "provider_id": "openai-codex", "models": [
                {"id": "gpt-5.4", "label": "GPT 5.4 Standard"},
            ]},
        ]
        result = self._call(groups)
        assert result[0]["models"][0]["label"] == "GPT 5.4 Turbo"
        assert result[1]["models"][0]["label"] == "GPT 5.4 Standard (Codex)"

    def test_label_same_as_id_adds_provider_parenthetical(self):
        """When label == bare_id, the disambiguated label becomes
        'model_id (Provider Name)'."""
        groups = [
            {"provider": "Edith", "provider_id": "custom:edith", "models": [
                {"id": "gpt-5.4", "label": "gpt-5.4"},
            ]},
            {"provider": "OpenAI Codex", "provider_id": "openai-codex", "models": [
                {"id": "gpt-5.4", "label": "gpt-5.4"},
            ]},
        ]
        result = self._call(groups)
        assert result[0]["models"][0]["label"] == "gpt-5.4"
        assert result[1]["models"][0]["label"] == "gpt-5.4 (OpenAI Codex)"


class TestResolveModelProviderColonInProviderId(unittest.TestCase):
    """resolve_model_provider() must handle provider_ids containing ':'.

    Custom named providers use IDs like 'custom:my-key'. When dedup
    prefixes produce '@custom:my-key:model', rsplit(':', 1) must split
    correctly into provider='custom:my-key' and model='model'.
    """

    def test_custom_provider_id_with_colon(self):
        """@custom:edith:gpt-5.4 → ('gpt-5.4', 'custom:edith', None)."""
        from api.config import resolve_model_provider
        model, provider, base_url = resolve_model_provider("@custom:edith:gpt-5.4")
        assert model == "gpt-5.4", f"Expected bare model 'gpt-5.4', got '{model}'"
        assert provider == "custom:edith", f"Expected provider 'custom:edith', got '{provider}'"
        assert base_url is None

    def test_simple_provider_id_unchanged(self):
        """@openai-codex:gpt-5.4 → ('gpt-5.4', 'openai-codex', None).

        Backward compat: simple provider_ids (no colon) still work.
        """
        from api.config import resolve_model_provider
        model, provider, base_url = resolve_model_provider("@openai-codex:gpt-5.4")
        assert model == "gpt-5.4"
        assert provider == "openai-codex"
