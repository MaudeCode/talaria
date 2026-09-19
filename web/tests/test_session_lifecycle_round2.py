import json
import subprocess
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
def _run_node(source: str):
    result = subprocess.run(["node", "-e", source], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_reasoning_segment_accumulator_is_chunked_for_many_deltas():
    from api import config

    on_reasoning_start = (ROOT / "api" / "streaming.py").read_text(encoding="utf-8").index(
        "def on_reasoning(text):"
    )
    on_reasoning_end = (ROOT / "api" / "streaming.py").read_text(encoding="utf-8").index(
        "def on_interim_assistant", on_reasoning_start
    )
    on_reasoning = (ROOT / "api" / "streaming.py").read_text(encoding="utf-8")[
        on_reasoning_start:on_reasoning_end
    ]
    assert "append_stream_text_chunk(" in on_reasoning
    assert "_reasoning_segments.get(_current_reasoning_idx, '') + reasoning_delta" not in on_reasoning

    segments = {0: []}
    for _ in range(50000):
        config.append_stream_text_chunk(segments, 0, "x")

    assert isinstance(segments[0], list)
    assert len(segments[0]) == 50000
    assert config.stream_text_value(segments, 0) == "x" * 50000


def test_old_detached_cancelled_run_is_released_after_unwind_ceiling():
    """A stale detached cancel must not 409 the session forever.

    Upstream's writeback-owner generation prevents the old worker from saving
    over a successor after this bounded gate is released.
    """
    from api import config, routes

    stream_id = "aged-detached-stream"
    session_id = "aged-detached-session"
    config.register_active_run(
        stream_id,
        session_id=session_id,
        started_at=1.0,
        phase="cancelling",
        cancelled_at=1.0,
    )
    try:
        assert routes._active_run_stream_for_session(session_id) is None
        assert stream_id not in config.ACTIVE_RUNS
    finally:
        config.unregister_active_run(stream_id)


def test_failed_pending_save_does_not_register_writeback_owner(monkeypatch):
    from api import config, routes

    session_id = "save-failure-owner"
    stream_id = "save-failure-stream"
    session = SimpleNamespace(
        session_id=session_id,
        workspace="/tmp",
        model="test-model",
        model_provider="test-provider",
        active_stream_id=None,
        post_compression_context_tokens_estimate=None,
        pending_user_message=None,
        pending_attachments=[],
        pending_started_at=None,
        pending_user_source=None,
        title="Existing title",
        messages=[],
        truncation_watermark=None,
        save=lambda: (_ for _ in ()).throw(RuntimeError("save failed")),
    )
    monkeypatch.setattr(routes, "get_webui_session_save_mode", lambda: "deferred")
    config.clear_session_writeback_owner_if_owned(session_id, stream_id)

    try:
        try:
            routes._prepare_chat_start_session_for_stream(
                session,
                msg="hello",
                attachments=[],
                workspace="/tmp",
                model="test-model",
                model_provider="test-provider",
                stream_id=stream_id,
            )
        except RuntimeError as exc:
            assert str(exc) == "save failed"
        else:  # pragma: no cover - regression failure surface
            raise AssertionError("expected save failure")
        assert config.session_writeback_owner(session_id) is None
    finally:
        config.clear_session_writeback_owner_if_owned(session_id, stream_id)
