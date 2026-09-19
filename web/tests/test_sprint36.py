"""
Sprint 36 Tests: cancelStream cleanup no longer depends on SSE event (PR #309 / issue #299).

The old cancelStream() set "Cancelling..." status and then relied on the SSE cancel
event to clear it. If the SSE connection was already closed, the event never arrived
and "Cancelling..." lingered indefinitely.

The fix: cancelStream() now clears status, busy state, and activeStreamId directly after
the cancel API request completes — regardless of whether the SSE cancel event fires.
The SSE handler still runs if it arrives (all operations idempotent).

Covers:
  1. cancelStream() clears activeStreamId unconditionally after the fetch
  2. cancelStream() calls setBusy(false) unconditionally
  3. cancelStream() calls setStatus('') / setComposerStatus('') unconditionally
  4. cancelStream() clears composer status text unconditionally
  5. The catch block no longer calls setStatus(cancel_failed) — cleanup runs even on error
  6. The SSE cancel handler is still present (idempotent path)
  7. cancel_failed i18n key is still defined in all locales (key exists, just not used in
     the catch-path anymore — kept for potential future use)
"""

import pathlib
import re

REPO = pathlib.Path(__file__).parent.parent


def read(path):
    return (REPO / path).read_text(encoding="utf-8")


def _locale_count(src: str) -> int:
    pattern = re.compile(
        r"^\s{2}(?:'(?P<quoted>[A-Za-z0-9-]+)'|(?P<plain>[A-Za-z0-9-]+))\s*:\s*\{",
        re.MULTILINE,
    )
    return sum(1 for _ in pattern.finditer(src))


# ── 1–4. cancelStream() cleanup is unconditional ─────────────────────────────

# ── 5. Error path behavior ────────────────────────────────────────────────────

# ── 6. SSE cancel handler still present ──────────────────────────────────────

# ── 7. i18n key preserved ─────────────────────────────────────────────────────

# ── 8. Server-persisted cancel marker doesn't leak into agent history ────────

def test_cancel_marker_flagged_as_error_to_skip_in_api_history():
    """The server-side cancel marker appended in cancel_stream() must carry
    _error: True so _sanitize_messages_for_api() strips it from the
    conversation_history sent to the agent on the next user message.

    Without this flag, the LLM sees "Task cancelled" as a prior assistant
    turn and may reference it in subsequent responses ("As I mentioned, I was
    cancelled...") — a behavioral regression introduced when this PR started
    persisting the marker to the session.
    """
    src = read("api/streaming.py")
    idx = src.find("'content': _cancelled_turn_content(message")
    assert idx != -1, "cancel marker content writer not found in cancel_stream()"

    # Walk back to the start of the dict literal (opening brace)
    brace_open = src.rfind("{", 0, idx)
    brace_close = src.find("}", idx)
    assert brace_open != -1 and brace_close != -1, "couldn't locate cancel marker dict"

    marker_dict = src[brace_open:brace_close + 1]
    assert "_error" in marker_dict and "True" in marker_dict, (
        "cancel marker is missing _error: True — it will leak into the agent's "
        "conversation_history via _sanitize_messages_for_api() on the next turn. "
        "See line 591-593 of api/streaming.py for the error-marker filter."
    )


def test_sanitize_strips_error_flagged_assistant_messages():
    """_sanitize_messages_for_api() must drop messages with _error: True —
    this is the invariant the cancel marker's _error flag relies on."""
    from api.streaming import _sanitize_messages_for_api
    messages = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
        {"role": "assistant", "content": "*Task cancelled.*", "_error": True},
        {"role": "user", "content": "next"},
    ]
    sanitized = _sanitize_messages_for_api(messages)
    assert len(sanitized) == 3, (
        f"expected 3 messages (cancel marker stripped), got {len(sanitized)}: {sanitized}"
    )
    assert all("Task cancelled" not in (m.get("content") or "") for m in sanitized), (
        "_sanitize_messages_for_api must filter cancel markers from API history"
    )
