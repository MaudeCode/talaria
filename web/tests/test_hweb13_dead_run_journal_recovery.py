"""HWEB-13: recover prose from a dead run journal when pending state is nil.

`_apply_core_sync_or_error_marker` only repairs a turn while
``pending_user_message`` still holds the prompt.  A run abandoned with lost
worker bookkeeping has already had its pending state cleared, so
`_clear_stale_stream_state` used to drop the ``active_stream_id`` — the only
key into the run journal — without ever reading it.
"""

import json
import time

import pytest

import api.models as models
import api.routes as routes
from api.models import Session, _recover_dead_run_journal
from api.run_journal import append_run_event


@pytest.fixture(autouse=True)
def _isolate_session_state(tmp_path, monkeypatch):
    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    monkeypatch.setattr(models, "SESSION_DIR", session_dir)
    monkeypatch.setattr(models, "SESSION_INDEX_FILE", session_dir / "_index.json")
    models.SESSIONS.clear()
    with routes.STREAMS_LOCK:
        routes.STREAMS.clear()
    yield
    models.SESSIONS.clear()


def _dead_session(session_id, stream_id, *, messages=None):
    """A settled session still pointing at a run whose worker is gone."""
    session = Session(
        session_id=session_id,
        title="Dead run",
        messages=list(messages if messages is not None else [
            {"role": "user", "content": "Trace the regression", "timestamp": 1},
        ]),
        context_messages=[
            {"role": "user", "content": "Trace the regression", "timestamp": 1},
        ],
        active_stream_id=stream_id,
    )
    # The defining condition of this ticket: pending state was already cleared.
    session.pending_user_message = None
    session.pending_attachments = []
    session.pending_started_at = None
    session.pending_user_source = None
    session.save()
    return session


def _journal_a_full_turn(session_id, stream_id):
    append_run_event(session_id, stream_id, "reasoning", {"text": "Reading the stale branch."})
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "The clear path never reads the journal."})
    append_run_event(
        session_id,
        stream_id,
        "tool",
        {"name": "terminal", "preview": "rg _clear_stale_stream_state", "args": {"command": "rg x"}},
    )
    append_run_event(session_id, stream_id, "tool_complete", {"name": "terminal", "duration": 0.2})
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "So the prose is dropped on refresh."})


def _visible(session):
    return [
        m.get("content")
        for m in session.messages
        if m.get("_recovered_from_run_journal") and m.get("content")
    ]


def test_lost_worker_run_recovers_prose_reasoning_tools_and_one_marker(monkeypatch):
    session_id = "hweb13_lost_worker"
    stream_id = "hweb13_stream_a"
    session = _dead_session(session_id, stream_id)
    _journal_a_full_turn(session_id, stream_id)
    monkeypatch.setattr(routes, "get_session", lambda sid, **_kw: session)

    assert routes._clear_stale_stream_state(session) is True

    assert _visible(session) == [
        "The clear path never reads the journal.",
        "So the prose is dropped on refresh.",
    ]
    assert session.messages[1].get("reasoning") == "Reading the stale branch."
    assert [t["name"] for t in session.tool_calls] == ["terminal"]
    assert session.tool_calls[0]["done"] is True
    markers = [m for m in session.messages if m.get("type") == "interrupted"]
    assert len(markers) == 1
    assert markers[0]["interruption_cause"] == "lost_worker_bookkeeping"
    assert "recovered from the run journal" in markers[0]["content"]
    assert session.active_stream_id is None

    models.SESSIONS.clear()
    reloaded = models.get_session(session_id)
    assert _visible(reloaded) == _visible(session)
    assert reloaded.active_stream_id is None
    # The settled payload's activity scene is projected from tool_calls anchored
    # to a recovered assistant owner; without a valid anchor the scene is empty.
    anchor_idx = reloaded.tool_calls[0]["assistant_msg_idx"]
    assert reloaded.messages[anchor_idx]["_recovered_from_run_journal"] is True
    assert reloaded.messages[anchor_idx]["role"] == "assistant"


def test_repeated_reads_do_not_duplicate_recovered_content():
    session_id = "hweb13_repeat"
    stream_id = "hweb13_stream_repeat"
    session = _dead_session(session_id, stream_id)
    _journal_a_full_turn(session_id, stream_id)

    assert _recover_dead_run_journal(session, stream_id) is True
    first = list(session.messages)
    first_tools = list(session.tool_calls)

    assert _recover_dead_run_journal(session, stream_id) is False
    assert session.messages == first
    assert session.tool_calls == first_tools


def test_successor_run_recovers_only_its_own_journal():
    session_id = "hweb13_successor"
    first_stream = "hweb13_run_one"
    second_stream = "hweb13_run_two"
    session = _dead_session(session_id, first_stream)
    _journal_a_full_turn(session_id, first_stream)
    assert _recover_dead_run_journal(session, first_stream) is True

    append_run_event(session_id, second_stream, "interim_assistant", {"text": "Second run output."})
    assert _recover_dead_run_journal(session, second_stream) is True

    assert _visible(session) == [
        "The clear path never reads the journal.",
        "So the prose is dropped on refresh.",
        "Second run output.",
    ]
    assert len([m for m in session.messages if m.get("type") == "interrupted"]) == 2


def test_cancelled_dead_run_recovers_output_with_marker():
    session_id = "hweb13_cancel"
    stream_id = "hweb13_stream_cancel"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Partial work before cancel."})
    append_run_event(session_id, stream_id, "cancel", {})

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == ["Partial work before cancel."]
    assert len([m for m in session.messages if m.get("type") == "interrupted"]) == 1


def test_completed_dead_run_recovers_output_without_marker():
    session_id = "hweb13_completed"
    stream_id = "hweb13_stream_done"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Finished answer."})
    append_run_event(session_id, stream_id, "done", {})

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == ["Finished answer."]
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_errored_dead_run_materializes_the_gateway_error():
    session_id = "hweb13_error"
    stream_id = "hweb13_stream_error"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Work before the error."})
    append_run_event(
        session_id,
        stream_id,
        "apperror",
        {
            "session_id": session_id,
            "session": {
                "session_id": session_id,
                "messages": [
                    {"role": "user", "content": "Trace the regression"},
                    {"role": "assistant", "content": "Provider rejected the request.", "_error": True},
                ],
            },
        },
    )

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == [
        "Work before the error.",
        "Provider rejected the request.",
    ]
    # The specific gateway error replaces the generic interruption marker.
    assert not [m for m in session.messages if m.get("type") == "interrupted"]
    assert session.messages[-1]["content"] == "Provider rejected the request."
    assert session.messages[-1]["_error"] is True


