"""Regression tests for per-turn response duration in WebUI.

The WebUI should expose how long an agent turn took, using backend timing so
reload/reconnect does not lose the measurement.
"""
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
STREAMING_PY = (REPO / "api" / "streaming.py").read_text(encoding="utf-8")
ROUTES_PY = (REPO / "api" / "routes.py").read_text(encoding="utf-8")
def test_streaming_done_payload_includes_backend_turn_duration():
    assert "duration_seconds" in STREAMING_PY, (
        "api/streaming.py should include a backend-measured duration_seconds "
        "field in the done usage payload."
    )
    assert "pending_started_at" in STREAMING_PY and "time.time()" in STREAMING_PY, (
        "Turn duration should be measured from the persisted pending_started_at "
        "start time, not only from browser-local state."
    )
    assert "recovered/legacy flows" in STREAMING_PY, (
        "The missing-start fallback should be documented so it is not mistaken "
        "for the primary timing path."
    )
    assert "_turnDuration" in STREAMING_PY, (
        "The measured duration should be persisted on the assistant message so "
        "it survives reload after the SSE stream settles."
    )
