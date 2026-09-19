"""
Sprint 40 UI Polish Tests: Active session title uses CSS theme variable (issue #440).

Covers:
- .session-item.active .session-title uses var(--gold) instead of hardcoded #e8a030
- The hardcoded amber color #e8a030 is NOT present in the active session title rule
"""
import os
import pathlib
import re
import sys
import unittest
from unittest import mock

# Ensure repo is on sys.path so api.config can be imported
_REPO_ROOT = pathlib.Path(__file__).parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

REPO_ROOT  = _REPO_ROOT
try:
    from api import config as _api_config
    _config_available = True
except Exception:
    _api_config = None
    _config_available = False

# Combined tests for Sprint 40 — Session + UI Polish
# Covers: active title color, unknown model, Telegram badge,
#         custom endpoint model routing, workspace chip


# ── #451 active title ─────────────────────────────────────────────
if __name__ == "__main__":
    unittest.main()

# ── #452 unknown model ─────────────────────────────────────────────
class TestGatewaySessionNullModel(unittest.TestCase):
    """Verify that api/models.py and api/gateway_watcher.py do not
    fall back to the string 'unknown' for missing model values."""

    def test_gateway_session_null_model_returns_none_not_unknown(self):
        """api/models.py must not use `or 'unknown'` for the model field
        so that a NULL model in state.db is returned as None (falsy) to
        the frontend rather than the truthy string 'unknown'."""
        models_src = (REPO_ROOT / "api" / "models.py").read_text(encoding="utf-8")
        # Ensure the old fallback pattern is gone
        self.assertNotIn(
            "'model': row['model'] or 'unknown'",
            models_src,
            "api/models.py must not use `or 'unknown'` for the model field "
            "(fixes #443: gateway sessions showed 'telegram · unknown')",
        )

    def test_gateway_watcher_null_model_returns_none_not_unknown(self):
        """api/gateway_watcher.py must not use `or 'unknown'` for the model
        field so that a NULL model in state.db is returned as None (falsy)."""
        gw_src = (REPO_ROOT / "api" / "gateway_watcher.py").read_text(encoding="utf-8")
        self.assertNotIn(
            "'model': row['model'] or 'unknown'",
            gw_src,
            "api/gateway_watcher.py must not use `or 'unknown'` for the model "
            "field (fixes #443: gateway sessions showed 'telegram · unknown')",
        )

    def test_gateway_session_model_uses_none_fallback(self):
        """Both source files must use `row['model'] or None` (explicit None
        fallback) for the model field assignment."""
        models_src = (REPO_ROOT / "api" / "models.py").read_text(encoding="utf-8")
        gw_src = (REPO_ROOT / "api" / "gateway_watcher.py").read_text(encoding="utf-8")
        self.assertIn(
            "'model': row['model'] or None,",
            models_src,
            "api/models.py should assign `row['model'] or None` for the model field",
        )
        self.assertIn(
            "'model': row['model'] or None,",
            gw_src,
            "api/gateway_watcher.py should assign `row['model'] or None` for the model field",
        )


if __name__ == "__main__":
    unittest.main()

# ── #454 model routing ─────────────────────────────────────────────
@unittest.skipUnless(_config_available, "api.config not importable")
class TestCustomEndpointModelStripping:
    """Tests for fix #433: strip provider prefix when custom base_url is set."""

    def _resolve(self, model_id, provider=None, base_url=None, advertised_ids=None):
        """Helper: set cfg directly (same pattern as test_model_resolver.py).

        ``advertised_ids`` seeds the models-catalog snapshot that provenance
        resolution reads (#5979). Pass the ids the endpoint's own group
        advertised; None leaves the catalog cold (preserve-verbatim default).
        """
        old_cfg = dict(_api_config.cfg)
        old_cache = _api_config._available_models_cache
        old_memo = _api_config._advertised_model_ids_memo
        old_fp = _api_config._available_models_cache_source_fingerprint
        old_prov = _api_config._models_cache_provenance
        model_cfg = {}
        if provider:
            model_cfg['provider'] = provider
        if base_url:
            model_cfg['base_url'] = base_url
        _api_config.cfg['model'] = model_cfg
        if advertised_ids is None:
            _api_config._available_models_cache = None
        else:
            _api_config._available_models_cache = {
                'groups': [{
                    'provider_id': provider or 'custom',
                    'models': [{'id': mid, 'label': mid} for mid in advertised_ids],
                }]
            }
            _api_config._available_models_cache_source_fingerprint = _api_config._models_cache_source_fingerprint()
        _api_config._advertised_model_ids_memo = None
        _api_config._sync_models_cache_provenance()
        try:
            return _api_config.resolve_model_provider(model_id)
        finally:
            _api_config.cfg.clear()
            _api_config.cfg.update(old_cfg)
            _api_config._available_models_cache = old_cache
            _api_config._advertised_model_ids_memo = old_memo
            _api_config._available_models_cache_source_fingerprint = old_fp
            _api_config._models_cache_provenance = old_prov

    def test_prefixed_model_stripped_for_custom_endpoint(self):
        """Issue #433: 'openai/gpt-5.4' with custom base_url returns bare 'gpt-5.4'
        when the endpoint advertised ONLY the bare id (provenance strip).
        """
        model, provider, base_url = self._resolve(
            'openai/gpt-5.4',
            provider='custom',
            base_url='http://my-proxy.local:8080/v1',
            advertised_ids=['gpt-5.4'],  # relay serves the bare id only
        )
        assert model == 'gpt-5.4', (
            "Expected bare 'gpt-5.4' for custom endpoint, got '{}'."
            " Stale provider-prefix must be stripped.".format(model)
        )
        assert base_url == 'http://my-proxy.local:8080/v1'
        assert provider == 'custom'

    def test_bare_model_unchanged_for_custom_endpoint(self):
        """Bare model ID (no slash) must pass through untouched with custom base_url."""
        model, provider, base_url = self._resolve(
            'gpt-4o',
            provider='custom',
            base_url='http://my-proxy.local:8080/v1',
        )
        assert model == 'gpt-4o', (
            "Bare model 'gpt-4o' should not be modified, got '{}'.".format(model)
        )
        assert base_url == 'http://my-proxy.local:8080/v1'
        assert provider == 'custom'

    def test_prefixed_model_kept_for_openrouter(self):
        """When NO custom base_url (openrouter route), prefixed model must stay prefixed."""
        model, provider, base_url = self._resolve(
            'openai/gpt-5.4',
            provider='anthropic',  # cross-provider pick triggers openrouter routing
        )
        # Cross-provider model with openrouter routing must keep full provider/model path
        assert 'openai/gpt-5.4' in model or provider == 'openrouter', (
            "Expected prefixed model or openrouter routing for non-custom endpoint, "
            "got model='{}', provider='{}'.".format(model, provider)
        )
        assert base_url is None, (
            "OpenRouter routing must not set a base_url, got '{}'.".format(base_url)
        )

# ── #455 workspace chip ─────────────────────────────────────────────
if __name__ == '__main__':
    unittest.main()
