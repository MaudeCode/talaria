"""Regression tests for v0.50.253 Opus pre-release follow-ups.

Three small follow-ups landed alongside the main batch:

1. /branch endpoint rejects non-string session_id with a 400 (instead of
   crashing with a generic 500 from get_session() raising TypeError).
2. /branch endpoint rejects negative keep_count (Python slicing semantics
   would otherwise produce "all but last N" rather than a forward prefix).
3. PR #1342 leaked 9 unused `wiki_*` i18n keys from a different branch.
   These were stripped — assert they don't come back.
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


# ── 1 + 2: /branch endpoint validation ────────────────────────────────────────


def test_branch_endpoint_rejects_non_string_session_id():
    """The handler must reject a non-string session_id with a 400 before
    reaching get_session()."""
    src = (REPO / "api" / "routes.py").read_text(encoding="utf-8")
    branch_handler_idx = src.find('parsed.path == "/api/session/branch":')
    assert branch_handler_idx != -1, "branch handler not found"
    # Look at the next ~1500 chars
    block = src[branch_handler_idx : branch_handler_idx + 1500]
    assert 'isinstance(body["session_id"], str)' in block, (
        "branch handler must isinstance-check session_id before passing to "
        "get_session() — without this, non-string values raise TypeError "
        "and surface as a confusing 500 instead of a 400."
    )
    assert '"session_id must be a string"' in block, (
        "branch handler must return a clear error message for non-string "
        "session_id, not a generic bad-request."
    )


def test_branch_endpoint_rejects_negative_keep_count():
    """The handler must reject keep_count < 0 with a 400. Otherwise Python
    slicing would produce a "all but last N" semantic instead of a forward
    prefix, which is confusing fork behavior."""
    src = (REPO / "api" / "routes.py").read_text(encoding="utf-8")
    branch_handler_idx = src.find('parsed.path == "/api/session/branch":')
    block = src[branch_handler_idx : branch_handler_idx + 2000]
    assert "keep_count < 0" in block, (
        "branch handler must reject negative keep_count — Python's slice "
        "semantics on negative values are 'all but last N', not 'prefix N', "
        "and that's a confusing fork behavior."
    )
    assert '"keep_count must be non-negative"' in block, (
        "branch handler must return a clear error message for negative "
        "keep_count."
    )


# ── 3: orphan wiki_* i18n keys must not return ────────────────────────────────
