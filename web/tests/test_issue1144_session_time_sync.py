"""Regression tests for issue #1144 – session time sync with system time.

Root cause: The WebUI used Date.now() (client-side clock) as the reference
for all relative-time calculations ("2 hours ago", "Today", "Yesterday", etc.).
If the server clock and client clock are out of sync (e.g. WSL clock drift,
Docker container TZ mismatch), timestamps appear wrong.

Fix: The /api/sessions response now includes ``server_time`` (epoch seconds)
and ``server_tz`` (offset string like "+0800").  The JS computes
``_serverTimeDelta = Date.now() - server_time * 1000`` once per session-list
fetch, then every time helper uses ``_serverNowMs()`` (which returns
``Date.now() - _serverTimeDelta``) instead of bare ``Date.now()``.
"""

import json
import pathlib
import subprocess
import textwrap
import time

import pytest

REPO_ROOT = pathlib.Path(__file__).parent.parent.resolve()
# ---------------------------------------------------------------------------
# Backend: /api/sessions includes server_time and server_tz
# ---------------------------------------------------------------------------

def test_sessions_endpoint_includes_server_time_and_tz():
    """GET /api/sessions must return server_time (float) and server_tz (str)."""
    from tests._pytest_port import BASE
    import urllib.request
    with urllib.request.urlopen(BASE + "/api/sessions", timeout=10) as r:
        data = json.loads(r.read())
    assert "server_time" in data
    assert "server_tz" in data
    # server_time should be a recent epoch seconds value
    assert isinstance(data["server_time"], float)
    assert data["server_time"] > 1_700_000_000  # after 2023
    # Should be close to time.time()
    assert abs(data["server_time"] - time.time()) < 5
    # server_tz should be an offset string
    assert isinstance(data["server_tz"], str)
    assert len(data["server_tz"]) == 5  # "+HHMM" or "-HHMM"


def test_server_time_allows_clock_skew_compensation():
    """server_time lets the client detect clock skew relative to the server."""
    from tests._pytest_port import BASE
    import urllib.request
    before = time.time()
    with urllib.request.urlopen(BASE + "/api/sessions", timeout=10) as r:
        data = json.loads(r.read())
    after = time.time()
    server_time = data["server_time"]
    # The server_time should be between our before and after timestamps
    assert before <= server_time <= after


# ---------------------------------------------------------------------------
# JS: _serverNowMs compensates for clock skew
# ---------------------------------------------------------------------------

def _extract_function(source: str, name: str) -> str:
    marker = f"function {name}"
    start = source.index(marker)
    brace_start = source.index("{", start)
    depth = 0
    for idx in range(brace_start, len(source)):
        ch = source[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[start : idx + 1]
    raise AssertionError(f"Could not extract {name}")


# ---------------------------------------------------------------------------
# JS: _serverTzOptions builds correct timeZone option
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# JS: _formatMessageFooterTimestamp uses server timezone
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# JS: sessions.js contains the compensation variables and helpers
# ---------------------------------------------------------------------------
