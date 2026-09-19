import pathlib

REPO = pathlib.Path(__file__).parent.parent
STREAMING = (REPO / "api" / "streaming.py").read_text(encoding="utf-8")
def _on_reasoning_body() -> str:
    """Extract the body of the on_reasoning closure by brace/indent scanning."""
    start = STREAMING.index("def on_reasoning(text):")
    # grab a generous slice (the closure is short) bounded by the next top-level
    # `def on_` callback in the same scope.
    nxt = STREAMING.find("\n            def on_", start + 1)
    return STREAMING[start: nxt if nxt != -1 else start + 2500]


def test_reasoning_uses_coalescing_buffer_not_drop():
    body = _on_reasoning_body()
    # A coalescing buffer accumulates every delta...
    assert "_reasoning_buffer[0] += reasoning_delta" in body, (
        "on_reasoning must ACCUMULATE each delta into the coalescing buffer — dropping "
        "deltas would permanently lose live reasoning text (the frontend appends them)"
    )
    # ...and the throttled flush emits the WHOLE buffer, then CLEARS it (so the next
    # emit carries only the since-last-flush accumulation — coarse delta, not cumulative).
    assert "reasoning_event_payload(" in body and "_reasoning_buffer[0]" in body, (
        "the throttled flush must emit the accumulated buffer with optional title metadata"
    )
    # the clear must follow the flush so we don't re-send already-delivered text
    flush_idx = body.index("payload = reasoning_event_payload(")
    clear_idx = body.index("_reasoning_buffer[0] = ''", flush_idx)
    assert clear_idx > flush_idx, "the buffer must be cleared right after each flush"


def test_reasoning_throttle_is_rate_limited():
    body = _on_reasoning_body()
    # ~10 Hz gate (0.1s) on the flush
    assert "_reasoning_last_put" in body and "0.1" in body, (
        "reasoning flush must be rate-limited to ~10 Hz (0.1s gate)"
    )


def test_reasoning_tail_flushed_on_phase_end():
    body = _on_reasoning_body()
    # When the reasoning phase ends (text is None), any remaining buffered text must be
    # flushed so the last partial (<100ms) window isn't lost.
    none_branch = body[body.index("if text is None:"): body.index("if text is None:") + 400]
    assert "_flush_reasoning_buffer(stable=True)" in none_branch, (
        "on_reasoning(text=None) must flush any remaining coalesced buffer (the tail)"
    )


def test_reasoning_buffer_flushed_at_every_boundary():
    # #4729 (Codex re-gate): on_reasoning(None) is effectively dead — the agent never
    # calls reasoning_callback(None) — so the buffered tail must be flushed at the REAL
    # boundaries that close/reorder the live reasoning stream, or it's silently lost:
    #   - a shared _flush_reasoning_buffer() helper
    #   - on_token (visible output starting)
    #   - on_tool (tool boundary)
    #   - after agent.run_conversation() returns (terminal catch-all: a turn can end on
    #     reasoning with no trailing token/tool)
    assert "def _flush_reasoning_buffer(*, stable=False):" in STREAMING, "must have a shared flush helper"
    # helper emits the buffer chunk then clears it (since-last-flush delta semantics)
    helper = STREAMING[STREAMING.index("def _flush_reasoning_buffer(*, stable=False):"):]
    helper = helper[: helper.index("\n\n")]
    assert "reasoning_event_payload(" in helper and "_reasoning_buffer[0] = ''" in helper, (
        "the flush helper must emit the buffered chunk then clear it"
    )
    # on_token flushes before emitting visible output
    on_token = STREAMING[STREAMING.index("def on_token(text):"): STREAMING.index("def on_reasoning(text):")]
    assert "_flush_reasoning_buffer(stable=True)" in on_token, (
        "on_token must flush the reasoning tail before visible output (the reasoning→answer transition)"
    )
    # on_tool flushes before the tool event
    on_tool = STREAMING[STREAMING.index("def on_tool(*cb_args"): STREAMING.index("def on_tool(*cb_args") + 600]
    assert "_flush_reasoning_buffer(stable=True)" in on_tool, (
        "on_tool must flush the reasoning tail before the tool event (reasoning→tool transition)"
    )
    # terminal catch-all: flush right after the agent run returns, AND a guaranteed-exit
    # flush in the inner finally so exception / retry paths (which bypass the post-run
    # flush) still emit the tail before the outer apperror.
    run_idx = STREAMING.index("result = agent.run_conversation(**_run_conversation_kwargs)")
    resolve_idx = STREAMING.index(
        "_active_turn_identity = _resolve_active_turn_authority(",
        run_idx,
    )
    flush_idx = STREAMING.index("_flush_reasoning_buffer(stable=True)", resolve_idx)
    assert run_idx < resolve_idx < flush_idx, (
        "must flush after agent.run_conversation() returns, after turn authority is resolved, "
        "and before terminal SSE delivery"
    )
    # the inner finally must also flush (covers exception/retry exits)
    fin = STREAMING[STREAMING.index("        finally:\n            # #4729"):]
    fin = fin[:700]
    assert "_flush_reasoning_buffer(stable=True)" in fin, (
        "the inner finally must flush the reasoning tail on exception/retry exit paths"
    )
    assert STREAMING.count("_flush_reasoning_buffer(stable=True)") >= 5, (
        "expected flush at on_token, on_reasoning(None), on_tool, post-run, and the finally"
    )


def test_reasoning_title_dedup_resets_for_each_segment():
    interim = STREAMING[
        STREAMING.index("def on_interim_assistant"):
        STREAMING.index("def on_tool(*cb_args")
    ]
    tool = STREAMING[
        STREAMING.index("# (#3587) Advance reasoning index at tool-call boundaries."):
        STREAMING.index("args_snap = _tool_args_snapshot")
    ]
    assert "_current_reasoning_idx += 1" in interim
    assert "_reset_reasoning_title_segment()" in interim
    assert "_current_reasoning_idx += 1" in tool
    assert "_reset_reasoning_title_segment()" in tool


def test_unstable_local_reasoning_events_do_not_materialize_the_segment():
    body = _on_reasoning_body()
    flush = STREAMING[
        STREAMING.index("def _flush_reasoning_buffer(*, stable=False):"):
        STREAMING.index("def _emit_metering()")
    ]
    assert 'reasoning_event_payload(\n                        _reasoning_buffer[0],\n                        "",' in body
    assert '_current_reasoning_text() if stable else ""' in flush