def test_conclusively_empty_journal_leaves_the_transcript_untouched():
    """A sealed journal with no visible output is not an inconclusive read."""
    session_id = "hweb13_empty"
    stream_id = "hweb13_stream_empty"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "done", {})

    assert _recover_dead_run_journal(session, stream_id) is False
    assert len(session.messages) == 1


def test_live_worker_journal_is_left_alone(monkeypatch):
    session_id = "hweb13_live"
    stream_id = "hweb13_stream_live"
    session = _dead_session(session_id, stream_id)
    _journal_a_full_turn(session_id, stream_id)
    monkeypatch.setattr(routes, "get_session", lambda sid, **_kw: session)
    with routes.STREAMS_LOCK:
        routes.STREAMS[stream_id] = object()
    try:
        assert routes._clear_stale_stream_state(session) is False
    finally:
        with routes.STREAMS_LOCK:
            routes.STREAMS.pop(stream_id, None)

    assert _visible(session) == []
    assert session.active_stream_id == stream_id


def test_detached_live_worker_journal_is_left_alone(monkeypatch):
    """No SSE channel but live worker bookkeeping is a detached run, not a dead one."""
    import api.config as config

    session_id = "hweb13_detached"
    stream_id = "hweb13_stream_detached"
    session = _dead_session(session_id, stream_id)
    _journal_a_full_turn(session_id, stream_id)
    monkeypatch.setattr(routes, "get_session", lambda sid, **_kw: session)
    with config.ACTIVE_RUNS_LOCK:
        config.ACTIVE_RUNS[stream_id] = {"started_at": time.time()}
    try:
        assert routes._clear_stale_stream_state(session) is False
    finally:
        with config.ACTIVE_RUNS_LOCK:
            config.ACTIVE_RUNS.pop(stream_id, None)

    assert _visible(session) == []
    assert session.active_stream_id == stream_id


def test_compression_snapshot_run_is_not_recovered():
    session_id = "hweb13_snapshot"
    stream_id = "hweb13_stream_snapshot"
    session = _dead_session(session_id, stream_id)
    session.pre_compression_snapshot = True
    _journal_a_full_turn(session_id, stream_id)

    assert _recover_dead_run_journal(session, stream_id) is False
    assert _visible(session) == []


def test_pending_turns_still_route_through_core_sync_repair(monkeypatch):
    """The pending path keeps its own repair; recovery must not double-append."""
    session_id = "hweb13_pending"
    stream_id = "hweb13_stream_pending"
    session = _dead_session(session_id, stream_id)
    session.pending_user_message = "Trace the regression again"
    session.pending_started_at = time.time() - 300
    session.save()
    _journal_a_full_turn(session_id, stream_id)
    monkeypatch.setattr(routes, "get_session", lambda sid, **_kw: session)

    assert routes._clear_stale_stream_state(session) is True

    assert _visible(session) == [
        "The clear path never reads the journal.",
        "So the prose is dropped on refresh.",
    ]
    assert len([m for m in session.messages if m.get("type") == "interrupted"]) == 1
    assert session.pending_user_message is None


def test_invisible_journal_keeps_the_stream_id_on_a_retry_hook():
    """A journal that is not yet visible must not lose its only lookup key.

    `active_stream_id` is the only way back to the run journal.  On a
    delayed-visibility filesystem the journal appears moments later, so hand the
    stream id to the existing lazy-retry hook rather than clearing it.
    """
    session_id = "hweb13_invisible"
    stream_id = "hweb13_stream_invisible"
    session = _dead_session(session_id, stream_id)
    # No journal events at all yet — the file has not become visible.

    assert _recover_dead_run_journal(session, stream_id) is True

    marker = session.messages[-1]
    assert marker["_pending_journal_recovery"] is True
    assert marker["_journal_retry_stream_id"] == stream_id
    assert marker["_journal_retry_attempts"] == 0

    # The armed marker is what the read-side self-heal looks for, and the retry
    # recovers the output once the journal lands.
    assert models._session_has_pending_journal_retry(session) is True
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Late but real output."})
    assert models._retry_journal_recovery_in_place(session) is True
    assert _visible(session) == ["Late but real output."]


def test_repeated_historical_prose_is_not_claimed_by_an_unrelated_row():
    """Journal prose matching an older answer must not be swallowed by it.

    Without pending metadata there is no turn boundary, so session-wide content
    dedupe could claim an unrelated historical assistant row — the dead run's
    output and its interruption marker would both vanish.
    """
    session_id = "hweb13_repeat_prose"
    stream_id = "hweb13_stream_repeat_prose"
    repeated = "The migration is already applied; nothing further to do."
    session = _dead_session(
        session_id,
        stream_id,
        messages=[
            {"role": "user", "content": "Is the migration applied?", "timestamp": 1},
            {"role": "assistant", "content": repeated, "timestamp": 2},
            {"role": "user", "content": "Check again after the restart", "timestamp": 3},
        ],
    )
    append_run_event(session_id, stream_id, "interim_assistant", {"text": repeated})

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == [repeated]
    assert len([m for m in session.messages if m.get("type") == "interrupted"]) == 1


