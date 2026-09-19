"""Clarify prompt state for the WebUI.

This mirrors the approval flow structure, but the response is a free-form
clarification string instead of an approval decision.
"""

from __future__ import annotations

import json
import queue
import itertools
import threading
import time
import uuid
import weakref
from typing import Optional

from api.session_events import publish_session_list_changed


DEFAULT_TIMEOUT_SECONDS = 120

# Mirrors ``tools/clarify_tool.py``: at most five independent questions per
# batch and at most four choices per question. The agent validates both before
# it ever reaches the callback, so a payload that breaks either limit means a
# mismatched build rather than a normal call.
MAX_QUESTIONS = 5
MAX_CHOICES = 4
_lock = threading.Lock()
_pending: dict[str, dict] = {}
_gateway_queues: dict[str, list] = {}
_gateway_notify_cbs: dict[str, object] = {}

# ── SSE subscriber registry ─────────────────────────────────────────────
_clarify_sse_subscribers: dict[str, list[queue.Queue]] = {}
_clarify_sse_sequence: dict[str, int] = {}
_clarify_sse_dispatched: dict[str, int] = {}
_clarify_sse_sequence_source = itertools.count(1)
_clarify_sse_dispatch_locks = weakref.WeakValueDictionary()
_clarify_sse_dispatch_locks_lock = threading.Lock()


def _clarify_sse_dispatch_lock(session_id: str):
    with _clarify_sse_dispatch_locks_lock:
        lock = _clarify_sse_dispatch_locks.get(session_id)
        if lock is None:
            lock = threading.RLock()
            _clarify_sse_dispatch_locks[session_id] = lock
        return lock


def _cleanup_clarify_sse_sequence_locked(session_id: str) -> None:
    if (
        _gateway_notify_cbs.get(session_id) is None
        and not _gateway_queues.get(session_id)
        and not _clarify_sse_subscribers.get(session_id)
    ):
        _clarify_sse_sequence.pop(session_id, None)
        _clarify_sse_dispatched.pop(session_id, None)


class _ClarifyEntry:
    """One pending clarify request inside a session."""

    __slots__ = ("event", "data", "result", "clarify_id")

    def __init__(self, data: dict):
        self.event = threading.Event()
        self.data = data
        self.result: Optional[str] = None
        self.clarify_id: str = data.get("clarify_id", "") or uuid.uuid4().hex[:12]


def register_gateway_notify(session_key: str, cb) -> None:
    """Register a per-session callback for sending clarify requests to the UI."""
    with _clarify_sse_dispatch_lock(session_key):
        with _lock:
            _gateway_notify_cbs[session_key] = cb


def _clear_queue_locked(session_key: str) -> list[_ClarifyEntry]:
    entries = _gateway_queues.pop(session_key, [])
    _pending.pop(session_key, None)
    return entries


def unregister_gateway_notify(session_key: str) -> None:
    """Unregister the per-session callback and unblock any waiting clarify prompt."""
    with _clarify_sse_dispatch_lock(session_key):
        with _lock:
            _gateway_notify_cbs.pop(session_key, None)
            entries = _clear_queue_locked(session_key)
            notification = _clarify_sse_snapshot_locked(session_key, None, 0)
        _dispatch_clarify_sse(notification)
        with _lock:
            _cleanup_clarify_sse_sequence_locked(session_key)
    if entries:
        publish_session_list_changed("attention_cleared")
    for entry in entries:
        entry.event.set()


def clear_pending(session_key: str) -> int:
    """Clear any pending clarify prompts for the session without removing the callback.

    Emits an SSE notify (``pending=None, total=0``) so any browser subscribed to
    the clarify stream takes down its visible card and unlocks the composer.
    Without this notify, the silent-timeout path in
    ``streaming.py::_clarify_callback_impl`` cleared server state but left the
    browser with a stuck card and a locked composer that 409'd on any submit
    (#4504).
    """
    with _lock:
        entries = _clear_queue_locked(session_key)
        notification = _clarify_sse_snapshot_locked(session_key, None, 0)
    _dispatch_clarify_sse(notification)
    if entries:
        publish_session_list_changed("attention_cleared")
    for entry in entries:
        entry.event.set()
    return len(entries)


