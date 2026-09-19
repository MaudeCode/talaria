"""Regression coverage for #4504 — clarify card / composer stuck after expiry.

Two compounding gaps the user experienced:

  1. Server-side ``clear_pending(sid)`` ran on silent timeout but emitted no
     SSE notify, so the browser never knew the prompt was gone (the visible
     card stayed up and the composer stayed locked).

  2. The client's ``respondClarify`` catch-block treated every 409 (including
     ``stale: true``) as retryable, leaving the card + draft visible and the
     controls re-enabled — but every retry returned 409, so the session was
     permanently stuck. The user had zero affordance to dismiss the card.

This file pins:

  - ``clear_pending`` notifies SSE subscribers (head=None, total=0) so the
    silent-timeout path takes the card down via the existing pending=null
    branch in ``_handleClarifyEvent`` if/when an SSE consumer is re-attached.
    (As of v0.51.340 the WebUI clarify transport is HTTP-poll only — the SSE
    notify is still ordering-correct and drives the sessions-list attention
    badge via the pre-existing ``publish_session_list_changed`` call.)
  - The client's ``respondClarify`` catch-block, on ``e.status === 409``:
      * matches the success path's ``_clarifyId === clarifyId`` guard so a
        late 409 for prompt A does not dismiss a rendered prompt B
        (#2639-style regression),
      * clears the loading/disabled state *before* ``hideClarifyCard`` so
        ``_stashClarifyDraft`` does not bail on the loading class (reviewer
        P1 from the first review pass — see PR #4524),
      * routes the same-id case through ``hideClarifyCard(true, 'expired')``
        so the draft is rescued into the now-unlocked composer.

The tests intentionally mirror the static-analysis + unit pattern already in
``test_clarify_sse.py`` so they ride the existing clarify suite layout.
"""

from __future__ import annotations

import os

import pytest


_CLARIFY = os.path.join(os.path.dirname(__file__), "..", "api", "clarify.py")
_MESSAGES = os.path.join(os.path.dirname(__file__), "..", "static", "messages.js")


def _read(path: str) -> str:
    with open(path) as f:
        return f.read()


# ═════════════════════════════════════════════════════════════════════════════
# 1. Server-side fix — clear_pending must emit an SSE notify so the silent
#    timeout path actually wakes the browser. (Phase A in the issue.)
# ══════════════════════════════════════════════════════════════════════════════
@pytest.fixture()
def clarify_mod():
    from api import clarify
    return clarify


@pytest.fixture(autouse=True)
def _cleanup_subscribers(clarify_mod):
    yield
    clarify_mod._clarify_sse_subscribers.clear()
    clarify_mod._gateway_queues.clear()
    clarify_mod._pending.clear()


class TestClearPendingNotifiesSSE:
    """clear_pending must push (head=None, total=0) so any SSE subscriber
    (or future SSE reattachment) gets a take-down event for the card."""

    def test_clear_pending_pushes_none_head_to_subscriber(self, clarify_mod):
        sid = "sess-4504-a"
        # Pre-load a pending clarify entry the way submit_pending does.
        entry = clarify_mod.submit_pending(sid, {"question": "y/n?"})
        assert entry is not None
        # Subscribe AFTER the submit so we don't have to drain its notify.
        sub = clarify_mod.sse_subscribe(sid)
        # Now expire it.
        cleared = clarify_mod.clear_pending(sid)
        assert cleared == 1
        # We should receive a clear push (head=None, total=0).
        msg = sub.get(timeout=1.0)
        assert msg == {"pending": None, "pending_count": 0}, (
            "clear_pending must emit a head=None / total=0 SSE notify so the "
            "silent-timeout path tells any SSE subscriber to take the card "
            "down (#4504)."
        )

    def test_clear_pending_no_op_still_supersedes_older_snapshots(self, clarify_mod):
        sid = "sess-4504-b"
        sub = clarify_mod.sse_subscribe(sid)
        cleared = clarify_mod.clear_pending(sid)
        assert cleared == 0
        assert sub.get(timeout=1.0) == {"pending": None, "pending_count": 0}

    def test_clear_pending_unblocks_caller_event(self, clarify_mod):
        """The existing event.set() on the cleared entry stays in place."""
        sid = "sess-4504-c"
        entry = clarify_mod.submit_pending(sid, {"question": "ok?"})
        assert not entry.event.is_set()
        clarify_mod.clear_pending(sid)
        assert entry.event.is_set(), (
            "Clearing must still unblock the agent-side wait() so the "
            "_clarify_callback_impl timeout branch returns its fallback string."
        )


class TestClarifyClearPendingSourceMarkers:
    """Static-analysis pin for the Phase A fix (#4504)."""

    def test_clear_pending_calls_notify(self):
        src = _read(_CLARIFY)
        assert "_clarify_sse_snapshot_locked(session_key, None, 0)" in src, (
            "clear_pending must snapshot a None head so "
            "the silent-timeout path notifies SSE subscribers (#4504)."
        )


# ══════════════════════════════════════════════════════════════════════════════
# 2. Client-side fix — respondClarify catch must treat 409 as terminal
#    *only* for the visible card, and rescue the typed draft into the
#    composer in the same-id case. (Phase B in the issue, plus reviewer P1s.)
# ══════════════════════════════════════════════════════════════════════════════
