from api.models import _repair_misordered_active_turn_users
from api.streaming import _settle_current_turn_boundary


def _identity(prompt, current_turn_user_idx):
    return {
        "token": "stream:turn",
        "text": prompt,
        "timestamp": 4.0,
        "source": "webui",
        "attachments": [],
        "current_turn_user_idx": current_turn_user_idx,
        "turn_id": "turn-current",
        "agent_turn_boundary_resolved": True,
        "agent_turn_boundary_source": "result",
    }


def test_compaction_rewrite_inserts_current_user_after_latest_preserved_tail():
    previous_context = [
        {"id": 10, "role": "user", "content": "Older request"},
        {"id": 11, "role": "assistant", "content": "Older answer"},
        {"id": 12, "role": "assistant", "content": "Most recent completed answer"},
    ]
    result_messages = [
        previous_context[0],
        {
            "id": 11,
            "role": "assistant",
            "content": "[CONTEXT COMPACTION — REFERENCE ONLY] summary",
            "_compressed_summary": True,
        },
        previous_context[2],
        {"id": 14, "role": "assistant", "content": "", "tool_calls": [{"id": "call_now"}]},
        {"id": 15, "role": "tool", "tool_call_id": "call_now", "content": "current output"},
        {"id": 16, "role": "assistant", "content": "Current answer"},
    ]

    settled = _settle_current_turn_boundary(
        previous_context,
        result_messages,
        _identity("Worked?", len(previous_context)),
        "Worked?",
        "webui",
    )

    assert [(m["role"], m["content"]) for m in settled] == [
        ("user", "Older request"),
        ("assistant", "[CONTEXT COMPACTION — REFERENCE ONLY] summary"),
        ("assistant", "Most recent completed answer"),
        ("user", "Worked?"),
        ("assistant", ""),
        ("tool", "current output"),
        ("assistant", "Current answer"),
    ]
    assert settled[3]["id"] == 13
    assert settled[3]["_active_turn_token"] == "stream:turn"


def test_compaction_rewrite_does_not_use_unstable_content_only_overlap():
    previous_context = [
        {"role": "user", "content": "Repeated"},
        {"role": "assistant", "content": "Repeated answer"},
    ]
    result_messages = [
        {"role": "assistant", "content": "[CONTEXT COMPACTION — REFERENCE ONLY] summary"},
        {"role": "assistant", "content": "Current answer"},
    ]

    settled = _settle_current_turn_boundary(
        previous_context,
        result_messages,
        _identity("Current prompt", len(previous_context)),
        "Current prompt",
        "webui",
    )

    # Without stable ids, retain the legacy boundary fallback instead of guessing
    # from repeated text.
    assert settled[0]["role"] == "user"
    assert settled[0]["content"] == "Current prompt"


def test_existing_misordered_active_user_is_repaired_from_stable_ids():
    messages = [
        {"role": "user", "content": "Worked?", "_active_turn_token": "turn:42"},
        {"id": 10, "role": "user", "content": "Older request"},
        {"id": 11, "role": "assistant", "content": "Compaction summary"},
        {"id": 41, "role": "assistant", "content": "Previous completed answer"},
        {"id": 43, "role": "assistant", "content": "", "tool_calls": [{"id": "call"}]},
        {"id": 44, "role": "tool", "tool_call_id": "call", "content": "result"},
        {"id": 45, "role": "assistant", "content": "Current answer"},
    ]

    repaired = _repair_misordered_active_turn_users(messages)

    assert [message["id"] for message in repaired] == [10, 11, 41, 42, 43, 44, 45]
    assert [message.get("id") for message in messages] == [None, 10, 11, 41, 43, 44, 45]


def test_correct_active_user_boundary_is_left_unchanged():
    messages = [
        {"id": 10, "role": "assistant", "content": "Previous"},
        {"id": 11, "role": "user", "content": "Current", "_active_turn_token": "turn:11"},
        {"id": 12, "role": "assistant", "content": "Answer"},
    ]

    assert _repair_misordered_active_turn_users(messages) == messages
