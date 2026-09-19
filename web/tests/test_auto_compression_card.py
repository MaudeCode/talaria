from pathlib import Path

from api.compression_anchor import visible_messages_for_anchor
from api.models import Session
from api.streaming import (
    _POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG,
    _compressed_context_tool_result_summary,
    _is_agent_compression_start_status,
    _is_fallback_lifecycle_message,
    _merge_display_messages_after_agent_result,
    _message_text,
    _prune_context_tool_results_after_compression,
    _restore_reasoning_metadata,
    _sanitize_messages_for_api,
)


ROOT = Path(__file__).resolve().parents[1]


def _read(relpath: str) -> str:
    return (ROOT / relpath).read_text(encoding="utf-8")


def _compressed_listener_block() -> str:
    src = _read("static/messages.js")
    start = src.find("source.addEventListener('compressed'")
    assert start != -1, "compressed SSE listener not found"
    end = src.find("source.addEventListener('metering'", start)
    assert end != -1, "metering listener after compressed SSE listener not found"
    return src[start:end]


def _compressing_listener_block() -> str:
    src = _read("static/messages.js")
    start = src.find("source.addEventListener('compressing'")
    assert start != -1, "compressing SSE listener not found"
    end = src.find("source.addEventListener('compressed'", start)
    assert end != -1, "compressed listener after compressing SSE listener not found"
    return src[start:end]


def test_post_compression_context_prunes_tail_tool_results_with_active_compressor():
    class FakeCompressor:
        protect_last_n = 20
        tail_token_budget = 4096

        def __init__(self):
            self.calls = []

        def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None):
            self.calls.append(
                {
                    "protect_tail_count": protect_tail_count,
                    "protect_tail_tokens": protect_tail_tokens,
                }
            )
            out = []
            pruned = 0
            for msg in messages:
                next_msg = dict(msg)
                if next_msg.get("role") == "tool" and len(str(next_msg.get("content") or "")) > 200:
                    next_msg["content"] = "[browser_navigate] opened page (large snapshot summarized)"
                    pruned += 1
                out.append(next_msg)
            return out, pruned

    compressor = FakeCompressor()
    agent = type("Agent", (), {"context_compressor": compressor})()
    context_messages = [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call_big"}]},
        {"role": "tool", "tool_call_id": "call_big", "content": "x" * 5000},
        {"role": "assistant", "content": "Final answer"},
    ]

    pruned = _prune_context_tool_results_after_compression(agent, context_messages)

    assert compressor.calls == [{"protect_tail_count": 20, "protect_tail_tokens": 4096}]
    assert pruned[1]["content"] == "[browser_navigate] opened page (large snapshot summarized)"
    assert context_messages[1]["content"] == "x" * 5000


def test_post_compression_context_hard_prunes_protected_tail_tool_payload():
    class NoopCompressor:
        protect_last_n = 20
        tail_token_budget = 1024
        threshold_tokens = 4096

        def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None):
            return messages, 0

    compressor = NoopCompressor()
    agent = type("Agent", (), {"context_compressor": compressor})()
    recent_payload = ("recent protected payload\n" * 1800) + "RECENT_TOOL_PAYLOAD_END"
    session = Session(
        session_id="budgetproof1",
        title="Budget proof",
        workspace="/tmp",
        model="gpt-4o",
        messages=[
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_recent"}]},
            {"role": "tool", "tool_call_id": "call_recent", "content": recent_payload},
            {"role": "assistant", "content": "Final answer"},
        ],
        context_messages=[
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_recent"}]},
            {"role": "tool", "tool_call_id": "call_recent", "content": recent_payload},
            {"role": "assistant", "content": "Final answer"},
        ],
    )

    session.context_messages = _prune_context_tool_results_after_compression(
        agent,
        session.context_messages,
    )

    visible_tool = session.messages[1]["content"]
    context_tool = session.context_messages[1]["content"]
    context_tool_tokens = (len(_message_text(context_tool)) + 3) // 4

    assert visible_tool == recent_payload
    assert "RECENT_TOOL_PAYLOAD_END" in visible_tool
    assert context_tool != recent_payload
    assert "RECENT_TOOL_PAYLOAD_END" not in context_tool
    assert "WebUI compressed-context budget" in context_tool
    assert session.context_messages[1][_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG] is True
    assert context_tool_tokens <= compressor.tail_token_budget


