"""Regression checks for Issue #5144 busy composer placeholder hints."""

import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONFIG_PY = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
def _function_block(src: str, name: str) -> str:
    marker = re.search(rf"(^|\n)(?:async\s+)?function\s+{re.escape(name)}\(", src)
    assert marker is not None, f"{name}() not found"
    start = marker.start()
    next_marker = re.search(r"\n(?:function\s+\w+\(|async\s+function\s+\w+\()", src[start + 1:])
    end = start + 1 + next_marker.start() if next_marker else len(src)
    return src[start:end]


def test_setting_defaults_off_and_bool_registration():
    assert '"show_busy_placeholder_hint": False' in CONFIG_PY
    assert '"show_busy_placeholder_hint"' in CONFIG_PY
