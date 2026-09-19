"""Regression: run-journal recovery must feed the next model turn.

A WebUI restart can interrupt an in-flight turn after visible assistant progress
has already streamed to the browser and run journal. Recovery restores that text
to the visible transcript (`session.messages`). It must also restore it to the
model-facing history (`session.context_messages`), otherwise the next user turn
sees a stale pre-restart context and the agent "forgets" the recovered work.
"""
from __future__ import annotations

import pytest

import api.profiles as profiles
from api.models import (
    Session,
    _append_journaled_partial_output,
    _append_recovered_pending_turn,
    _append_recovered_turn_to_context,
)
from api.run_journal import append_run_event
from api.streaming import _context_messages_for_new_turn


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes_home"
    home.mkdir()
    (home / "sessions").mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", home)
    return home


def test_recovered_journal_text_is_in_next_turn_context(hermes_home):
    sid = "recovered_context_repro"
    stream_id = "stream-upgrade"
    append_run_event(
        sid,
        stream_id,
        "interim_assistant",
        {"text": "升级代码层面已经完成并通过关键校验：现在本地是 v0.51.554-1-gd9bd39c0。"},
    )
    append_run_event(
        sid,
        stream_id,
        "interim_assistant",
        {"text": "重启条件满足：现在触发延迟重启脚本。"},
    )

    session = Session(
        session_id=sid,
        title="repro",
        messages=[
            {"role": "user", "content": "查一下上游有没有修复"},
            {"role": "assistant", "content": "上游已合并 v0.51.554，但本地还未升级。"},
        ],
        context_messages=[
            {"role": "user", "content": "查一下上游有没有修复"},
            {"role": "assistant", "content": "上游已合并 v0.51.554，但本地还未升级。"},
        ],
        pending_user_message="帮我升级",
    )

    _append_recovered_pending_turn(session, timestamp=123)
    assert _append_journaled_partial_output(session, stream_id, dedupe_existing=True) is True

    visible_text = "\n".join(m.get("content", "") for m in session.messages)
    assert "v0.51.554-1-gd9bd39c0" in visible_text

    next_context = _context_messages_for_new_turn(session, "升级完成了吗？")
    context_text = "\n".join(m.get("content", "") for m in next_context)

    assert "帮我升级" in context_text
    assert "v0.51.554-1-gd9bd39c0" in context_text
    assert "重启条件满足" in context_text


def test_deduped_existing_recovered_assistant_repairs_missing_context(hermes_home):
    """If visible recovery already happened but context was missing, rerunning
    recovery with dedupe_existing=True should backfill context instead of
    deciding the existing visible row is enough.
    """
    sid = "recovered_context_dedupe"
    stream_id = "stream-upgrade"
    append_run_event(
        sid,
        stream_id,
        "token",
        {"text": "升级代码层面已经完成并通过关键校验。"},
    )

    recovered_assistant = {
        "role": "assistant",
        "content": "升级代码层面已经完成并通过关键校验。",
        "_recovered_from_run_journal": True,
        "_recovered_stream_id": stream_id,
    }
    session = Session(
        session_id=sid,
        title="repro",
        messages=[
            {"role": "user", "content": "帮我升级", "_recovered": True},
            recovered_assistant,
        ],
        context_messages=[
            {"role": "user", "content": "帮我升级", "_recovered": True},
        ],
    )

    assert _append_journaled_partial_output(session, stream_id, dedupe_existing=True) is False

    next_context = _context_messages_for_new_turn(session, "升级完成了吗？")
    context_text = "\n".join(m.get("content", "") for m in next_context)
    assert "升级代码层面已经完成" in context_text


def test_repeated_reply_recovers_into_context_once(hermes_home):
    """HWEB-78: a dead run that repeats an earlier assistant reply must still
    land in ``context_messages`` (the visible transcript already gets the row),
    and repeated recovery must not duplicate it in either list.
    """
    sid = "recovered_context_repeat"
    stream_id = "stream-repeat"
    append_run_event(sid, stream_id, "token", {"text": "Nothing to upgrade."})

    history = [
        {"role": "user", "content": "upgrade?"},
        {"role": "assistant", "content": "Nothing to upgrade."},
    ]
    session = Session(
        session_id=sid,
        title="repro",
        messages=[dict(m) for m in history],
        context_messages=[dict(m) for m in history],
        pending_user_message="upgrade again?",
    )

    _append_recovered_pending_turn(session, timestamp=123)
    assert _append_journaled_partial_output(session, stream_id) is True

    def assistants(rows):
        return [m for m in rows if m.get("role") == "assistant"]

    assert len(assistants(session.messages)) == 2
    assert len(assistants(session.context_messages)) == 2
    assert session.context_messages[-1]["role"] == "assistant"
    assert session.context_messages[-1]["_recovered_stream_id"] == stream_id

    # Read-side retry replays the same journal against the already-repaired session.
    assert _append_journaled_partial_output(session, stream_id, dedupe_existing=True) is False
    assert len(assistants(session.messages)) == 2
    assert len(assistants(session.context_messages)) == 2


def test_untagged_recovered_assistant_context_row_still_deduplicates():
    """A recovered row without a stream identity keeps the content dedupe."""
    session = Session(
        session_id="ctx_untagged",
        title="repro",
        messages=[],
        context_messages=[{"role": "assistant", "content": "Same answer"}],
    )
    _append_recovered_turn_to_context(
        session, {"role": "assistant", "content": "Same answer", "timestamp": 1},
    )
    assert len(session.context_messages) == 1


