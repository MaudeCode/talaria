"""Regression coverage for issue #1800 file-picker and HTML-open interactions."""

from __future__ import annotations

import re
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
ROUTES_PY = (REPO / "api" / "routes.py").read_text(encoding="utf-8")


def _slice_after(source: str, needle: str, chars: int = 900) -> str:
    idx = source.find(needle)
    assert idx >= 0, f"{needle!r} not found"
    return source[idx : idx + chars]


def _function_body(source: str, name: str) -> str:
    start = source.index(f"def {name}")
    try:
        end = source.index("\n\ndef ", start + 1)
    except ValueError:
        end = len(source)
    return source[start:end]


def test_media_html_inline_keeps_csp_sandbox():
    """api/media may serve HTML inline only behind a CSP sandbox."""
    # Slice widened to 16000 (was 5000) after the #3234 security work landed a
    # multi-profile-aware deny-list + named-profile-root enumeration +
    # active-workspace carve-out + safety gate earlier in _handle_media, pushing
    # the CSP block to ~12100 chars past the def. (Originally widened 4000→5000
    # for PR #2044's MEDIA_ALLOWED_ROOTS parsing.) The assertion is structural,
    # not positional — generous headroom avoids re-breaking on small future edits.
    body = _slice_after(ROUTES_PY, "def _handle_media", 16000)
    assert 'html_inline_ok = inline_preview and mime == "text/html"' in body
    assert 'csp = "sandbox allow-scripts" if html_inline_ok else None' in body
    assert "csp=csp" in body
    assert "allow-same-origin" not in body


def test_sandboxed_file_responses_do_not_send_x_frame_options():
    """X-Frame-Options: DENY would block the sandbox iframe preview."""
    body = _function_body(ROUTES_PY, "_serve_file_bytes")
    csp_branch = body[body.find("if csp:") : body.find("else:", body.find("if csp:"))]
    assert "Content-Security-Policy" in csp_branch
    assert 'send_header("X-Frame-Options"' not in csp_branch
