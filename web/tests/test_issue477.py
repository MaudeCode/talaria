"""Tests for KaTeX font CSP handling.

KaTeX is vendored locally, so the CSP should not need to loosen font-src for a
third-party CDN.
"""
import pathlib

REPO = pathlib.Path(__file__).parent.parent
HELPERS_PY = (REPO / "api" / "helpers.py").read_text(encoding="utf-8")
def _font_src() -> str:
    return HELPERS_PY.split("font-src", 1)[1].split(";", 1)[0]


def test_font_src_keeps_self_and_data_without_cdn_font_exception():
    """font-src should stay tight now that KaTeX fonts are local."""
    font_src = _font_src()
    assert "'self'" in font_src
    assert "data:" in font_src
    assert "https://cdn.jsdelivr.net" not in font_src