def _choice_text(choice) -> str:
    """Coerce one offered choice into its display string.

    Same unwrap order as the agent's ``_flatten_choice``: LLMs sometimes emit
    dict-shaped choices, and ``str(dict)`` would leak a Python repr into the
    card and back into the answer.
    """
    if isinstance(choice, str):
        return choice.strip()
    if isinstance(choice, dict):
        for key in ("label", "description", "text", "title"):
            value = choice.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""
    if choice is None:
        return ""
    return str(choice).strip()


def _normalized_choices(raw) -> list[str] | None:
    if not isinstance(raw, list):
        return None
    choices = [text for text in (_choice_text(c) for c in raw) if text]
    return choices[:MAX_CHOICES] or None


def normalize_questions(questions) -> list[dict] | None:
    """Normalize a batch ``questions`` payload into renderable entries.

    Returns ``None`` when there is no batch to render, which sends the caller
    back to the single-question path:

    - a non-list, or an empty list — the agent's ``_normalize_questions``
      returns ``(None, None)`` for an empty array and falls through the same
      way, so an empty batch is not an error;
    - more than :data:`MAX_QUESTIONS` items — the agent rejects that batch
      outright before any surface sees it, so rendering a form it would refuse
      is worse than not rendering one.

    Otherwise every item yields exactly one entry. An item we cannot read a
    question out of is surfaced as its raw JSON instead of being dropped: a
    visibly odd question is recoverable, a silently missing one blocks the run.
    """
    if not isinstance(questions, list) or not questions:
        return None
    if len(questions) > MAX_QUESTIONS:
        return None

    normalized = []
    for index, item in enumerate(questions):
        if isinstance(item, str):
            # LLMs send ["Q1?", "Q2?"]; the agent tolerates it, so do we.
            item = {"question": item}
        if not isinstance(item, dict):
            item = {"question": json.dumps(item, ensure_ascii=False, default=str)}
        text = str(item.get("question") or "").strip()
        if not text:
            text = json.dumps(item, ensure_ascii=False, default=str)
        offered = _normalized_choices(item.get("choices_offered"))
        choices = _normalized_choices(item.get("choices")) or offered
        normalized.append({
            # The wire id the answers are keyed by. A model-supplied ``id`` is
            # unvalidated text and is only echoed back in the result JSON.
            "qid": str(item.get("qid") or "").strip() or f"q{index}",
            "id": str(item.get("id") or "").strip() or None,
            "question": text,
            "choices": choices,
            "choices_offered": offered or choices,
            "multi_select": bool(item.get("multi_select")) and bool(choices),
        })
    return normalized


def _dedupe_identity(data: dict):
    """Identity used to collapse a repeated unresolved clarify prompt.

    A batch is identified by its whole question set: two batches that differ in
    any single question are different prompts, and answering one would leave
    the other unanswered. ``multi_select`` is part of that identity — the same
    question asked single- and multi-select expects a scalar in one case and an
    array in the other, so one answer cannot stand in for both. The
    single-question identity is unchanged, and the two shapes can never compare
    equal.
    """
    questions = data.get("questions")
    if questions:
        return tuple(
            (
                str(q.get("qid") or ""),
                str(q.get("question") or ""),
                tuple(str(c) for c in (q.get("choices") or [])),
                bool(q.get("multi_select")),
            )
            for q in questions
        )
    return (
        str(data.get("question", "")),
        tuple(str(c) for c in (data.get("choices_offered") or [])),
    )


def _with_timeout_metadata(data: dict) -> dict:
    item = dict(data or {})
    requested_at = float(item.get("requested_at") or time.time())
    raw_timeout = item.get("timeout_seconds")
    timeout_seconds = int(raw_timeout) if raw_timeout is not None else DEFAULT_TIMEOUT_SECONDS
    item["requested_at"] = requested_at
    item["timeout_seconds"] = timeout_seconds
    if timeout_seconds <= 0:
        # Unlimited: no expiry. The frontend renders no countdown and the card
        # waits until the user answers (or the run is cancelled).
        item["expires_at"] = 0
        return item
    item["expires_at"] = float(item.get("expires_at") or requested_at + timeout_seconds)
    return item


