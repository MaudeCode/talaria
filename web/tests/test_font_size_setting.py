"""Tests for font size setting (#833) — Small/Default/Large/Extra Large in Appearance."""
import os
import re

_SRC = os.path.join(os.path.dirname(__file__), "..")

def _read(name):
    return open(os.path.join(_SRC, name), encoding="utf-8").read()


class TestFontSizeSettingsValidation:
    """The backend settings contract must accept the persisted xlarge value."""

    def test_config_allows_extra_large_font_size(self):
        config = _read("api/config.py")
        assert '"font_size": {"small", "default", "large", "xlarge"}' in config, (
            "api/config.py must accept xlarge as a persisted font_size value"
        )
