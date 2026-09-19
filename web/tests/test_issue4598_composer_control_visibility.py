"""Static-contract regression tests for the composer footer-control visibility
toggles (#4598).

Mirrors the sibling pattern in test_sidebar_tab_visibility.py: pins that each
toggle is wired end-to-end (config boolean key -> boot.js definition + read-back
-> index.html control -> panels.js chip render -> apply) and that every new i18n
key exists across all locale blocks, so a future refactor can't silently orphan
a control or break locale parity.
"""
import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PY = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
# The 15 composer-control visibility flags this feature ships.
HIDE_KEYS = [
    "hide_composer_attach",
    "hide_composer_saved_prompts",
    "hide_composer_mic",
    "hide_composer_voice_mode",
    "hide_composer_yolo",
    "hide_composer_profile",
    "hide_composer_workspace",
    "hide_composer_mobile_config",
    "hide_composer_model",
    "hide_composer_quota_chip",
    "hide_composer_reasoning",
    "hide_composer_toolsets",
    "hide_composer_status",
    "hide_composer_context",
    "hide_composer_bg_badge",
]

# The new i18n keys the feature adds (section labels/descriptions + per-chip labels).
I18N_KEYS = [
    "settings_label_composer_controls",
    "settings_desc_composer_controls",
    "settings_label_composer_situational_controls",
    "settings_desc_composer_situational_controls",
    "composer_control_attach",
    "composer_control_saved_prompts",
    "composer_control_mic",
    "composer_control_profile",
    "composer_control_workspace",
    "composer_control_model",
    "composer_control_reasoning",
    "composer_control_context",
    "composer_control_voice_mode",
    "composer_control_yolo",
    "composer_control_bg_badge",
    "composer_control_mobile_config",
    "composer_control_quota_chip",
    "composer_control_toolsets",
    "composer_control_status",
]


def _extract_function(source: str, name: str) -> str:
    marker = f"function {name}("
    start = source.index(marker)
    brace = source.index("{", start)
    depth = 0
    for idx in range(brace, len(source)):
        char = source[idx]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start : idx + 1]
    raise AssertionError(f"Could not extract {name}")


def test_all_hide_flags_registered_as_boolean_settings_keys():
    """Every toggle must be in config.py's boolean-keys set so it persists and
    round-trips through save/load."""
    for key in HIDE_KEYS:
        assert f'"{key}"' in CONFIG_PY, f"{key} missing from config.py boolean settings keys"


def test_composer_control_order_is_validated_and_deduped():
    """The backend persists only known composer control order keys."""
    import api.config as config

    original_settings_file = config.SETTINGS_FILE
    test_state_dir = ROOT / ".tmp-test-issue4598"
    try:
        config.SETTINGS_FILE = test_state_dir / "settings.json"
        test_state_dir.mkdir(exist_ok=True)
        saved = config.save_settings(
            {
                "composer_control_order": [
                    "hide_composer_model",
                    "bogus",
                    "hide_composer_attach",
                    "hide_composer_model",
                    42,
                    "hide_composer_context",
                ]
            }
        )
        assert saved["composer_control_order"] == [
            "hide_composer_model",
            "hide_composer_attach",
            "hide_composer_context",
        ]
        persisted = json.loads(config.SETTINGS_FILE.read_text(encoding="utf-8"))
        assert persisted["composer_control_order"] == saved["composer_control_order"]
    finally:
        config.SETTINGS_FILE = original_settings_file
        shutil.rmtree(test_state_dir, ignore_errors=True)
