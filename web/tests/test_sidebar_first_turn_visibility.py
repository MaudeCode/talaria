"""Regressions for first-turn sessions appearing in the sidebar immediately."""

import pathlib

REPO = pathlib.Path(__file__).parent.parent


def read(rel: str) -> str:
    return (REPO / rel).read_text(encoding="utf-8")


class TestSidebarFirstTurnVisibility:
    def test_backend_compact_counts_pending_first_turn_as_visible(self):
        src = read("api/models.py")
        compact = src[src.index("def compact"):src.index("def _get_profile_home")]
        assert "has_pending_user_message" in compact and "pending_user_message" in compact, (
            "Session.compact() must account for pending_user_message in sidebar metadata."
        )
        assert "message_count = max(message_count, 1)" in compact, (
            "Pending first user turn should make message_count non-zero for /api/sessions."
        )
        assert "pending_started_at" in compact and "last_message_at" in compact, (
            "Pending first user turn should sort by pending_started_at in the sidebar."
        )

    def test_backend_index_filter_keeps_pending_first_turn_sessions(self):
        src = read("api/models.py")
        index_filter_start = src.index("# Hide empty Untitled sessions from the UI entirely")
        index_filter_end = src.index("visible_result = [s for s in sidebar_candidates if not _hide_from_default_sidebar", index_filter_start)
        index_filter = src[index_filter_start:index_filter_end]
        assert "has_pending_user_message" in index_filter, (
            "The index-path empty-session filter must exempt pending first-turn sessions, "
            "matching the full-scan fallback."
        )
