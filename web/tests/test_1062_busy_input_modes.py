from pathlib import Path

from tests.helpers import source_between as _source_between

ROOT = Path(__file__).parent.parent
CONFIG_PY = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
# ── Backend: setting registration + enum validation ─────────────────────

class TestBusyInputModeSetting:
    """The new setting key must be registered with a default and enum validator."""

    def test_default_is_steer(self):
        """Default value resolves to steer for users who don't touch the setting."""
        assert '"default_message_mode": "steer"' in CONFIG_PY, (
            "_DEFAULT_SETTINGS must include default_message_mode='steer' so new users see the steer default"
        )

    def test_enum_validator_present(self):
        """_SETTINGS_ENUM_KEYS must validate default_message_mode against {queue, interrupt, steer}."""
        # Find the entry inside the enum dict (a set literal as the value)
        idx = CONFIG_PY.find('"default_message_mode": {')
        assert idx >= 0, "default_message_mode entry missing from _SETTINGS_ENUM_KEYS"
        block = CONFIG_PY[idx:idx + 200]
        assert '"queue"' in block and '"interrupt"' in block and '"steer"' in block, (
            "default_message_mode enum must contain {queue, interrupt, steer}"
        )


# ── Frontend: slash commands ─────────────────────────────────────────────

# ── Boot init + settings panel wiring ───────────────────────────────────

# ── i18n locale coverage ─────────────────────────────────────────────────