def test_recovered_prefix_is_replayed_incrementally_not_cumulatively():
    """A visible prefix arms an incremental retry, never a cumulative replay.

    `token` events aggregate, so replaying a grown journal from the start yields
    "Hello" where the first pass yielded "Hel"; the content deduper cannot match
    the two and both rows land in `messages` and `context_messages`. The retry
    carries a cursor instead, so the second pass appends only the tail.
    """
    session_id = "hweb13_prefix"
    stream_id = "hweb13_stream_prefix"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "token", {"text": "Hel"})

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == ["Hel"]
    marker = session.messages[-1]
    assert marker["type"] == "interrupted"
    assert marker["_pending_journal_recovery"] is True
    assert marker["_journal_retry_after_seq"] == 1
    assert models._session_has_pending_journal_retry(session) is True

    append_run_event(session_id, stream_id, "token", {"text": "lo world."})
    append_run_event(session_id, stream_id, "done", {})
    assert models._retry_journal_recovery_in_place(session) is True

    assert _visible(session) == ["Hel", "lo world."]
    assistant_context = [
        m["content"] for m in session.context_messages if m.get("role") == "assistant"
    ]
    assert assistant_context == ["Hel", "lo world."], "cumulative replay duplicated prose into context"
    # The journal ended in `done`: the run completed, so no interruption marker
    # survives, exactly as a first-pass recovery of a completed run.
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_three_nonterminal_waves_recover_each_fragment_once():
    session_id = "hweb13_waves"
    stream_id = "hweb13_stream_waves"
    session = _dead_session(session_id, stream_id)
    fragments = ["First wave.", "Second wave.", "Third wave."]

    append_run_event(session_id, stream_id, "interim_assistant", {"text": fragments[0]})
    assert _recover_dead_run_journal(session, stream_id) is True
    for fragment in fragments[1:]:
        append_run_event(session_id, stream_id, "interim_assistant", {"text": fragment})
        assert models._retry_journal_recovery_in_place(session) is True
        # Still nonterminal: the hook stays armed at the advanced cursor.
        marker = session.messages[-1]
        assert marker["type"] == "interrupted"
        assert marker["_pending_journal_recovery"] is True

    assert _visible(session) == fragments
    assistant_context = [
        m["content"] for m in session.context_messages if m.get("role") == "assistant"
    ]
    assert assistant_context == fragments
    assert len([m for m in session.messages if m.get("type") == "interrupted"]) == 1
    assert session.messages[-1]["_journal_retry_after_seq"] == 3

    # A wave that only re-reads the unchanged journal is not progress.
    assert models._retry_journal_recovery_in_place(session) is False
    assert _visible(session) == fragments


def test_oversized_journal_recovers_its_early_events(monkeypatch):
    """A journal larger than one window is walked, not clipped to its tail."""
    session_id = "hweb13_oversized_journal"
    stream_id = "hweb13_stream_oversized_journal"
    session = _dead_session(session_id, stream_id)
    lines = [f"Line {i} of a long answer." for i in range(1, 7)]
    for line in lines:
        append_run_event(session_id, stream_id, "interim_assistant", {"text": line})
    append_run_event(session_id, stream_id, "done", {})
    # Roughly two rows per window: the journal spans several windows.
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 600)

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == lines
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_journal_beyond_one_pass_continues_from_the_cursor(monkeypatch):
    """Per-pass work stays capped; the cursor carries the rest to the next read."""
    session_id = "hweb13_multipass"
    stream_id = "hweb13_stream_multipass"
    session = _dead_session(session_id, stream_id)
    lines = [f"Line {i} of a long answer." for i in range(1, 7)]
    for line in lines:
        append_run_event(session_id, stream_id, "interim_assistant", {"text": line})
    append_run_event(session_id, stream_id, "done", {})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 600)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    assert _recover_dead_run_journal(session, stream_id) is True
    first_pass = _visible(session)
    assert lines[:1] <= first_pass < lines, first_pass
    marker = session.messages[-1]
    assert marker["_pending_journal_recovery"] is True
    assert marker["_journal_retry_after_seq"] == len(first_pass)

    # Each later read advances one window until the terminal event lands.
    for _ in range(len(lines)):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == lines
    assert not [m for m in session.messages if m.get("type") == "interrupted"]
    assistant_context = [
        m["content"] for m in session.context_messages if m.get("role") == "assistant"
    ]
    assert assistant_context == lines


def test_rewound_cursor_offset_never_reapplies_covered_rows():
    """The offset is a seek hint; the seq is the contract.

    An offset that no longer sits on a row boundary falls back to the file
    start, and the rows the cursor already covers are skipped rather than
    replayed as a second copy of the prefix.
    """
    session_id = "hweb13_rewound"
    stream_id = "hweb13_stream_rewound"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Already applied."})
    assert _recover_dead_run_journal(session, stream_id) is True
    marker = session.messages[-1]
    assert marker["_journal_retry_after_seq"] == 1
    marker["_journal_retry_offset"] -= 3  # mid-row: not a boundary

    append_run_event(session_id, stream_id, "interim_assistant", {"text": "New tail."})
    assert models._retry_journal_recovery_in_place(session) is True
    assert _visible(session) == ["Already applied.", "New tail."]
    assert session.messages[-1]["_journal_retry_after_seq"] == 2


def test_capped_pass_of_metadata_rows_keeps_the_cursor_armed(monkeypatch):
    """Windows holding only invisible rows must not read as conclusively empty.

    The output or terminal row lies beyond the pass cap; returning False would
    let the caller clear the only stream key and lose the unread tail.
    """
    session_id = "hweb13_metadata_cap"
    stream_id = "hweb13_stream_metadata_cap"
    session = _dead_session(session_id, stream_id)
    for i in range(6):
        append_run_event(session_id, stream_id, "metering", {"turn": i, "tokens": 10 * i})
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "After the metadata."})
    append_run_event(session_id, stream_id, "done", {})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 600)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == []
    marker = session.messages[-1]
    assert marker["_pending_journal_recovery"] is True
    assert marker["_journal_retry_after_seq"] >= 1

    for _ in range(8):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == ["After the metadata."]
    assert not [m for m in session.messages if m.get("type") == "interrupted"]
    # Metadata-only passes advanced the cursor without spending retry budget.
    assert models._JOURNAL_RETRY_MAX_ATTEMPTS > 8


def test_retry_settles_instead_of_crossing_a_newer_user_turn():
    """An old run's late tail must not land behind a newer prompt.

    Once the user has sent another message, appending the tail would put its
    context projection after the new prompt. The marker settles as it stands.
    """
    session_id = "hweb13_turn_boundary"
    stream_id = "hweb13_stream_turn_boundary"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "token", {"text": "Hel"})
    assert _recover_dead_run_journal(session, stream_id) is True
    assert session.messages[-1]["_pending_journal_recovery"] is True

    newer = {"role": "user", "content": "Never mind, next question", "timestamp": 5}
    session.messages.append(newer)
    session.context_messages.append(dict(newer))
    append_run_event(session_id, stream_id, "token", {"text": "lo world."})
    append_run_event(session_id, stream_id, "done", {})

    assert models._retry_journal_recovery_in_place(session) is False
    assert _visible(session) == ["Hel"]
    assert session.context_messages[-1]["content"] == "Never mind, next question"
    marker = next(m for m in session.messages if m.get("type") == "interrupted")
    assert "_pending_journal_recovery" not in marker
    assert marker["content"] == models._INTERRUPTED_RECOVERED_WORDING
    assert models._session_has_pending_journal_retry(session) is False


