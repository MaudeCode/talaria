from pathlib import Path

from api.streaming import _compact_for_echo_compare


def test_streaming_initializes_one_run_journal_writer_per_stream():
    src = Path("api/streaming.py").read_text(encoding="utf-8")
    register_idx = src.index("register_active_run(")
    writer_idx = src.index("RunJournalWriter(session_id, stream_id)", register_idx)
    cancel_idx = src.index("cancel_event = threading.Event()", writer_idx)

    assert "from api.run_journal import RunJournalWriter" in src
    assert register_idx < writer_idx < cancel_idx


def test_streaming_journals_sse_events_before_queue_delivery():
    src = Path("api/streaming.py").read_text(encoding="utf-8")
    put_idx = src.index("def put(event, data):")
    journal_idx = src.index("run_journal.append_sse_event(event, data)", put_idx)
    queue_idx = src.index("q.put_nowait(queue_item)", put_idx)
    block = src[put_idx:queue_idx]

    assert put_idx < journal_idx < queue_idx
    assert "Run journal degraded" in block
    assert "queue_item = (event, data, event_id) if event_id and hasattr(q, \"subscribe_with_snapshot\") else (event, data)" in block


def test_journal_writer_flushes_before_successful_append_returns():
    src = Path("api/run_journal.py").read_text(encoding="utf-8")
    writer_idx = src.index("class RunJournalWriter:")
    append_idx = src.index("def append_sse_event", writer_idx)
    flush_idx = src.index("self._fh.flush()", append_idx)
    return_idx = src.index("return event", flush_idx)

    assert append_idx < flush_idx < return_idx


def test_journal_append_failure_delivers_without_false_cursor_for_both_backends():
    cases = (
        (Path("api/streaming.py"), "def put(event, data):", "Run journal degraded"),
        (Path("api/gateway_chat.py"), "def put_gateway_event(event, data):", "Gateway run journal degraded"),
    )
    for path, marker, warning in cases:
        src = path.read_text(encoding="utf-8")
        put_idx = src.index(marker)
        queue_idx = src.index("q.put_nowait(queue_item)", put_idx)
        block = src[put_idx:queue_idx]
        assert block.index("event_id = None") < block.index("append_sse_event")
        assert warning in block
        assert "delivering live event without replay cursor" in block
        assert "queue_item = (event, data, event_id) if event_id" in block
        # The append exception path deliberately falls through to queueing; it
        # cannot return early and cannot synthesize a replay cursor.
        failure_idx = block.index("except Exception:", block.index("append_sse_event"))
        assert "return" not in block[failure_idx:]


def test_sse_contract_documents_best_effort_journal_degradation():
    contract = Path("docs/rfcs/session-sse-contract-v1.md").read_text(encoding="utf-8")
    assert "explicit availability exception" in contract
    assert "frame has no `event_id`" in contract
    assert "not claimed as replayable" in contract



def test_streaming_compacts_all_successful_agent_result_writebacks():
    src = Path("api/streaming.py").read_text(encoding="utf-8")
    run_src = src[src.index("def _run_agent_streaming("):]
    settle_src = src[src.index("def _settle_result_messages("):]
    settle_src = settle_src[: settle_src.index("\n\ndef _current_turn_already_has_visible_assistant_answer(")]

    # Normal completion plus both credential self-heal retry-success paths now
    # route through one shared settlement helper, which owns the compaction.
    assert "def _settle_result_messages(" in src
    assert "_compact_session_image_parts_for_persistence(session)" in settle_src
    assert run_src.count("_settle_result_messages(") == 3


def test_visible_process_echo_compare_ignores_all_whitespace():
    token_text = "先把 issue 4249 拉下来\n\n先看正文和评论"
    interim_text = "先把 issue 4249 拉下来先看正文和评论"

    assert _compact_for_echo_compare(token_text) == _compact_for_echo_compare(interim_text)
