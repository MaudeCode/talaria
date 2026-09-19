import re
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).parent.parent.resolve()


# ---------------------------------------------------------------------------
# Helper: build a fake hermes_cli.auth module so tests work without the dep
# ---------------------------------------------------------------------------

def _make_fake_auth(logged_in: bool, error: str | None = None, key_source: str = "oauth"):
    mod = types.ModuleType("hermes_cli.auth")
    def get_auth_status(pid):
        if logged_in:
            return {"logged_in": True, "key_source": key_source}
        result = {"logged_in": False}
        if error:
            result["error"] = error
        return result
    mod.get_auth_status = get_auth_status
    return mod


# ---------------------------------------------------------------------------
# Tests for api/providers.py OAuth block
# ---------------------------------------------------------------------------

class TestGetProvidersOauthBlock:
    """Unit tests for the OAuth override block in get_providers()."""

    def _call_get_providers_for_codex(self, fake_auth_module, has_key_in_config: bool):
        """
        Patch just the OAuth resolution path for openai-codex and return the
        provider dict for that one provider.
        """
        import api.providers as prov_mod

        # Patch _provider_has_key to return our desired value
        with patch.object(prov_mod, "_provider_has_key", return_value=has_key_in_config), \
             patch.object(prov_mod, "_provider_is_oauth", side_effect=lambda pid: pid in ("openai-codex", "nous", "copilot")), \
             patch.dict(sys.modules, {"hermes_cli.auth": fake_auth_module}), \
             patch.object(prov_mod, "get_config", return_value={}):
            result = prov_mod.get_providers()

        providers = {p["id"]: p for p in result["providers"]}
        return providers.get("openai-codex")

    def test_config_yaml_token_shows_configured_when_auth_logged_in(self):
        """When hermes auth says logged_in=True, has_key=True regardless of _provider_has_key."""
        auth = _make_fake_auth(logged_in=True)
        p = self._call_get_providers_for_codex(auth, has_key_in_config=False)
        assert p is not None
        assert p["has_key"] is True
        assert p["key_source"] == "oauth"

    def test_config_yaml_token_shows_configured_when_auth_not_logged_in(self):
        """
        REGRESSION TEST (#1202 Bug 1):
        When _provider_has_key() returns True (token in config.yaml) but
        get_auth_status() returns logged_in=False, has_key must remain True.
        
        Before the fix: has_key was overwritten to False, hiding the working token.
        """
        auth = _make_fake_auth(logged_in=False)
        p = self._call_get_providers_for_codex(auth, has_key_in_config=True)
        assert p is not None
        assert p["has_key"] is True, (
            "REGRESSION: config.yaml token was discarded because get_auth_status() "
            "returned logged_in=False. Bug #1202 has regressed."
        )
        assert p["key_source"] == "config_yaml", (
            f"Expected key_source='config_yaml', got {p['key_source']!r}"
        )

    def test_not_configured_when_no_key_and_not_logged_in(self):
        """When neither config.yaml token nor hermes auth, provider is not configured."""
        auth = _make_fake_auth(logged_in=False)
        p = self._call_get_providers_for_codex(auth, has_key_in_config=False)
        assert p is not None
        assert p["has_key"] is False

    def test_auth_error_preserved_when_not_logged_in_and_no_config_key(self):
        """auth_error from get_auth_status() is returned in the provider dict."""
        err_msg = "Refresh token consumed by Codex CLI. Run hermes auth."
        auth = _make_fake_auth(logged_in=False, error=err_msg)
        p = self._call_get_providers_for_codex(auth, has_key_in_config=False)
        assert p is not None
        assert p["has_key"] is False
        assert p["auth_error"] == err_msg

    def test_auth_error_preserved_when_not_logged_in_but_config_key_present(self):
        """auth_error is still returned even when config.yaml token is present."""
        err_msg = "Refresh token was already consumed."
        auth = _make_fake_auth(logged_in=False, error=err_msg)
        p = self._call_get_providers_for_codex(auth, has_key_in_config=True)
        assert p is not None
        assert p["has_key"] is True
        assert p["auth_error"] == err_msg

    def test_hermes_cli_import_error_does_not_discard_config_yaml_key(self):
        """
        REGRESSION TEST (#1202 Bug 1 - exception path):
        If hermes_cli.auth cannot be imported, has_key from _provider_has_key()
        must be preserved. Before the fix, the except clause forced has_key=False.
        """
        import api.providers as prov_mod

        # Use a module that raises ImportError
        bad_mod = types.ModuleType("hermes_cli.auth")
        def bad_get_auth_status(pid):
            raise ImportError("hermes_cli not installed")
        bad_mod.get_auth_status = bad_get_auth_status

        with patch.object(prov_mod, "_provider_has_key", return_value=True), \
             patch.object(prov_mod, "_provider_is_oauth", side_effect=lambda pid: pid in ("openai-codex", "nous", "copilot")), \
             patch.dict(sys.modules, {"hermes_cli.auth": bad_mod}), \
             patch.object(prov_mod, "get_config", return_value={}):
            result = prov_mod.get_providers()

        providers = {p["id"]: p for p in result["providers"]}
        p = providers.get("openai-codex")
        assert p is not None
        assert p["has_key"] is True, (
            "REGRESSION: hermes_cli import failure discarded config.yaml token. "
            "Exception handler must not override a known-good has_key=True."
        )

    def test_auth_error_field_present_on_all_oauth_providers(self):
        """Every provider dict must include auth_error (may be None)."""
        import api.providers as prov_mod
        auth = _make_fake_auth(logged_in=False)
        with patch.object(prov_mod, "_provider_has_key", return_value=False), \
             patch.dict(sys.modules, {"hermes_cli.auth": auth}), \
             patch.object(prov_mod, "get_config", return_value={}):
            result = prov_mod.get_providers()

        for p in result["providers"]:
            assert "auth_error" in p, (
                f"Provider {p['id']!r} is missing the 'auth_error' field"
            )


# ---------------------------------------------------------------------------
# Tests for static/panels.js isOauth detection
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Tests for i18n.js new keys
# ---------------------------------------------------------------------------
