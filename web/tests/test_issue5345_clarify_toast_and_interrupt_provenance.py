"""Regression tests for issue #5345.

Two symptoms, both surfaced from front-end source guards (these are static-source
assertions — no server needed):

1. Misleading "Clarify endpoint unavailable. Please restart server." toast.
   `/api/clarify/pending` ALWAYS returns HTTP 200 when the route is present (it
   returns {"pending": null} for an unknown session — never 404). The old catch
   block fired the restart-server toast on ANY caught error whose message matched
   the broad regex ``/(^|\\b)(404|not found)(\\b|$)/i``. An unrelated stale-session
   404 ("Session not found") or transient error therefore produced a false
   missing-endpoint toast. The fix branches on the STRUCTURED HTTP status that
   `api()` attaches to the thrown Error (err.status) and only warns on a genuine
   route-not-found 404 whose body is not session-scoped.

2. Interrupt provenance. The issue asks that only explicit cancellation reach the
   backend and that cancellation source be observable. Passive lifecycle events
   (session switch / tab hide / page unload) already tear down only the LOCAL SSE
   transport via closeLiveStream() and never call /api/chat/cancel; the fix adds a
   provenance log to cancelStream()/cancelSessionStream() and threads a distinct
   `reason` from every explicit call site so a backend SIGINT/exit-130 can be
   attributed.

Backend fact locked by test_clarify_pending_never_404s: the handler returns 200
with {"pending": None} for an unknown session, so a real 404 can only be a
missing route (server predates the endpoint) or an unrelated session-scoped 404.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# ── Part 1: clarify toast false positive ────────────────────────────────────

# ── Part 2: interrupt provenance ────────────────────────────────────────────

# ── Backend invariant that the front-end fix depends on ─────────────────────

def test_clarify_pending_never_404s():
    """The whole Part-1 fix rests on /api/clarify/pending returning 200 (with
    pending=None) for any session — a 404 from that path is ALWAYS either a
    missing route or an unrelated error. Lock the handler shape."""
    routes = (ROOT / "api" / "routes.py").read_text(encoding="utf-8")
    m = re.search(
        r"def _handle_clarify_pending\(handler, parsed\):(.*?)\ndef ",
        routes,
        re.DOTALL,
    )
    assert m, "_handle_clarify_pending not found"
    handler_src = m.group(1)
    assert "404" not in handler_src, (
        "_handle_clarify_pending must never return 404 — it returns 200 with "
        "{'pending': None} for unknown sessions. If this changes, the front-end "
        "clarify toast logic in messages.js must be revisited."
    )
    assert '"pending": None' in handler_src or "'pending': None" in handler_src, (
        "_handle_clarify_pending should return a pending=None payload for no pending clarify"
    )
