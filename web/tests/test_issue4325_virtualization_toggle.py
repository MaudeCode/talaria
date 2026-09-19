"""Regression coverage for transcript virtualization preference (#4325 + #4343).

The stream-end freeze/jump fix (#4328, semantic viewport anchoring) is covered by
test_issue500_message_list_virtualization.py. This file covers the Preferences
toggle and its #4343 contract change:

- #4325 added an opt-OUT toggle (default ON).
- #4343 flipped it to EXPERIMENTAL / opt-IN (default OFF) because virtualization
  caused a scroll-up flicker on long sessions, with a force-off-for-everyone
  migration: a stored virtualize_transcript=True from the #4325 window is reset
  to off unless an explicit post-flip opt-in marker (virtualize_transcript_optin)
  is present.
"""
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX = REPO_ROOT / "static" / "index.html"
PANELS = REPO_ROOT / "static" / "panels.js"
BOOT = REPO_ROOT / "static" / "boot.js"
UI = REPO_ROOT / "static" / "ui.js"
I18N = REPO_ROOT / "static" / "i18n.js"
CONFIG = REPO_ROOT / "api" / "config.py"


def test_virtualize_transcript_setting_is_default_off_and_allowed():
    """#4343 opt-IN model: default False (virtualization off), bool-allowlisted,
    plus the opt-in migration marker."""
    src = CONFIG.read_text(encoding="utf-8")
    assert '"virtualize_transcript": False' in src, "must default OFF (experimental/opt-in)"
    assert '"virtualize_transcript",' in src, "must be in _SETTINGS_BOOL_KEYS"
    assert '"virtualize_transcript_optin": False' in src, "opt-in migration marker must exist + default False"
    assert '"virtualize_transcript_optin",' in src, "opt-in marker must be in _SETTINGS_BOOL_KEYS"


# ── #4343 force-off-for-everyone migration (load_settings behavior) ──────────


@pytest.fixture
def _settings_env(tmp_path, monkeypatch):
    """Point load_settings at an isolated settings.json under tmp."""
    import api.config as config

    sf = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", sf)
    return config, sf


def _write(sf, payload):
    sf.write_text(json.dumps(payload), encoding="utf-8")


def test_migration_unset_defaults_off(_settings_env):
    """No stored value (fresh / pre-#4325 install) → off."""
    config, sf = _settings_env
    _write(sf, {"onboarding_completed": True})
    assert config.load_settings()["virtualize_transcript"] is False


def test_migration_stale_pre_flip_true_is_reset_off(_settings_env):
    """A stored virtualize_transcript=True from the #4325 window WITHOUT the
    opt-in marker is stale → force-reset to off for everyone."""
    config, sf = _settings_env
    _write(sf, {"onboarding_completed": True, "virtualize_transcript": True})
    assert config.load_settings()["virtualize_transcript"] is False


def test_migration_explicit_post_flip_optin_is_honored(_settings_env):
    """An explicit post-flip opt-in (marker present) keeps virtualization on."""
    config, sf = _settings_env
    _write(sf, {
        "onboarding_completed": True,
        "virtualize_transcript": True,
        "virtualize_transcript_optin": True,
    })
    assert config.load_settings()["virtualize_transcript"] is True


def test_migration_optin_marker_without_true_stays_off(_settings_env):
    """Marker present but value false (user opted in then back out) → off."""
    config, sf = _settings_env
    _write(sf, {
        "onboarding_completed": True,
        "virtualize_transcript": False,
        "virtualize_transcript_optin": True,
    })
    assert config.load_settings()["virtualize_transcript"] is False