def _callback_head_payload_locked(queue_entries) -> dict:
    """Payload for the live gateway callback when a queue head becomes current.

    Every head emission carries the queue depth, matching what the SSE snapshot
    beside it and ``streaming.py::_approval_notify_cb`` already do. The browser
    otherwise learns its queue position only from the slower
    ``/api/clarify/pending`` poll, so the "1 of N pending" counter is missing on
    arrival and blinks out again on every queue advance.
    """
    return {**dict(queue_entries[0].data), "pending_count": len(queue_entries)}


def _clarify_sse_snapshot_locked(session_id: str, head: dict | None, total: int):
    payload = {"pending": dict(head) if head else None, "pending_count": total}
    sequence = next(_clarify_sse_sequence_source)
    _clarify_sse_sequence[session_id] = sequence
    return session_id, sequence, tuple(_clarify_sse_subscribers.get(session_id, ())), payload


def _dispatch_clarify_sse(notification, callback=None, callback_payload=None) -> bool:
    session_id, sequence, subscribers, payload = notification
    with _clarify_sse_dispatch_lock(session_id):
        with _lock:
            if sequence != _clarify_sse_sequence.get(session_id):
                return False
        if sequence <= _clarify_sse_dispatched.get(session_id, 0):
            return False
        _clarify_sse_dispatched[session_id] = sequence
        for q in subscribers:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass  # drop if subscriber is slow
        if callback is not None:
            try:
                callback(dict(callback_payload or {}))
            except Exception:
                pass
        with _lock:
            _cleanup_clarify_sse_sequence_locked(session_id)
        return True


def _clarify_sse_notify(session_id: str, head: dict | None, total: int) -> None:
    """Push a clarify event without holding the state lock."""
    with _lock:
        notification = _clarify_sse_snapshot_locked(session_id, head, total)
    _dispatch_clarify_sse(notification)


def sse_subscribe(session_id: str) -> queue.Queue:
    """Register a bounded Queue for SSE push to a given session."""
    q: queue.Queue = queue.Queue(maxsize=16)
    with _lock:
        _clarify_sse_subscribers.setdefault(session_id, []).append(q)
    return q


def sse_unsubscribe(session_id: str, q: queue.Queue) -> None:
    """Remove a subscriber Queue; clean up empty session entries."""
    with _lock:
        subs = _clarify_sse_subscribers.get(session_id)
        if subs:
            try:
                subs.remove(q)
            except ValueError:
                pass
            if not subs:
                _clarify_sse_subscribers.pop(session_id, None)
            _cleanup_clarify_sse_sequence_locked(session_id)


def submit_pending(session_key: str, data: dict) -> _ClarifyEntry:
    """Queue a pending clarify request and notify the UI callback if registered."""
    data = _with_timeout_metadata(data)
    with _lock:
        gw_queue = _gateway_queues.setdefault(session_key, [])
        # De-duplicate while unresolved: if the most recent pending clarify is
        # semantically identical, reuse it instead of stacking duplicates.
        if gw_queue:
            last = gw_queue[-1]
            if _dedupe_identity(last.data) == _dedupe_identity(data):
                entry = last
                # Dedup re-uses the existing entry with its original clarify_id.
                # If a future caller pre-populates clarify_id in data, it is
                # silently discarded here — the original entry's id wins.
                # Today no caller sets clarify_id (it's generated by __init__),
                # so this is a non-issue.
                # Keep _pending aligned to the oldest unresolved entry.
                _pending[session_key] = gw_queue[0].data
            else:
                entry = _ClarifyEntry(data)
                entry.data["clarify_id"] = entry.clarify_id
                gw_queue.append(entry)
                _pending[session_key] = gw_queue[0].data
        else:
            entry = _ClarifyEntry(data)
            entry.data["clarify_id"] = entry.clarify_id
            gw_queue.append(entry)
            _pending[session_key] = gw_queue[0].data
        cb = _gateway_notify_cbs.get(session_key)
        callback_payload = _callback_head_payload_locked(gw_queue)
        notification = _clarify_sse_snapshot_locked(
            session_key, dict(gw_queue[0].data), len(gw_queue)
        )
    _dispatch_clarify_sse(notification, cb, callback_payload)
    publish_session_list_changed("attention_pending")
    return entry


