"""Regression tests for large composer text paste attachment behavior."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import textwrap

import pytest

ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
CONFIG_PY = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
NODE = shutil.which("node")
UTC_2026_07_01_12_41_11_610 = 1782909671610


def _extract_function(source: str, name: str) -> str:
    marker = f"function {name}("
    start = source.index(marker)
    brace_start = source.index("{", start)
    depth = 0
    for idx in range(brace_start, len(source)):
        char = source[idx]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start : idx + 1]
    raise AssertionError(f"could not extract function {name}")


def test_large_text_paste_attachment_setting_is_server_backed_and_default_on():
    assert '"large_text_paste_as_attachment": True' in CONFIG_PY
    bool_keys_start = CONFIG_PY.index("_SETTINGS_BOOL_KEYS")
    assert '"large_text_paste_as_attachment"' in CONFIG_PY[bool_keys_start:]


def test_changelog_mentions_large_text_paste_attachment():
    assert "Large plain-text pastes in the composer now become `.md` attachments" in CHANGELOG