def test_cursorless_multi_window_pass_keeps_repeated_activity(monkeypatch):
    """Dedupe against the sidecar, never against rows this pass just appended.

    A legacy armed marker has no cursor, so its retry replays with content
    dedupe. Paging through several windows, a tool or progress line that
    legitimately repeats in a later window must not be mistaken for the copy an
    earlier window of the same pass materialized.
    """
    session_id = "hweb13_repeat_windows"
    stream_id = "hweb13_stream_repeat_windows"
    session = _dead_session(session_id, stream_id)
    marker = models._interrupted_recovery_marker(pending_retry=True, stream_id=stream_id)
    models._arm_journal_retry(marker, stream_id)
    session.messages.append(marker)
    for _ in range(3):
        append_run_event(session_id, stream_id, "interim_assistant", {"text": "Checking the branch again."})
        append_run_event(
            session_id, stream_id, "tool",
            {"name": "terminal", "preview": "git status", "args": {"command": "git status"}},
        )
        append_run_event(session_id, stream_id, "tool_complete", {"name": "terminal", "duration": 0.1})
    append_run_event(session_id, stream_id, "done", {})
    # One iteration per window, so the repeats land in later windows.
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 700)

    assert models._retry_journal_recovery_in_place(session) is True
    assert _visible(session) == ["Checking the branch again."] * 3
    assert [t["name"] for t in session.tool_calls] == ["terminal"] * 3
    assert all(t["done"] for t in session.tool_calls)


def test_rewound_offset_over_a_long_covered_prefix_keeps_advancing(monkeypatch):
    """Skipping already-covered rows is progress even when a pass places nothing.

    A rewound offset whose covered prefix spans more than one pass must carry
    the advanced cursor forward; otherwise every read rescans the same prefix
    until the retry budget expires and the tail is never reached.
    """
    session_id = "hweb13_rewound_long"
    stream_id = "hweb13_stream_rewound_long"
    session = _dead_session(session_id, stream_id)
    prefix = [f"Covered line {i}." for i in range(1, 7)]
    for line in prefix:
        append_run_event(session_id, stream_id, "interim_assistant", {"text": line})
    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == prefix
    marker = session.messages[-1]
    assert marker["_journal_retry_after_seq"] == len(prefix)
    marker["_journal_retry_offset"] -= 3  # mid-row: falls back to the file start

    append_run_event(session_id, stream_id, "interim_assistant", {"text": "The tail."})
    append_run_event(session_id, stream_id, "done", {})
    # One small window per pass: the covered prefix alone spans several passes.
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 300)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    for _ in range(len(prefix) + 2):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == prefix + ["The tail."]
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_final_row_without_its_newline_is_still_recovered():
    """A writer that crashed after its last row but before the newline.

    The tail reader accepted such a row; the forward reader must too, or the
    cursor sits before it forever and a final token or terminal event is lost.
    If the newline arrives later, the next window steps over it.
    """
    from api.run_journal import _run_path

    session_id = "hweb13_unterminated"
    stream_id = "hweb13_stream_unterminated"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Before the crash."})
    append_run_event(session_id, stream_id, "token", {"text": "Final tok"})
    path = _run_path(session_id, stream_id)
    raw = path.read_bytes()
    assert raw.endswith(b"\n")
    path.write_bytes(raw[:-1])

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == ["Before the crash.", "Final tok"]
    marker = session.messages[-1]
    assert marker["_pending_journal_recovery"] is True
    assert marker["_journal_retry_after_seq"] == 2

    # The newline lands after all, followed by the rest of the run.
    with path.open("ab") as fh:
        fh.write(b"\n")
    append_run_event(session_id, stream_id, "token", {"text": "en."})
    append_run_event(session_id, stream_id, "done", {})
    assert models._retry_journal_recovery_in_place(session) is True
    assert _visible(session) == ["Before the crash.", "Final tok", "en."]
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_token_stream_keeps_its_whitespace_across_window_boundaries(monkeypatch):
    """Windows are artificial; a token stream crossing one stays one row.

    Flushing at every boundary would strip the boundary whitespace and split
    "Hello" / " world" into two rows, altering transcript and model context.
    """
    session_id = "hweb13_window_whitespace"
    stream_id = "hweb13_stream_window_whitespace"
    session = _dead_session(session_id, stream_id)
    words = ["Hello", " world", " this", " is", " one", " row."]
    for word in words:
        append_run_event(session_id, stream_id, "token", {"text": word})
    append_run_event(session_id, stream_id, "done", {})
    # Roughly two token rows per window.
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 420)

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == ["Hello world this is one row."]
    assistant_context = [
        m["content"] for m in session.context_messages if m.get("role") == "assistant"
    ]
    assert assistant_context == ["Hello world this is one row."]