def get_pending(session_key: str) -> dict | None:
    """Return the oldest pending clarify request for this session, if any."""
    with _lock:
        queue = _gateway_queues.get(session_key) or []
        if queue:
            return dict(queue[0].data)
        pending = _pending.get(session_key)
        return dict(pending) if pending else None


def get_pending_with_count(session_key: str) -> tuple[dict | None, int]:
    """Return the oldest unresolved prompt and how many are queued behind it.

    One read under one lock: the browser renders "1 of N pending" from both
    values, and taking them from two separate ``_lock`` acquisitions could pair
    a head with a depth from a different moment.
    """
    with _lock:
        queue = _gateway_queues.get(session_key) or []
        if queue:
            return dict(queue[0].data), len(queue)
        pending = _pending.get(session_key)
        return (dict(pending), 1) if pending else (None, 0)


def has_pending(session_key: str) -> bool:
    with _lock:
        return bool(_gateway_queues.get(session_key))


def pending_session_keys() -> set[str]:
    """Return every session id that could carry clarify state right now.

    The sidebar needs this so ``/api/sessions`` can reconcile attention for the
    handful of sessions that actually have a prompt outstanding instead of
    taking ``_lock`` once per session row.
    """
    with _lock:
        return set(_pending) | set(_gateway_queues)


def pending_count(session_key: str) -> int:
    """Return the number of unresolved clarify prompts for a session."""
    with _lock:
        queue = _gateway_queues.get(session_key) or []
        if queue:
            return len(queue)
        return 1 if _pending.get(session_key) else 0


def resolve_clarify(session_key: str, response: str, resolve_all: bool = False) -> int:
    """Resolve the oldest pending clarify request for a session."""
    with _lock:
        q = _gateway_queues.get(session_key)
        if not q:
            _pending.pop(session_key, None)
            return 0
        entries = list(q) if resolve_all else [q.pop(0)]
        if q:
            _pending[session_key] = q[0].data
            cb = _gateway_notify_cbs.get(session_key)
            callback_payload = _callback_head_payload_locked(q)
            notification = _clarify_sse_snapshot_locked(
                session_key, dict(q[0].data), len(q)
            )
        else:
            cb = None
            callback_payload = None
            _clear_queue_locked(session_key)
            notification = _clarify_sse_snapshot_locked(session_key, None, 0)
    _dispatch_clarify_sse(notification, cb, callback_payload)
    publish_session_list_changed("attention_resolved")
    count = 0
    for entry in entries:
        entry.result = response
        entry.event.set()
        count += 1
    return count


def resolve_clarify_by_id(session_key: str, clarify_id: str, response: str) -> bool:
    """Resolve a specific pending clarify request by its stable id.

    Returns True if the id was found and resolved, False otherwise.
    """
    with _lock:
        q = _gateway_queues.get(session_key)
        if not q:
            _pending.pop(session_key, None)
            return False
        match = next(
            ((i, entry) for i, entry in enumerate(q) if entry.clarify_id == clarify_id),
            None,
        )
        if match is None:
            return False
        index, entry = match
        q.pop(index)
        if q:
            _pending[session_key] = q[0].data
            cb = _gateway_notify_cbs.get(session_key) if index == 0 else None
            callback_payload = _callback_head_payload_locked(q) if cb is not None else None
            notification = _clarify_sse_snapshot_locked(
                session_key, dict(q[0].data), len(q)
            )
        else:
            cb = None
            callback_payload = None
            _clear_queue_locked(session_key)
            notification = _clarify_sse_snapshot_locked(session_key, None, 0)
    _dispatch_clarify_sse(notification, cb, callback_payload)
    publish_session_list_changed("attention_resolved")
    entry.result = response
    entry.event.set()
    return True