def test_repeated_text_within_one_stream_keeps_every_context_row(hermes_home):
    """A run that emits the same progress line twice keeps both rows in
    ``context_messages``, matching the visible transcript."""
    sid = "recovered_context_repeat_in_stream"
    stream_id = "stream-repeat-in-stream"
    for _ in range(2):
        append_run_event(sid, stream_id, "interim_assistant", {"text": "Checking again."})

    session = Session(
        session_id=sid,
        title="repro",
        messages=[{"role": "user", "content": "check"}],
        context_messages=[{"role": "user", "content": "check"}],
    )

    def assistants(rows):
        return [m["content"] for m in rows if m.get("role") == "assistant"]

    assert _append_journaled_partial_output(session, stream_id) is True
    assert assistants(session.messages) == ["Checking again."] * 2
    assert assistants(session.context_messages) == ["Checking again."] * 2

    assert _append_journaled_partial_output(session, stream_id, dedupe_existing=True) is False
    assert assistants(session.messages) == ["Checking again."] * 2
    assert assistants(session.context_messages) == ["Checking again."] * 2


def test_dedupe_pass_backfills_context_from_its_own_stream_row(hermes_home):
    """A retry for stream B must not claim stream A's identical row: B's own
    visible row is what the context lacks, and repeated retries must not grow
    ``context_messages`` with copies tagged for A."""
    sid = "recovered_context_cross_stream"
    append_run_event(sid, "stream-b", "token", {"text": "Still checking."})

    row_a = {
        "role": "assistant", "content": "Still checking.",
        "_recovered_from_run_journal": True, "_recovered_stream_id": "stream-a",
    }
    row_b = {
        "role": "assistant", "content": "Still checking.",
        "_recovered_from_run_journal": True, "_recovered_stream_id": "stream-b",
    }
    session = Session(
        session_id=sid,
        title="repro",
        messages=[
            {"role": "user", "content": "check", "_recovered": True},
            dict(row_a),
            {"role": "user", "content": "check again", "_recovered": True},
            dict(row_b),
        ],
        # Pre-HWEB-78 state: B's row was content-deduped out of the context.
        context_messages=[
            {"role": "user", "content": "check", "_recovered": True},
            dict(row_a),
            {"role": "user", "content": "check again", "_recovered": True},
        ],
    )

    for _ in range(2):
        assert _append_journaled_partial_output(session, "stream-b", dedupe_existing=True) is False
        streams = [m.get("_recovered_stream_id") for m in session.context_messages if m.get("role") == "assistant"]
        assert streams == ["stream-a", "stream-b"]


def test_dedupe_pass_prefers_its_own_stream_row_over_untagged_history(hermes_home):
    """An older untagged reply with the same text must not win the claim over
    the stream's own row, or the stream's context deficit is never consumed."""
    sid = "recovered_context_untagged_history"
    append_run_event(sid, "stream-b", "token", {"text": "Still checking."})

    row_b = {
        "role": "assistant", "content": "Still checking.",
        "_recovered_from_run_journal": True, "_recovered_stream_id": "stream-b",
    }
    session = Session(
        session_id=sid,
        title="repro",
        messages=[
            {"role": "user", "content": "check"},
            {"role": "assistant", "content": "Still checking."},
            {"role": "user", "content": "check again", "_recovered": True},
            dict(row_b),
        ],
        context_messages=[
            {"role": "user", "content": "check"},
            {"role": "assistant", "content": "Still checking."},
            {"role": "user", "content": "check again", "_recovered": True},
        ],
    )

    for _ in range(2):
        assert _append_journaled_partial_output(session, "stream-b", dedupe_existing=True) is False
        streams = [m.get("_recovered_stream_id") for m in session.context_messages if m.get("role") == "assistant"]
        assert streams == [None, "stream-b"]


def test_backfilled_context_row_keeps_transcript_order(hermes_home):
    """Legacy state: the old content dedupe dropped row A (a repeat of older
    text) but projected row B. The backfill must place A before B, not at
    the tail, so the model sees the transcript's order."""
    sid = "recovered_context_backfill_order"
    stream_id = "stream-s"
    append_run_event(sid, stream_id, "interim_assistant", {"text": "Still checking."})
    append_run_event(sid, stream_id, "interim_assistant", {"text": "Found it."})

    row_a = {
        "role": "assistant", "content": "Still checking.",
        "_recovered_from_run_journal": True, "_recovered_stream_id": stream_id,
    }
    row_b = {
        "role": "assistant", "content": "Found it.",
        "_recovered_from_run_journal": True, "_recovered_stream_id": stream_id,
    }
    session = Session(
        session_id=sid,
        title="repro",
        messages=[
            {"role": "user", "content": "check"},
            {"role": "assistant", "content": "Still checking."},
            {"role": "user", "content": "check again", "_recovered": True},
            dict(row_a),
            dict(row_b),
        ],
        context_messages=[
            {"role": "user", "content": "check"},
            {"role": "assistant", "content": "Still checking."},
            {"role": "user", "content": "check again", "_recovered": True},
            dict(row_b),
        ],
    )

    for _ in range(2):
        assert _append_journaled_partial_output(session, stream_id, dedupe_existing=True) is False
        assert [m["content"] for m in session.context_messages[2:]] == [
            "check again", "Still checking.", "Found it.",
        ]