def test_post_compression_context_note_only_replacement_consumes_residual_budget():
    class NoopCompressor:
        protect_last_n = 20
        tail_token_budget = 1024
        threshold_tokens = 4096

        def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None):
            return messages, 0

    compressor = NoopCompressor()
    agent = type("Agent", (), {"context_compressor": compressor})()
    old_small_payload = "s" * 80
    old_oversize_payload = "h" * 2000
    recent_payload = "r" * 4000
    context_messages = [
        {"role": "tool", "tool_call_id": "call_old_small", "content": old_small_payload},
        {"role": "tool", "tool_call_id": "call_old_oversize", "content": old_oversize_payload},
        {"role": "tool", "tool_call_id": "call_recent", "content": recent_payload},
    ]

    pruned = _prune_context_tool_results_after_compression(agent, context_messages)

    assert pruned[2]["content"] == recent_payload
    assert pruned[1]["content"] != old_oversize_payload
    assert "WebUI compressed-context budget" in pruned[1]["content"]
    assert pruned[1][_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG] is True
    assert pruned[0]["content"] != old_small_payload
    assert "WebUI compressed-context budget" in pruned[0]["content"]
    assert pruned[0][_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG] is True
    assert _POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG not in pruned[2]
    assert context_messages[0]["content"] == old_small_payload


def test_post_compression_context_hard_prune_is_idempotent():
    class NoopCompressor:
        protect_last_n = 20
        tail_token_budget = 1024
        threshold_tokens = 4096

        def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None):
            return messages, 0

    compressor = NoopCompressor()
    agent = type("Agent", (), {"context_compressor": compressor})()
    context_messages = [
        {"role": "tool", "tool_call_id": f"call_{idx}", "content": (f"tool {idx} payload\n" * 350)}
        for idx in range(4)
    ]

    once = _prune_context_tool_results_after_compression(agent, context_messages)
    twice = _prune_context_tool_results_after_compression(agent, once)

    assert [msg["content"] for msg in twice] == [msg["content"] for msg in once]
    assert any("WebUI compressed-context budget" in str(msg.get("content") or "") for msg in once)
    assert [
        msg.get(_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG)
        for msg in twice
    ] == [
        msg.get(_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG)
        for msg in once
    ]
    assert context_messages[0]["content"] != once[0]["content"]


def test_post_compression_context_hard_prune_preserves_old_summary_after_new_tool_rows():
    class NoopCompressor:
        protect_last_n = 20
        tail_token_budget = 1024
        threshold_tokens = 4096

        def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None):
            return messages, 0

    compressor = NoopCompressor()
    agent = type("Agent", (), {"context_compressor": compressor})()
    context_messages = [
        {"role": "tool", "tool_call_id": f"call_{idx}", "content": (f"tool {idx} payload\n" * 350)}
        for idx in range(4)
    ]

    once = _prune_context_tool_results_after_compression(agent, context_messages)
    old_summary = once[-1]["content"]
    assert "\n\n[WebUI compressed-context budget:" in old_summary
    assert once[-1][_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG] is True
    assert f"of {len(context_messages[-1]['content'])} chars" in old_summary

    with_new_tool = once + [
        {
            "role": "tool",
            "tool_call_id": "call_new",
            "content": "newer over-budget payload\n" * 700,
        }
    ]
    twice = _prune_context_tool_results_after_compression(agent, with_new_tool)

    assert twice[-2]["content"] == old_summary
    assert twice[-2][_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG] is True
    assert f"of {len(context_messages[-1]['content'])} chars" in twice[-2]["content"]


def test_post_compression_context_hard_prune_counts_raw_tool_whitespace():
    class NoopCompressor:
        protect_last_n = 20
        tail_token_budget = 1024
        threshold_tokens = 4096

        def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None):
            return messages, 0

    compressor = NoopCompressor()
    agent = type("Agent", (), {"context_compressor": compressor})()
    whitespace_padded_payload = ("x" + (" " * 79)) * 1000
    context_messages = [
        {"role": "tool", "tool_call_id": "call_padded", "content": whitespace_padded_payload},
    ]

    once = _prune_context_tool_results_after_compression(agent, context_messages)

    assert once[0]["content"] != whitespace_padded_payload
    assert "WebUI compressed-context budget" in once[0]["content"]
    assert once[0][_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG] is True
    assert context_messages[0]["content"] == whitespace_padded_payload