def test_pending_turn_repair_walks_an_oversized_journal_too(monkeypatch):
    """The pending-turn sibling must not clip a completed run to its tail."""
    session_id = "hweb13_pending_oversized"
    stream_id = "hweb13_stream_pending_oversized"
    session = _dead_session(session_id, stream_id)
    session.pending_user_message = "Trace the regression again"
    session.pending_started_at = time.time() - 300
    session.save()
    lines = [f"Line {i} of a long answer." for i in range(1, 7)]
    for line in lines:
        append_run_event(session_id, stream_id, "interim_assistant", {"text": line})
    append_run_event(session_id, stream_id, "done", {})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 600)

    assert models._apply_core_sync_or_error_marker(
        session,
        models.SESSION_DIR / "missing-core.json",
        stream_id_for_recheck=stream_id,
    ) is True
    assert _visible(session) == lines
    assert session.pending_user_message is None
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_token_stream_keeps_its_whitespace_across_pass_caps(monkeypatch):
    """The pass cap is as artificial as a window boundary.

    Text still open when a pass ends rides on the marker's cursor and is
    flushed only at a semantic boundary or the journal end, so a token stream
    spanning several passes stays one row with its whitespace.
    """
    session_id = "hweb13_pass_whitespace"
    stream_id = "hweb13_stream_pass_whitespace"
    session = _dead_session(session_id, stream_id)
    words = ["Hello", " world", " this", " is", " one", " row."]
    for word in words:
        append_run_event(session_id, stream_id, "token", {"text": word})
    append_run_event(session_id, stream_id, "done", {})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 420)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    assert _recover_dead_run_journal(session, stream_id) is True
    marker = session.messages[-1]
    assert marker["_pending_journal_recovery"] is True
    assert marker["_journal_retry_carry"]["assistant_text"].startswith("Hello")
    assert _visible(session) == []

    for _ in range(len(words) + 2):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == ["Hello world this is one row."]
    assistant_context = [
        m["content"] for m in session.context_messages if m.get("role") == "assistant"
    ]
    assert assistant_context == ["Hello world this is one row."]
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_open_text_is_flushed_when_the_marker_settles_behind_a_newer_turn(monkeypatch):
    session_id = "hweb13_carry_settle"
    stream_id = "hweb13_stream_carry_settle"
    session = _dead_session(session_id, stream_id)
    for word in ["Partial", " answer"]:
        append_run_event(session_id, stream_id, "token", {"text": word})
    append_run_event(session_id, stream_id, "token", {"text": " continues"})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 420)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == []
    carried = session.messages[-1]["_journal_retry_carry"]["assistant_text"]
    assert carried and "Partial answer continues".startswith(carried)

    newer = {"role": "user", "content": "Next question", "timestamp": 5}
    session.messages.append(newer)
    session.context_messages.append(dict(newer))
    assert models._retry_journal_recovery_in_place(session) is False

    # The open text is materialized as it was carried, above the marker.
    assert _visible(session) == [carried]
    marker = next(m for m in session.messages if m.get("type") == "interrupted")
    assert "_journal_retry_carry" not in marker
    assert marker["content"] == models._INTERRUPTED_RECOVERED_WORDING
    assert session.messages.index(marker) > session.messages.index(
        next(m for m in session.messages if m.get("content") == carried)
    )
    assert session.context_messages[-1]["content"] == "Next question"


def _carry_armed_session(monkeypatch, session_id, stream_id, words):
    session = _dead_session(session_id, stream_id)
    for word in words:
        append_run_event(session_id, stream_id, "token", {"text": word})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 420)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)
    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == []
    assert session.messages[-1]["_journal_retry_carry"]["assistant_text"]
    return session


def test_flushed_carry_never_rides_the_cursor_again(monkeypatch):
    """Text flushed at the journal end must not be replayed by the next read."""
    session_id = "hweb13_carry_once"
    stream_id = "hweb13_stream_carry_once"
    words = ["Partial", " answer", " that", " just", " stops"]
    session = _carry_armed_session(monkeypatch, session_id, stream_id, words)

    # The writer is dead: reads reach the end of file with text still open,
    # which flushes it once. Later reads must not flush it again.
    for _ in range(len(words) + 4):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == ["".join(words)]
    marker = session.messages[-1]
    assert "_journal_retry_carry" not in marker
    for _ in range(3):
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == ["".join(words)]


def test_unreadable_journal_keeps_the_carry(monkeypatch):
    """A read failure is not the end of the run; carried text stays put."""
    from api.run_journal import _run_path

    session_id = "hweb13_carry_unreadable"
    stream_id = "hweb13_stream_carry_unreadable"
    words = ["Hello", " world", " this", " is", " one", " row."]
    session = _carry_armed_session(monkeypatch, session_id, stream_id, words)
    carried = session.messages[-1]["_journal_retry_carry"]["assistant_text"]

    path = _run_path(session_id, stream_id)
    hidden = path.with_name(path.name + ".hidden")
    path.rename(hidden)
    assert models._retry_journal_recovery_in_place(session) is False
    assert _visible(session) == []
    assert session.messages[-1]["_journal_retry_carry"]["assistant_text"] == carried

    hidden.rename(path)
    append_run_event(session_id, stream_id, "done", {})
    for _ in range(len(words) + 2):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == ["Hello world this is one row."]


