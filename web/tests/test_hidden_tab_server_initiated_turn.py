"""Hidden-tab server-initiated turn render (self-wake / cron / restart).

A turn started SERVER-SIDE (self-wake, cron, restart hook) fans a
``server_turn_started`` frame onto the per-session live-view SSE channel so an
open tab renders it without a manual refresh. But while a tab is HIDDEN the
WebUI deliberately does NOT hold that persistent SSE open (connection-pool
budget — see issue #3992 / #4151). So a hidden tab missed server-initiated
turns and only reconciled on the next user interaction.

This bridges the gap with a lightweight poll of ``/api/session/status`` (one
short GET per tick, NOT a held connection) that attaches the existing live
renderer when it sees a *live* ``active_stream_id``. These are source-lock
tests pinning the contract:

- backend ``session_status`` exposes ``active_stream_id``, but only when the
  stream is genuinely live (present in STREAMS / ACTIVE_RUNS) — a stale id left
  over from a crashed/restarted run must surface as ``None`` so the poller never
  attaches a renderer to a dead stream;
- frontend declares the poll lifecycle (start/stop/attach) and starts it on
  BOTH hidden-tab paths: a session opened while already hidden, AND a visible
  tab that transitions to hidden via the ``visibilitychange`` hook.
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SESSION_OPS = (REPO_ROOT / "api" / "session_ops.py").read_text(encoding="utf-8")


# ── Backend: session_status exposes a LIVE-validated active_stream_id ───────

def test_session_status_exposes_active_stream_id_field():
    """session_status() must return an active_stream_id key for the poller."""
    assert "'active_stream_id'" in SESSION_OPS
    # It is derived through the live-validation helper, not the raw attribute,
    # so a stale id from a crashed/restarted run is not surfaced.
    assert "_live_active_stream_id(" in SESSION_OPS


def test_live_active_stream_id_is_stale_safe():
    """The helper only returns an id that is actually live in STREAMS/ACTIVE_RUNS.

    Exercises the real helper: a made-up id (not in either registry) must come
    back as None; an id present in STREAMS or ACTIVE_RUNS must be returned.
    """
    import sys
    sys.path.insert(0, str(REPO_ROOT))
    from types import SimpleNamespace
    from api import config as cfg
    from api.session_ops import _live_active_stream_id

    assert _live_active_stream_id(SimpleNamespace(active_stream_id=None)) is None
    assert _live_active_stream_id(SimpleNamespace(active_stream_id="ghost-not-in-any-registry")) is None

    with cfg.STREAMS_LOCK:
        cfg.STREAMS["live-streams-id"] = object()
    try:
        assert _live_active_stream_id(SimpleNamespace(active_stream_id="live-streams-id")) == "live-streams-id"
    finally:
        with cfg.STREAMS_LOCK:
            cfg.STREAMS.pop("live-streams-id", None)

    with cfg.ACTIVE_RUNS_LOCK:
        cfg.ACTIVE_RUNS["live-runs-id"] = object()
    try:
        assert _live_active_stream_id(SimpleNamespace(active_stream_id="live-runs-id")) == "live-runs-id"
    finally:
        with cfg.ACTIVE_RUNS_LOCK:
            cfg.ACTIVE_RUNS.pop("live-runs-id", None)


# ── Frontend: poll lifecycle declared ──────────────────────────────────────

# ── Multi-pane: attach returns bool; poll only stops on a real attach ──────
