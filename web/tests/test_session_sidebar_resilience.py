"""Regression tests for large-session sidebar resilience.

The sidebar must fail visibly when the sessions API times out, must not let
optional project metadata blank the conversations list, and must not return
bulky session-detail fields in /api/sessions rows.
"""

from pathlib import Path


REPO_ROOT = Path(__file__).parent.parent


def _sessions_js() -> str:
    return (REPO_ROOT / "static" / "sessions.js").read_text(encoding="utf-8")


def _workspace_js() -> str:
    return (REPO_ROOT / "static" / "workspace.js").read_text(encoding="utf-8")


def test_sessions_sidebar_response_item_drops_bulky_detail_fields(monkeypatch):
    from api import routes

    monkeypatch.setattr(routes, "_session_attention_summary", lambda sid: {"kind": "none"})
    row = {
        "session_id": "sid-heavy",
        "title": "Visible title",
        "display_title": "State DB title",
        "_state_db_title": "State DB title",
        "updated_at": 10,
        "last_message_at": 11,
        "message_count": 123,
        "user_message_count": 61,
        "has_pending_user_message": True,
        "worktree_path": "/tmp/worktree",
        "worktree_branch": "feature/sidebar",
        "compression_anchor_summary": "X" * 50000,
        "compression_anchor_details": {"huge": True},
        "context_engine_state": {"expensive": True},
        "gateway_routing_history": [{"hop": 1}],
        "composer_draft": "draft body",
        "pending_user_message": "private pending text",
        "tool_calls": [{"id": "call"}],
        "messages": [{"role": "user", "content": "not for sidebar"}],
    }

    item = routes._sidebar_session_response_item(row, redact_enabled=False)

    assert item["session_id"] == "sid-heavy"
    assert item["title"] == "Visible title"
    assert item["display_title"] == "State DB title"
    assert item["_state_db_title"] == "State DB title"
    assert item["message_count"] == 123
    assert item["has_pending_user_message"] is True
    assert item["worktree_path"] == "/tmp/worktree"
    assert item["worktree_branch"] == "feature/sidebar"
    assert item["attention"] == {"kind": "none"}
    for key in (
        "compression_anchor_summary",
        "compression_anchor_details",
        "context_engine_state",
        "gateway_routing_history",
        "composer_draft",
        "pending_user_message",
        "tool_calls",
        "messages",
    ):
        assert key not in item


def test_sidebar_allowlist_preserves_fields_consumed_by_frontend():
    from api import routes

    required = {
        "display_title",
        "_state_db_title",
        "has_pending_user_message",
        "worktree_branch",
    }

    assert required <= routes._SIDEBAR_SESSION_RESPONSE_FIELDS
    assert "pending_user_message" not in routes._SIDEBAR_SESSION_RESPONSE_FIELDS


def test_json_helper_can_emit_compact_json_for_large_list_endpoints():
    from api.helpers import _json_response_body

    body = _json_response_body({"a": 1, "nested": {"b": 2}}, pretty=False).decode("utf-8")

    assert body == '{"a":1,"nested":{"b":2}}'
    assert "\n" not in body
