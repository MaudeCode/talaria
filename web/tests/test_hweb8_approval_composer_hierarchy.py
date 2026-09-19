"""HWEB-8: the approval strip gives primary weight only to the choices that are
valid for the request in front of the user.

`Allow once` and `Deny` answer THIS request and stay in the button row. The
policy changes that outlive it — `Allow session`, `Always allow` and YOLO —
move behind one overflow menu, so the strip reads as the next composer action
instead of five equally weighted buttons.
"""

import json
import pathlib
import re
import shutil
import subprocess
import tempfile

from urllib.parse import urlparse

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


def _element(html: str, marker: str, closing: str) -> str:
    start = html.index(marker)
    return html[start : html.index(closing, start)]


# ── Hierarchy ────────────────────────────────────────────────────────────────

# ── Behavior ─────────────────────────────────────────────────────────────────

def _run_node(script: str) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as handle:
        handle.write(script)
        path = handle.name
    result = subprocess.run([NODE, path], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# ── Queued-question progress ────────────────────────────────────────────────

@pytest.mark.parametrize("advance", ["oldest", "by_id"])
def test_live_clarify_callback_carries_the_queue_depth(advance):
    # The live path (streaming.py::_clarify_notify_cb -> SSE "clarify") forwards
    # this payload verbatim, so the count has to be on it — the poll is slower
    # and a queued question can be answered before the first poll lands. Every
    # head emission counts, not just arrival: a queue advance that drops the
    # field blanks the counter until the next poll.
    import api.clarify as clarify_mod

    sid = "hweb8-live-clarify-" + advance
    seen = []
    clarify_mod.register_gateway_notify(sid, seen.append)
    try:
        first = clarify_mod.submit_pending(sid, {"question": "first?"})
        clarify_mod.submit_pending(sid, {"question": "second?"})
        clarify_mod.submit_pending(sid, {"question": "third?"})
        if advance == "oldest":
            clarify_mod.resolve_clarify(sid, "answer")
        else:
            clarify_mod.resolve_clarify_by_id(sid, first.clarify_id, "answer")
    finally:
        clarify_mod.unregister_gateway_notify(sid)
        clarify_mod.clear_pending(sid)

    # three arrivals (head unchanged, depth growing) then the advance to "second?"
    assert [payload["pending_count"] for payload in seen] == [1, 2, 3, 2]
    assert [payload["question"] for payload in seen] == [
        "first?", "first?", "first?", "second?",
    ]


def test_clarify_pending_endpoint_returns_the_queue_depth():
    # The poll is the authoritative source after a reload or session switch, so
    # an endpoint that omits the depth would floor the counter to 1 on the first
    # tick and hide it for the rest of the queue.
    import api.clarify as clarify_mod
    from api.routes import _handle_clarify_pending

    sid = "hweb8-pending-endpoint"
    sent = {}

    class _Handler:
        pass

    def fake_j(handler, payload, status=200):
        sent.update(payload)
        return payload

    import api.routes as routes_mod
    real_j = routes_mod.j
    routes_mod.j = fake_j
    parsed = urlparse("/api/clarify/pending?session_id=" + sid)
    try:
        _handle_clarify_pending(_Handler(), parsed)
        assert sent == {"pending": None, "pending_count": 0}

        clarify_mod.submit_pending(sid, {"question": "first?"})
        clarify_mod.submit_pending(sid, {"question": "second?"})
        _handle_clarify_pending(_Handler(), parsed)
        assert sent["pending"]["question"] == "first?"
        assert sent["pending_count"] == 2

        clarify_mod.resolve_clarify(sid, "answer")
        _handle_clarify_pending(_Handler(), parsed)
        assert sent["pending"]["question"] == "second?"
        assert sent["pending_count"] == 1
    finally:
        routes_mod.j = real_j
        clarify_mod.clear_pending(sid)