def test_oversized_carry_is_flushed_instead_of_growing(monkeypatch):
    """A carry past its cap becomes a row so the marker stays bounded."""
    session_id = "hweb13_carry_cap"
    stream_id = "hweb13_stream_carry_cap"
    words = ["Hello", " world", " this", " is", " one", " row."]
    monkeypatch.setattr(models, "_RECOVERY_CARRY_MAX_CHARS", 8)
    session = _dead_session(session_id, stream_id)
    for word in words:
        append_run_event(session_id, stream_id, "token", {"text": word})
    append_run_event(session_id, stream_id, "done", {})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 420)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    assert _recover_dead_run_journal(session, stream_id) is True
    for _ in range(len(words) + 2):
        if not models._session_has_pending_journal_retry(session):
            break
        marker = session.messages[-1]
        assert len(marker.get("_journal_retry_carry", {}).get("assistant_text", "")) <= 8
        models._retry_journal_recovery_in_place(session)
    visible = _visible(session)
    assert len(visible) > 1, "the cap should have forced at least one split"
    assert "".join(v.replace(" ", "") for v in visible) == "".join(words).replace(" ", "")
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_completed_pending_turn_keeps_a_hook_when_the_forward_read_fails(monkeypatch):
    """Tail says completed, forward read fails: inconclusive, not settled."""
    session_id = "hweb13_pending_unavailable"
    stream_id = "hweb13_stream_pending_unavailable"
    session = _dead_session(session_id, stream_id)
    session.pending_user_message = "Trace the regression again"
    session.pending_started_at = time.time() - 300
    session.save()
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "The whole answer."})
    append_run_event(session_id, stream_id, "done", {})

    real_window = models._read_run_journal_window
    failures = {"n": 1}

    def _flaky(sid, rid, **kwargs):
        if failures["n"]:
            failures["n"] -= 1
            return {"events": [], "truncated": False, "unavailable": True,
                    "cursor": kwargs.get("cursor") or {"seq": 0, "offset": 0}}
        return real_window(sid, rid, **kwargs)

    monkeypatch.setattr(models, "_read_run_journal_window", _flaky)
    assert models._apply_core_sync_or_error_marker(
        session,
        models.SESSION_DIR / "missing-core.json",
        stream_id_for_recheck=stream_id,
    ) is True
    assert session.pending_user_message is None
    assert _visible(session) == []
    marker = session.messages[-1]
    assert marker["_pending_journal_recovery"] is True

    assert models._retry_journal_recovery_in_place(session) is True
    assert _visible(session) == ["The whole answer."]
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_core_sync_repair_keeps_the_cursor_when_rows_remain(monkeypatch):
    """A synced core transcript plus a capped metadata-only pass must not drop the run."""
    session_id = "hweb13_core_sync_capped"
    stream_id = "hweb13_stream_core_sync_capped"
    session = Session(session_id=session_id, title="Core sync", messages=[], active_stream_id=stream_id)
    session.pending_user_message = "Trace the regression again"
    session.pending_started_at = time.time() - 300
    session.save()
    core_path = models.SESSION_DIR / "core.json"
    core_path.write_text(json.dumps({
        "messages": [
            {"role": "user", "content": "Earlier question", "timestamp": 1},
            {"role": "assistant", "content": "Earlier answer", "timestamp": 2},
        ],
    }))
    for i in range(6):
        append_run_event(session_id, stream_id, "metering", {"turn": i, "tokens": 10 * i})
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "After the metadata."})
    append_run_event(session_id, stream_id, "done", {})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 600)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    assert models._apply_core_sync_or_error_marker(
        session, core_path, stream_id_for_recheck=stream_id,
    ) is True
    assert session.active_stream_id is None
    marker = session.messages[-1]
    assert marker["_pending_journal_recovery"] is True
    assert marker["_journal_retry_after_seq"] >= 1

    for _ in range(8):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == ["After the metadata."]
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_pending_turn_defers_a_tail_error_until_the_walk_reaches_it(monkeypatch):
    """A gateway error seen in the tail must not settle a capped walk early."""
    session_id = "hweb13_pending_tail_error"
    stream_id = "hweb13_stream_pending_tail_error"
    session = _dead_session(session_id, stream_id)
    session.pending_user_message = "Trace the regression"
    session.pending_started_at = time.time() - 300
    session.save()
    lines = [f"Line {i} before the error." for i in range(1, 7)]
    for line in lines:
        append_run_event(session_id, stream_id, "interim_assistant", {"text": line})
    append_run_event(
        session_id, stream_id, "apperror",
        {
            "session_id": session_id,
            "session": {
                "session_id": session_id,
                "messages": [
                    {"role": "user", "content": "Trace the regression"},
                    {"role": "assistant", "content": "Provider rejected the request.", "_error": True},
                ],
            },
        },
    )
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 600)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    assert models._apply_core_sync_or_error_marker(
        session, models.SESSION_DIR / "missing-core.json", stream_id_for_recheck=stream_id,
    ) is True
    assert session.pending_user_message is None
    assert lines[:1] <= _visible(session) < lines
    assert not any(m.get("_error") and m.get("content") == "Provider rejected the request." for m in session.messages)
    marker = session.messages[-1]
    assert marker["_pending_journal_recovery"] is True

    for _ in range(len(lines) + 2):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == lines + ["Provider rejected the request."]
    assert session.messages[-1]["_error"] is True
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


@pytest.mark.parametrize("terminal", ["done", "cancel"])
def test_paged_retry_settles_an_output_free_terminal(monkeypatch, terminal):
    """A continuation pass that reaches the terminal row is conclusive on its own."""
    session_id = f"hweb13_paged_terminal_{terminal}"
    stream_id = f"hweb13_stream_paged_terminal_{terminal}"
    session = _dead_session(session_id, stream_id)
    for i in range(6):
        append_run_event(session_id, stream_id, "metering", {"turn": i, "tokens": 10 * i})
    append_run_event(session_id, stream_id, terminal, {})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 600)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    assert _recover_dead_run_journal(session, stream_id) is True
    assert session.messages[-1]["_pending_journal_recovery"] is True

    for _ in range(10):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == []
    assert models._session_has_pending_journal_retry(session) is False
    markers = [m for m in session.messages if m.get("type") == "interrupted"]
    if terminal == "done":
        assert not markers, "a completed run leaves no interruption marker"
    else:
        assert len(markers) == 1
        assert markers[0]["content"] == models._INTERRUPTED_NO_OUTPUT_WORDING
        assert "_journal_retry_after_seq" not in markers[0]


def _apperror_payload(session_id):
    return {
        "session_id": session_id,
        "session": {
            "session_id": session_id,
            "messages": [
                {"role": "user", "content": "Trace the regression"},
                {"role": "assistant", "content": "Provider rejected the request.", "_error": True},
            ],
        },
    }


def test_early_error_defers_to_a_later_authoritative_terminal(monkeypatch):
    """An apperror in an early window must not settle the walk before its tail."""
    session_id = "hweb13_early_error_done"
    stream_id = "hweb13_stream_early_error_done"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Before the error."})
    append_run_event(session_id, stream_id, "apperror", _apperror_payload(session_id))
    lines = [f"Line {i} after a recovered error." for i in range(1, 5)]
    for line in lines:
        append_run_event(session_id, stream_id, "interim_assistant", {"text": line})
    append_run_event(session_id, stream_id, "done", {})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 600)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    assert _recover_dead_run_journal(session, stream_id) is True
    marker = session.messages[-1]
    assert marker["_pending_journal_recovery"] is True
    assert not any(m.get("_error") and m.get("content") == "Provider rejected the request." for m in session.messages)

    for _ in range(10):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == ["Before the error."] + lines
    # The later `done` is authoritative: no error row, no marker.
    assert not any(m.get("_error") for m in session.messages)


def test_early_error_is_materialized_once_the_walk_is_conclusive(monkeypatch):
    """When no later terminal exists, the carried error lands at the end."""
    session_id = "hweb13_early_error_only"
    stream_id = "hweb13_stream_early_error_only"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Before the error."})
    append_run_event(session_id, stream_id, "apperror", _apperror_payload(session_id))
    lines = [f"Line {i} after the error." for i in range(1, 5)]
    for line in lines:
        append_run_event(session_id, stream_id, "interim_assistant", {"text": line})
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 600)
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_WINDOWS", 1)

    assert _recover_dead_run_journal(session, stream_id) is True
    assert session.messages[-1]["_pending_journal_recovery"] is True
    for _ in range(10):
        if not models._session_has_pending_journal_retry(session):
            break
        models._retry_journal_recovery_in_place(session)
    assert _visible(session) == ["Before the error."] + lines + ["Provider rejected the request."]
    assert session.messages[-1]["_error"] is True
    assert not [m for m in session.messages if m.get("type") == "interrupted"]


