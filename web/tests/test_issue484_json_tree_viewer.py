"""Tests for issue #484 — collapsible JSON/YAML tree viewer.

The original feature hardcoded the default view: valid JSON/YAML fenced blocks
opened in Tree view at 10+ lines (`const showTree=lineCount>=10;`). That default
is now user-configurable (#484 follow-up) via two settings:

  - structured_code_default_view: "auto" | "on" | "off"
        on   => always default to Tree
        off  => always default to Raw
        auto => Tree only when the block line count >= the configured threshold
  - structured_code_auto_tree_lines: integer 1..1000 (default 10)

`auto` + threshold 10 reproduces the original behavior, so the default is
preserved. These tests pin the new configurable shape while keeping the existing
Tree/Raw renderer invariants (wrapper class, helpers, value types, toggle, YAML
support) intact.
"""
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).parent.parent.resolve()
UI_JS_PATH = REPO_ROOT / "static" / "ui.js"
NODE = shutil.which("node")


class TestStructuredCodeSettingsWiring:
    """The setting must be a real, persisted WebUI setting — not a localStorage hack."""

    def test_server_defaults_and_validation(self):
        with open("api/config.py", "r", encoding="utf-8") as f:
            content = f.read()
        # Defaults preserve current behavior: auto + threshold 10.
        assert '"structured_code_default_view": "auto"' in content
        assert '"structured_code_auto_tree_lines": 10' in content
        # Enum + range validation are registered.
        assert '"structured_code_default_view": {"auto", "on", "off"}' in content
        assert '"structured_code_auto_tree_lines": (1, 1000)' in content
