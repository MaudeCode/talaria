"""Focused regression coverage for #5145 busy-input defaults."""

import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONFIG_PY = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
LOCALE_KEYS = (
    "en",
    "it",
    "ja",
    "ru",
    "es",
    "de",
    "zh",
    "'zh-Hant'",
    "pt",
    "ko",
    "fr",
    "tr",
    "pl",
    "vi",
)


def test_backend_default_resolves_to_steer():
    assert '"default_message_mode": "steer"' in CONFIG_PY