def test_tool_completion_in_a_later_wave_settles_the_earlier_card():
    session_id = "hweb13_wave_tool"
    stream_id = "hweb13_stream_wave_tool"
    session = _dead_session(session_id, stream_id)
    append_run_event(
        session_id, stream_id, "tool",
        {"name": "terminal", "preview": "rg cursor", "args": {"command": "rg cursor"}},
    )
    assert _recover_dead_run_journal(session, stream_id) is True
    assert [t["done"] for t in session.tool_calls] == [False]

    append_run_event(
        session_id, stream_id, "tool_complete",
        {"name": "terminal", "duration": 0.5, "is_error": False, "preview": "2 matches"},
    )
    append_run_event(session_id, stream_id, "cancel", {})
    assert models._retry_journal_recovery_in_place(session) is True

    assert len(session.tool_calls) == 1
    assert session.tool_calls[0]["done"] is True
    assert session.tool_calls[0]["preview"] == "2 matches"
    marker = session.messages[-1]
    assert marker["type"] == "interrupted"
    assert "_pending_journal_recovery" not in marker


def test_stuck_prefix_keeps_recovered_wording_when_the_retry_gives_up():
    """A worker that died mid-answer leaves a prefix and never a terminal row.

    The armed hook polls a journal that never grows; when its budget runs out
    the marker must settle on the recovered wording, not claim the output above
    it may have been lost.
    """
    session_id = "hweb13_stuck_prefix"
    stream_id = "hweb13_stream_stuck_prefix"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "token", {"text": "Hel"})
    assert _recover_dead_run_journal(session, stream_id) is True

    for _ in range(models._JOURNAL_RETRY_MAX_ATTEMPTS):
        assert models._retry_journal_recovery_in_place(session) is False
    marker = session.messages[-1]
    assert "_pending_journal_recovery" not in marker
    assert marker["content"] == models._INTERRUPTED_RECOVERED_WORDING
    assert _visible(session) == ["Hel"]


def test_terminal_journal_marker_is_final():
    """A run with a terminal event is settled — no retry hook, no churn."""
    session_id = "hweb13_terminal_marker"
    stream_id = "hweb13_stream_terminal_marker"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "All of the answer."})
    append_run_event(session_id, stream_id, "cancel", {})

    assert _recover_dead_run_journal(session, stream_id) is True
    marker = session.messages[-1]
    assert marker["type"] == "interrupted"
    assert "_pending_journal_recovery" not in marker
    assert models._session_has_pending_journal_retry(session) is False


def test_recovery_never_reads_an_unbounded_journal(monkeypatch):
    """Recovery runs on session APIs under the per-session lock.

    A run journal has no size cap, so every recovery reader must go through the
    bounded window rather than parsing the whole file.
    """
    import api.run_journal as run_journal

    session_id = "hweb13_bounded"
    stream_id = "hweb13_stream_bounded"
    session = _dead_session(session_id, stream_id)
    _journal_a_full_turn(session_id, stream_id)

    # The unbounded reader is what stalls the endpoint — nothing on the recovery
    # path may reach it, including the pending-turn repair path's readers.
    def _forbidden(*_args, **_kwargs):
        raise AssertionError("recovery must not call the unbounded read_run_events()")

    monkeypatch.setattr(run_journal, "read_run_events", _forbidden)

    windows = []
    real_tail = run_journal.read_run_event_tail
    real_window = run_journal.read_run_event_window

    def _record(sid, rid, **kwargs):
        windows.append((kwargs.get("max_bytes"), kwargs.get("max_rows")))
        return real_tail(sid, rid, **kwargs)

    def _record_window(sid, rid, **kwargs):
        windows.append((kwargs.get("max_bytes"), kwargs.get("max_rows")))
        return real_window(sid, rid, **kwargs)

    monkeypatch.setattr(run_journal, "read_run_event_tail", _record)
    monkeypatch.setattr(run_journal, "read_run_event_window", _record_window)

    assert _recover_dead_run_journal(session, stream_id) is True
    assert _visible(session) == [
        "The clear path never reads the journal.",
        "So the prose is dropped on refresh.",
    ]
    assert windows, "recovery did not go through the bounded reader"
    assert all(
        limit == (models._RECOVERY_JOURNAL_MAX_BYTES, models._RECOVERY_JOURNAL_MAX_ROWS)
        for limit in windows
    )


def test_pending_turn_repair_is_bounded_too(monkeypatch):
    """The pre-existing pending path shares the same readers and the same cap."""
    import api.run_journal as run_journal

    session_id = "hweb13_bounded_pending"
    stream_id = "hweb13_stream_bounded_pending"
    session = _dead_session(session_id, stream_id)
    session.pending_user_message = "Trace the regression again"
    session.pending_started_at = time.time() - 300
    session.save()
    _journal_a_full_turn(session_id, stream_id)

    def _forbidden(*_args, **_kwargs):
        raise AssertionError("recovery must not call the unbounded read_run_events()")

    monkeypatch.setattr(run_journal, "read_run_events", _forbidden)

    assert models._apply_core_sync_or_error_marker(
        session,
        models.SESSION_DIR / "missing-core.json",
        stream_id_for_recheck=stream_id,
    ) is True
    assert _visible(session) == [
        "The clear path never reads the journal.",
        "So the prose is dropped on refresh.",
    ]


def test_output_free_terminal_failure_still_records_an_outcome():
    """A cancel/error journal with no visible output must still settle the turn.

    The run really did stop, and this is the last read before the stream id — the
    only key back to the journal — is cleared, so returning silently would leave
    a persisted user turn with no outcome and no way to recover one.
    """
    session_id = "hweb13_silent_cancel"
    stream_id = "hweb13_stream_silent_cancel"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "cancel", {})

    assert _recover_dead_run_journal(session, stream_id) is True
    marker = session.messages[-1]
    assert marker["type"] == "interrupted"
    assert marker["_error"] is True
    assert marker["_recovered_stream_id"] == stream_id