def test_post_compression_context_hard_prune_keeps_idless_twin_summaries():
    class NoopCompressor:
        protect_last_n = 20
        tail_token_budget = 512
        threshold_tokens = 1024

        def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None):
            return messages, 0

    compressor = NoopCompressor()
    agent = type("Agent", (), {"context_compressor": compressor})()
    payload = "same idless payload\n" * 300
    context_messages = [{"role": "tool", "content": payload} for _ in range(3)]

    once = _prune_context_tool_results_after_compression(agent, context_messages)

    assert len(once) == 3
    assert sum("WebUI compressed-context budget" in msg["content"] for msg in once) == 3
    assert sum(msg.get(_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG) is True for msg in once) == 3


def test_post_compression_context_pruned_tool_summary_does_not_backfill_into_display():
    full_tool_output = "full visible output\n" * 200
    summary = _compressed_context_tool_result_summary(
        full_tool_output,
        original_tokens=(len(full_tool_output) + 3) // 4,
        keep_tokens=0,
    )
    previous_display = [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call_big"}]},
        {"role": "tool", "tool_call_id": "call_big", "content": full_tool_output},
        {"role": "assistant", "content": "Final answer"},
    ]
    previous_context = [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call_big"}]},
        {
            "role": "tool",
            "tool_call_id": "call_big",
            "content": summary,
            _POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG: True,
        },
        {"role": "assistant", "content": "Final answer"},
    ]
    result_messages = previous_context + [
        {"role": "user", "content": "next question"},
        {"role": "assistant", "content": "next answer"},
    ]

    merged = _merge_display_messages_after_agent_result(
        previous_display,
        previous_context,
        result_messages,
        "next question",
    )

    merged_tool_contents = [msg["content"] for msg in merged if msg.get("role") == "tool"]
    assert full_tool_output in merged_tool_contents
    assert summary not in merged_tool_contents


def test_post_compression_context_raw_marker_collision_still_prunes():
    class NoopCompressor:
        protect_last_n = 20
        tail_token_budget = 1024
        threshold_tokens = 4096

        def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None):
            return messages, 0

    compressor = NoopCompressor()
    agent = type("Agent", (), {"context_compressor": compressor})()
    raw_payload = (
        "tool echoed marker text: [WebUI compressed-context budget: not a generated summary]\n"
        + ("raw collision payload\n" * 600)
        + "RAW_COLLISION_END"
    )
    context_messages = [
        {"role": "tool", "tool_call_id": "call_collision", "content": raw_payload},
    ]

    once = _prune_context_tool_results_after_compression(agent, context_messages)
    twice = _prune_context_tool_results_after_compression(agent, once)

    assert once[0]["content"] != raw_payload
    assert "RAW_COLLISION_END" not in once[0]["content"]
    assert "WebUI compressed-context budget" in once[0]["content"]
    assert once[0][_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG] is True
    assert twice[0]["content"] == once[0]["content"]
    assert context_messages[0]["content"] == raw_payload


def test_post_compression_context_exact_note_shape_without_flag_still_prunes():
    class NoopCompressor:
        protect_last_n = 20
        tail_token_budget = 1024
        threshold_tokens = 4096

        def _prune_old_tool_results(self, messages, protect_tail_count, protect_tail_tokens=None):
            return messages, 0

    compressor = NoopCompressor()
    agent = type("Agent", (), {"context_compressor": compressor})()
    generated_note = _compressed_context_tool_result_summary(
        "prior generated payload",
        original_tokens=512,
        keep_tokens=0,
    )
    raw_payload = (
        ("raw shape-collision payload\n" * 600)
        + "RAW_SHAPE_COLLISION_END\n\n"
        + generated_note
    )
    context_messages = [
        {"role": "tool", "tool_call_id": "call_shape_collision", "content": raw_payload},
    ]

    once = _prune_context_tool_results_after_compression(agent, context_messages)

    assert once[0]["content"] != raw_payload
    assert "RAW_SHAPE_COLLISION_END" not in once[0]["content"]
    assert once[0][_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG] is True
    assert context_messages[0]["content"] == raw_payload


