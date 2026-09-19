"""Regression checks for #2821 session pin/unpin state sync."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
ROUTES_PY = (ROOT / "api" / "routes.py").read_text(encoding="utf-8")
def _function_block(src: str, name: str) -> str:
    marker = f"function {name}"
    start = src.find(marker)
    assert start != -1, f"{name} not found"
    brace = src.find("{", start)
    assert brace != -1, f"{name} body not found"
    depth = 1
    i = brace + 1
    while i < len(src) and depth:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
        i += 1
    assert depth == 0, f"{name} body did not close"
    return src[start:i]


def test_session_field_helper_reads_dicts_and_objects():
    from api.routes import _session_field

    class SessionLike:
        session_id = "obj-1"
        pinned = True
        archived = False

    assert _session_field({"session_id": "dict-1", "pinned": True}, "pinned", False) is True
    assert _session_field({"session_id": "dict-1"}, "archived", False) is False
    assert _session_field(SessionLike(), "session_id", None) == "obj-1"
    assert _session_field(SessionLike(), "missing", "fallback") == "fallback"


def test_pin_limit_snapshot_uses_all_persisted_rows_before_lock():
    assert "def _session_counts_toward_pin_quota(session)" in ROUTES_PY
    assert "_hide_from_default_sidebar(row)" in ROUTES_PY
    # The complete persisted row set must be snapshotted before LOCK because
    # all_sessions() acquires the same non-reentrant lock internally. Lineage
    # visibility and quota filtering happen from that durable snapshot.
    start = ROUTES_PY.find("persisted_rows = list(all_sessions())")
    assert start != -1, "persisted pin snapshot not found"
    end = ROUTES_PY.find("with LOCK:", start)
    assert end != -1, "persisted pin snapshot should be computed before LOCK"
    assert "_visible_pinned_lineage_ids(persisted_rows)" in ROUTES_PY[end:]
