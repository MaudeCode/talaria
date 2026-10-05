"""``chat.start`` turns the Agent's ``status_callback(kind, message)`` lines into the compressing card, fallback
warnings, and the captured terminal error. The table holds the pinned Agent's real status strings (its
``conversation_compression`` templates, ``turn_overflow``, ``turn_recovery``, ``turn_api_error``)."""

from __future__ import annotations

import pytest

from talaria_sidecar.methods.chat import _status_events

CASES = [
    # The authoritative start marker and its heartbeat; pre-API, 413, and too-large compression.
    ("lifecycle", "🗜️ Compacting context — summarizing earlier conversation so I can continue...", ["compressing"]),
    ("lifecycle", "🗜️ Compacting context — still summarizing earlier conversation so I can continue...", ["compressing"]),
    ("lifecycle", "📦 Pre-API compression: ~123,456 tokens near the context/output limit. Compacting before the next model call.", ["compressing"]),
    ("lifecycle", "🗜️ Context too large (~250,000 tokens) — compressing (1/3)...", ["compressing"]),
    ("lifecycle", "⚠️  Request payload too large (413) — compression attempt 1/3...", ["compressing"]),
    # Preflight and idle notices precede the "Compacting context" line only when compression actually proceeds.
    ("lifecycle", "📦 Preflight compression: ~120,000 tokens >= 100,000 threshold. This may take a moment.", []),
    ("lifecycle", "💤 Resumed after 3600s idle — compacting ~120,000 tokens before continuing.", []),
    # Skips never start compression.
    ("lifecycle", "Skipping Hermes preflight compression for codex app-server (mode=thread); Hermes will not start thread compaction here.", []),
    ("lifecycle", "Skipping preflight compression: same-session cooldown active", []),
    # Post-compression retry chatter is neither a start nor a provider fallback.
    ("lifecycle", "🗜️ Compressed 30 → 12 messages, retrying...", []),
    ("lifecycle", "🗜️ Compressed ~250,000 → ~120,000 tokens, retrying...", []),
    ("lifecycle", "🗜️ Compressed 1,000,000 → 500,000 payload bytes, retrying...", []),
    ("lifecycle", "🗜️ Context reduced to 120,000 tokens (was 250,000), retrying...", []),
    ("lifecycle", "📐 Compression could not reduce the request further — removed retained vision payloads and retrying...", []),
    ("lifecycle", "⚠️  Session compressed 2 times — accuracy may degrade. Consider /new to start fresh.", []),
    ("compacted", "✓ Context compaction complete — continuing turn...", []),
    # Provider retries, rate limits, and fallbacks.
    ("lifecycle", "⏱️ Rate limited. Waiting 2.0s (attempt 1/3)...", ["warning"]),
    ("lifecycle", "⏳ Retrying in 2.0s (attempt 1/3)...", ["warning"]),
    ("lifecycle", "⚠️ Max retries (3) exhausted — trying fallback...", ["warning"]),
    ("lifecycle", "⚠️ Model returning empty responses — switching to fallback provider...", ["warning"]),
    (
        "warn",
        "⚠ Context is over the compression threshold (~120,000 tokens >= 100,000) but compression is currently blocked "
        "(cooldown: 60s). The model may stop responding. Run /new to start a fresh session or /compress to retry immediately.",
        ["warning"],
    ),
    # A non-retryable provider error is the turn's terminal cause; announcing a fallback also warns.
    ("lifecycle", "⚠️ Non-retryable error (HTTP 400) — trying fallback...", ["terminal_error", "warning"]),
    ("lifecycle", "❌ Non-retryable error (HTTP 400): invalid model format or no credentials", ["terminal_error"]),
    ("lifecycle", "", []),
]


@pytest.mark.parametrize(("kind", "message", "expected"), CASES, ids=[message[:48] for _kind, message, _expected in CASES])
def test_status_events_classify_the_agents_real_status_lines(kind, message, expected):
    assert _status_events(kind, message) == expected
