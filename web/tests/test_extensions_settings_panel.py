"""Regression tests for the Settings → Extensions diagnostics and toggles."""
from pathlib import Path
import re
import shutil
import subprocess

import pytest


ROOT = Path(__file__).parent.parent
DOCS_EXTENSIONS = (ROOT / "docs" / "EXTENSIONS.md").read_text(encoding="utf-8")
ROUTES_PY = (ROOT / "api" / "routes.py").read_text(encoding="utf-8")


def _locale_string(block: str, key: str) -> str:
    match = re.search(rf"\b{re.escape(key)}:\s*([\"'])(.*?)\1", block, re.DOTALL)
    assert match, f"{key} not found in locale block"
    return match.group(2)


def _contains_post_method(block: str) -> bool:
    """Return True when a JS block contains a method: 'POST' style mutation."""
    return bool(re.search(r"\bmethod\s*:\s*([\"'`])POST\1", block))


def _run_node(script: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is required for extension settings panel runtime tests")
    result = subprocess.run(
        [node, "-e", script],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr + result.stdout


def test_extensions_do_not_add_generic_backend_settings_write_route():
    assert "/api/extensions/settings" not in ROUTES_PY
    assert "/api/extensions/storage" not in ROUTES_PY
    assert "set_extension_settings" not in ROUTES_PY
    assert "write_extension_settings" not in ROUTES_PY