def test_post_compression_context_unflagged_note_shape_can_stay_visible():
    visible_shape = _compressed_context_tool_result_summary(
        "visible tool payload",
        original_tokens=256,
        keep_tokens=0,
    )
    previous_display = [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call_visible"}]},
        {"role": "tool", "tool_call_id": "call_visible", "content": visible_shape},
    ]
    previous_context = [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call_visible"}]},
        {"role": "tool", "tool_call_id": "call_visible", "content": visible_shape},
    ]
    result_messages = previous_context + [
        {"role": "user", "content": "next question"},
        {"role": "assistant", "content": "next answer"},
    ]

    merged = _merge_display_messages_after_agent_result(
        previous_display,
        previous_context,
        result_messages,
        "next question",
    )

    assert visible_shape in [msg.get("content") for msg in merged if msg.get("role") == "tool"]


def test_post_compression_context_private_flag_restored_but_not_sent_to_provider():
    previous_context = [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call_pruned"}]},
        {
            "role": "tool",
            "tool_call_id": "call_pruned",
            "content": _compressed_context_tool_result_summary(
                "large generated payload",
                original_tokens=512,
                keep_tokens=0,
            ),
            _POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG: True,
        },
    ]
    api_safe = _sanitize_messages_for_api(previous_context)

    assert _POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG not in api_safe[1]

    restored = _restore_reasoning_metadata(previous_context, api_safe)

    assert restored[1][_POST_COMPRESSION_TOOL_RESULT_SUMMARY_FLAG] is True


def test_agent_status_callback_emits_compressing_and_warning_events():
    src = _read("api/streaming.py")
    start = src.find("def _agent_status_callback")
    assert start != -1, "agent status callback bridge not found"
    end = src.find("# Initialised here", start)
    assert end != -1, "status callback block end marker not found"
    block = src[start:end]

    # compressing events only via the narrowed helper (no broad substring matcher)
    assert "put('compressing'" in block
    assert "'session_id': session_id" in block
    assert "'message': 'Compressing context'" in block
    assert "_is_agent_compression_start_status(_kind, _message)" in block
    assert "or 'compressing' in _lower" not in block
    assert "or 'preflight compression' in _lower" not in block

    # warning events with type:fallback for rate-limit/fallback lifecycle notices
    assert "put('warning'" in block
    assert "'type': 'fallback'" in block
    assert "'rate limited'" in src
    assert "'switching to fallback'" in src
    assert "'falling back'" in src
    assert "'fallback activated'" in src
    assert "'trying fallback'" in src

    # Verify callback is wired to agent
    assert "'status_callback' in _agent_params" in src
    assert "_agent_kwargs['status_callback'] = _agent_status_callback" in src
    assert "agent.status_callback = _agent_kwargs.get('status_callback')" in src


def test_agent_compression_start_status_matches_real_emitters_only():
    # Real start notices from hermes-agent emitters
    # Preflight compression is intentionally excluded — the later
        # authoritative ``Compacting context`` marker from
        # conversation_compression is the signal that compression
        # actually proceeded, and the preflight status can fire even
        # when compression exits before compaction (e.g. durable
        # guard refresh, Codex-Hermes mode with no active thread).
    assert not _is_agent_compression_start_status(
        "lifecycle",
        "📦 Preflight compression: ~101,000 tokens >= 96,000 threshold. This may take a moment.",
    )
    assert _is_agent_compression_start_status(
        "lifecycle",
        "📦 Pre-API compression: ~521,055 tokens near the context/output limit. Compacting before the next model call.",
    )
    assert _is_agent_compression_start_status(
        "lifecycle",
        "🗜️ Compacting context — summarizing earlier conversation so I can continue...",
    )
    assert _is_agent_compression_start_status(
        "lifecycle",
        "🗜️ Context too large (~120,000 tokens) — compressing (1/3)...",
    )
    assert _is_agent_compression_start_status(
        "lifecycle",
        "⚠️  Request payload too large (413) — compression attempt 1/3...",
    )

    # False positives that previously (or could) light the divider on low-token turns
    assert not _is_agent_compression_start_status(
        "lifecycle",
        "Skipping preflight compression: rough estimate ~20,000 >= 96,000, but last real provider prompt was 18,000 after compression",
    )
    assert not _is_agent_compression_start_status(
        "lifecycle",
        "Skipping preflight compression: same-session cooldown active (~30 seconds remaining, session abc)",
    )
    assert not _is_agent_compression_start_status(
        "lifecycle",
        "Skipping Hermes preflight compression for codex app-server (mode=native); Hermes will not start thread compaction here.",
    )
    assert not _is_agent_compression_start_status(
        "lifecycle",
        "🗜️ Compressed 924 → 143 messages, retrying...",
    )
    assert not _is_agent_compression_start_status(
        "lifecycle",
        "Rate limited — switching to fallback provider...",
    )
    assert not _is_agent_compression_start_status("tool", "compacting context")
    assert not _is_agent_compression_start_status("lifecycle", "")
    assert not _is_agent_compression_start_status("lifecycle", "Working on request")


