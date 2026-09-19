import json
import pathlib
import re
import subprocess
import textwrap


REPO = pathlib.Path(__file__).resolve().parents[1]
ROUTES_PY = (REPO / "api" / "routes.py").read_text(encoding="utf-8")


def _extract_function(src: str, name: str) -> str:
    marker = f"function {name}("
    start = src.index(marker)
    brace = src.index("{", start)
    depth = 1
    pos = brace + 1
    while depth and pos < len(src):
        ch = src[pos]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        pos += 1
    assert depth == 0, f"could not extract {name}()"
    return src[start:pos]


def test_file_raw_inline_html_preview_injects_base_target_blank():
    raw_handler = ROUTES_PY[ROUTES_PY.index("def _handle_file_raw") :]

    assert '<base target="_blank">' in ROUTES_PY
    assert "_serve_inline_html_preview" in raw_handler
    assert "html_inline_ok" in raw_handler
