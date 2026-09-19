"""Regression coverage for #4300 legacy gateway approval unsupported notice."""

from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GATEWAY_CHAT = (REPO / "api" / "gateway_chat.py").read_text(encoding="utf-8")
def test_gateway_chat_has_approval_notice_emitted_attribute_check():
    """Verify _approval_notice_emitted attribute is checked before emitting."""
    assert "if not hasattr(s, \"_approval_notice_emitted\"):" in GATEWAY_CHAT
    assert "s._approval_notice_emitted = False" in GATEWAY_CHAT


def test_gateway_chat_emits_approval_gateway_unsupported_event():
    """Verify put_gateway_event is called with approval_gateway_unsupported type on non-terminal channel."""
    assert "put_gateway_event(\"warning\"" in GATEWAY_CHAT
    assert "approval_type = \"approval_gateway_unsupported\"" in GATEWAY_CHAT


def test_gateway_chat_once_per_session_guard_pattern():
    """Verify the once-per-session guard: capability check + hasattr + flag check + flag set."""
    assert "approval_reason = gateway_approval_unavailable_reason(base_url, api_key)" in GATEWAY_CHAT
    assert "if approval_reason is not None:" in GATEWAY_CHAT
    assert "if not hasattr(s, \"_approval_notice_emitted\"):" in GATEWAY_CHAT
    assert "if not s._approval_notice_emitted:" in GATEWAY_CHAT
    assert "s._approval_notice_emitted = True" in GATEWAY_CHAT
    # Verify order: capability gate before session guard before flag set
    cap_pos = GATEWAY_CHAT.find("if approval_reason is not None:")
    hasattr_pos = GATEWAY_CHAT.find("if not hasattr(s, \"_approval_notice_emitted\"):")
    flag_check_pos = GATEWAY_CHAT.find("if not s._approval_notice_emitted:")
    flag_set_pos = GATEWAY_CHAT.find("s._approval_notice_emitted = True")
    assert cap_pos < hasattr_pos < flag_check_pos < flag_set_pos


def test_gateway_chat_event_payload_contains_type_and_message():
    """Verify the event payload has type and message fields."""
    assert "approval_type = \"approval_gateway_unsupported\"" in GATEWAY_CHAT
    assert "approval_message = \"Approvals require a newer gateway. Upgrade the connected Hermes gateway to enable this.\"" in GATEWAY_CHAT


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