def test_agent_status_callback_wiring():
    src = _read("api/streaming.py")
    assert "_agent_status_callback" in src
    assert "_agent_kwargs['status_callback'] = _agent_status_callback" in src


def test_fallback_lifecycle_message_predicate_matches_agent_emitters():
    assert _is_fallback_lifecycle_message(
        "lifecycle",
        "Rate limited — switching to fallback provider...",
    )
    assert _is_fallback_lifecycle_message(
        "lifecycle",
        "Non-retryable error (HTTP 500) — trying fallback...",
    )
    assert not _is_fallback_lifecycle_message(
        "tool",
        "Rate limited — switching to fallback provider...",
    )
    assert not _is_fallback_lifecycle_message(
        "lifecycle",
        "Compressing context",
    )


def test_auto_compression_done_payload_includes_live_usage_snapshot():
    src = _read("api/streaming.py")
    start = src.find("put('compressed'")
    assert start != -1, "compressed SSE payload not found"
    end = src.find("})", start)
    assert end != -1, "compressed SSE payload end not found"
    block = src[start:end]

    assert "'session_id': _compression_origin_session_id" in block
    assert "'old_session_id': _compression_origin_session_id" in block
    assert "'new_session_id': _compression_continuation_session_id" in block
    assert "'continuation_session_id': _compression_continuation_session_id" in block
    assert "'message': 'Compression finished'" in block
    assert "'usage': _live_usage_snapshot()" in block


def test_auto_compression_rotation_tracks_origin_and_continuation_ids_for_sse():
    src = _read("api/streaming.py")
    rotate_start = src.find("# ── Handle context compression side effects ──")
    assert rotate_start != -1, "compression side-effect block not found"
    rotate_end = src.find("# Stamp 'timestamp'", rotate_start)
    assert rotate_end != -1, "compression side-effect block end not found"
    block = src[rotate_start:rotate_end]

    assert "_compression_origin_session_id = session_id" in block
    assert "_compression_continuation_session_id = None" in block
    assert "_compression_origin_session_id = old_sid" in block
    assert "_compression_continuation_session_id = new_sid" in block
    assert "'new_session_id': _compression_continuation_session_id" in block


def test_session_model_round_trips_context_engine_metadata(tmp_path, monkeypatch):
    import api.models as models

    state_dir = tmp_path / "state"
    session_dir = state_dir / "sessions"
    session_dir.mkdir(parents=True)
    monkeypatch.setattr(models, "SESSION_DIR", session_dir)
    monkeypatch.setattr(models, "SESSION_INDEX_FILE", state_dir / "session_index.json")

    session = Session(
        session_id="lcm_metadata",
        workspace=str(tmp_path),
        context_engine="lcm",
        compression_anchor_engine="lcm",
        compression_anchor_mode="lossless_retrieval",
        compression_anchor_details={"retrieval_tools": ["lcm_grep"]},
        context_engine_state={"status": "indexed"},
    )
    session.save(touch_updated_at=False)

    loaded = Session.load("lcm_metadata")
    assert loaded.context_engine == "lcm"
    assert loaded.compression_anchor_engine == "lcm"
    assert loaded.compression_anchor_mode == "lossless_retrieval"
    assert loaded.compression_anchor_details == {"retrieval_tools": ["lcm_grep"]}
    assert loaded.context_engine_state == {"status": "indexed"}


def test_backend_auto_anchor_count_excludes_compaction_marker_cards():
    messages = [
        {"role": "user", "content": "before compression"},
        {"role": "assistant", "content": "[CONTEXT COMPACTION — REFERENCE ONLY] summary"},
        {"role": "assistant", "content": "after compression"},
        {"role": "tool", "content": "hidden tool output"},
        {"role": "user", "content": "[Your active task list was preserved across context compression]"},
    ]

    visible = visible_messages_for_anchor(messages, auto_compression=True)

    assert [m["content"] for m in visible] == ["before compression", "after compression"]