def test_late_tool_complete_settles_the_already_recovered_card():
    """A `tool_complete` in a later replay must settle the existing card.

    Any armed retry re-runs `_append_journaled_partial_output` with
    `dedupe_existing=True`. The dedupe skips the already-materialized card, so
    without tracking the persisted dict the completion has nothing to apply to
    and the card stays running forever.
    """
    session_id = "hweb13_late_tool"
    stream_id = "hweb13_stream_late_tool"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Running the search."})
    append_run_event(
        session_id,
        stream_id,
        "tool",
        {"name": "terminal", "preview": "rg _journal_tool_already_present", "args": {"command": "rg x"}},
    )

    assert _recover_dead_run_journal(session, stream_id) is True
    assert [t["done"] for t in session.tool_calls] == [False]

    append_run_event(
        session_id,
        stream_id,
        "tool_complete",
        {"name": "terminal", "duration": 1.25, "is_error": False, "preview": "3 matches"},
    )
    append_run_event(session_id, stream_id, "done", {})
    models._append_journaled_partial_output(session, stream_id, dedupe_existing=True)

    assert len(session.tool_calls) == 1, "the replay duplicated the tool card"
    card = session.tool_calls[0]
    assert card["done"] is True
    assert card["duration"] == 1.25
    assert card["is_error"] is False
    assert card["preview"] == "3 matches"


def test_oversized_terminal_row_still_recovers(monkeypatch):
    """One JSONL row larger than the recovery window must not read as empty.

    `read_run_event_tail` seeks to `size - max_bytes` and trims through the next
    newline, so a window landing inside an oversized row returns nothing. An
    `apperror` embedding a whole terminal session payload is exactly that shape,
    and treating it as eventless would clear the stream id and lose the error.
    """
    session_id = "hweb13_oversized"
    stream_id = "hweb13_stream_oversized"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Work before the error."})
    append_run_event(
        session_id,
        stream_id,
        "apperror",
        {
            "session_id": session_id,
            # Padding stands in for a large embedded terminal session payload.
            "bulk": "x" * 4096,
            "session": {
                "session_id": session_id,
                "messages": [
                    {"role": "user", "content": "Trace the regression"},
                    {"role": "assistant", "content": "Provider rejected the request.", "_error": True},
                ],
            },
        },
    )

    # Shrink the window below that row so the trim consumes the whole read.
    monkeypatch.setattr(models, "_RECOVERY_JOURNAL_MAX_BYTES", 1024)

    assert _recover_dead_run_journal(session, stream_id) is True
    assert session.messages[-1]["content"] == "Provider rejected the request."
    assert session.messages[-1]["_error"] is True


def test_one_recovery_uses_a_single_journal_snapshot(monkeypatch):
    """Replay and terminal classification must see the same journal.

    Reading separately is a TOCTOU: a journal advancing mid-call lets replay see
    a prefix while classification sees a later `done`, which suppresses the
    interruption marker and then clears the stream id — presenting a turn as
    successful while its tail is silently missing.
    """
    session_id = "hweb13_snapshot"
    stream_id = "hweb13_stream_snapshot"
    session = _dead_session(session_id, stream_id)
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Only the prefix."})

    real_read = models._read_run_journal_window
    reads = {"n": 0}

    def _advancing_read(sid, rid, **kwargs):
        # Simulate the journal becoming visible mid-call: every read after the
        # first also sees a terminal `done` the replay never got.
        reads["n"] += 1
        if reads["n"] > 1:
            append_run_event(sid, rid, "done", {})
        return real_read(sid, rid, **kwargs)

    monkeypatch.setattr(models, "_read_run_journal_window", _advancing_read)

    assert _recover_dead_run_journal(session, stream_id) is True
    assert reads["n"] == 1, f"recovery took {reads['n']} journal snapshots, expected 1"
    assert _visible(session) == ["Only the prefix."]
    # Classification saw the same prefix replay did, so the turn is still marked
    # interrupted rather than silently presented as complete.
    assert [m for m in session.messages if m.get("type") == "interrupted"]


def test_recovery_marker_does_not_bubble_an_old_session(monkeypatch):
    """A recovery marker is dated by its run, not by when it was read.

    `Session.compact()` derives `last_message_at` from the newest message
    timestamp and the sidebar sorts on it, so a `time.time()` marker would move
    an old conversation to the top merely by loading it — defeating the caller's
    deliberate `save(touch_updated_at=False)`.
    """
    session_id = "hweb13_recency"
    stream_id = "hweb13_stream_recency"
    long_ago = time.time() - (30 * 24 * 3600)
    session = _dead_session(
        session_id,
        stream_id,
        messages=[{"role": "user", "content": "An old question", "timestamp": int(long_ago)}],
    )
    append_run_event(
        session_id, stream_id, "interim_assistant",
        {"text": "An old, interrupted answer."}, created_at=long_ago,
    )
    append_run_event(session_id, stream_id, "cancel", {}, created_at=long_ago + 1)

    assert _recover_dead_run_journal(session, stream_id) is True

    marker = next(m for m in session.messages if m.get("type") == "interrupted")
    assert marker["timestamp"] <= int(long_ago) + 5, "marker dated by read time, not run time"
    assert session.compact()["last_message_at"] <= int(long_ago) + 5


def test_arrival_decision_uses_the_captured_snapshot(monkeypatch):
    """An empty captured snapshot must fail closed and keep the stream id.

    `_journal_is_still_arriving()` takes its own fresh view of the file. If the
    journal becomes visible between that call and the captured snapshot's checks,
    it reports "settled" while everything else still sees the empty snapshot —
    and the stream id, the only key back to the journal, is dropped without the
    output ever being replayed.
    """
    session_id = "hweb13_arrival"
    stream_id = "hweb13_stream_arrival"
    session = _dead_session(session_id, stream_id)

    # The captured snapshot is empty, but the journal lands (with a terminal
    # event) before the arrival check runs — so a fresh view says "settled".
    def _settled_now(_session, _stream_id):
        return False

    monkeypatch.setattr(models, "_journal_is_still_arriving", _settled_now)

    assert _recover_dead_run_journal(session, stream_id) is True
    marker = session.messages[-1]
    assert marker["_pending_journal_recovery"] is True
    assert marker["_journal_retry_stream_id"] == stream_id

    # The retry still reaches the output that arrived late.
    append_run_event(session_id, stream_id, "interim_assistant", {"text": "Arrived late."})
    append_run_event(session_id, stream_id, "done", {})
    assert models._retry_journal_recovery_in_place(session) is True
    assert _visible(session) == ["Arrived late."]
