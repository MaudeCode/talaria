"""Background health checks for configured MCP servers (HWEB-62).

The WebUI already exposes read-only MCP runtime status through
``api.routes._mcp_runtime_status_by_name()``. That map only reports what the
Hermes Agent registry already knows (``connected``/``tools``), which cannot tell
"this server is down" apart from "this server's token expired" — two states that
need different user actions. This module adds that missing signal.

Design constraints, in order:

- **Never block a request.** ``refresh_and_read()`` only schedules; every probe
  runs on a short-lived daemon thread and the caller reads back whatever the
  cache already has (possibly ``unknown``).
- **No long-lived process.** Checks are demand-driven: the MCP endpoints call
  ``refresh_and_read()`` and a server is re-probed at most once per
  ``HEALTH_INTERVAL_S``.
- **A verdict names the config it measured.** Entries carry a fingerprint of the
  server config, so an edited server or a profile whose same-named server points
  elsewhere never inherits the previous server's health.
- **Bounded and non-accumulating.** A server already in flight is never
  scheduled again, so a slow server cannot pile up overlapping probes, and at
  most ``MAX_CONCURRENT_PROBES`` run process-wide; the rest wait for the next
  read and report pending meanwhile.
- **Contained failures.** One server's probe raising or timing out leaves that
  server in a known state and never touches another server's entry.

Health states: ``healthy``, ``needs_auth``, ``unhealthy``, ``unknown``.
``unknown`` means "we could not determine it" — it is never treated as healthy.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

logger = logging.getLogger(__name__)

# ponytail: demand-driven refresh (the MCP endpoints tick it) instead of a
# daemon loop, because AGENTS.md asks for no new long-lived processes. If health
# must be fresh while the MCP panel is closed, hook this into a periodic ticker.
HEALTH_INTERVAL_S: float = 120.0
PROBE_TIMEOUT_S: float = 8.0
# Process-wide cap on probes in flight: one thread and one socket each. A large
# imported config must not be able to exhaust threads or file descriptors.
MAX_CONCURRENT_PROBES: int = 4
_MAX_PROBE_BODY_BYTES = 64 * 1024

HEALTHY = "healthy"
NEEDS_AUTH = "needs_auth"
UNHEALTHY = "unhealthy"
UNKNOWN = "unknown"

# Statuses that mean "your credentials, not the server". Kept distinct from
# UNHEALTHY because re-authenticating and restarting a server are different acts.
_AUTH_STATUSES = frozenset({401, 403, 407})
# The probe speaks streamable HTTP. A server that answers but rejects this shape
# (legacy SSE transports, gateways that only route specific paths) tells us
# nothing about its health, so it stays UNKNOWN rather than being called down.
_PROTOCOL_MISMATCH_STATUSES = frozenset({404, 405, 406, 415})

# MCP protocol versions are dated revisions ("2025-06-18"). A version that is
# not even that shape did not come out of a real negotiation.
_PROTOCOL_VERSION = re.compile(r"\d{4}-\d{2}-\d{2}")
# SSE permits CR, LF or CRLF line endings; an event ends at a blank line.
_SSE_EVENT_BOUNDARY = re.compile(r"(?:\r\n|\r|\n){2}")

_INITIALIZE_REQUEST = {
    "jsonrpc": "2.0",
    "id": "hermes-webui-health",
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "hermes-webui-health", "version": "1"},
    },
}

_LOCK = threading.Lock()
# Both maps are keyed by (name, config fingerprint): one server identity, not
# one name. Two profiles' same-named servers each keep their own verdict and
# their own interval slot.
# (name, fingerprint) -> {"health": str, "detail": str, "checked_at": float}
_STATE: dict[tuple[str, str], dict] = {}
# (name, fingerprint) currently being probed. One probe per identity at a time
# stops a slow server from accumulating overlapping checks; a sibling profile's
# same-named server is a different identity and is not held up behind it.
_IN_FLIGHT: set[tuple[str, str]] = set()
# (name, fingerprint) -> monotonic timestamp of the last *started* probe.
# Started, not finished, so a slow probe still holds its slot in the budget.
_STARTED_AT: dict[tuple[str, str], float] = {}


class _NoRedirect(urllib_request.HTTPRedirectHandler):
    """Refuse redirects so a probe never forwards ``Authorization`` to a new host.

    ``urllib`` copies the original request headers onto the redirected request,
    so following a redirect out of a config-supplied URL would hand the server's
    bearer token to whatever host the redirect names. Returning ``None`` makes
    urllib surface the 3xx as an ``HTTPError`` instead, which we report as
    ``unknown`` — we did not learn whether the server is healthy.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib_request.build_opener(_NoRedirect())


def _urlopen(request, timeout: float = PROBE_TIMEOUT_S):
    return _OPENER.open(request, timeout=max(0.001, timeout))


def _jsonrpc_from_body(raw: bytes) -> dict | None:
    """Pull *our* ``initialize`` reply out of a response body.

    Streamable HTTP answers with a bare JSON object; the SSE form wraps the same
    object in a ``data:`` line. Only the envelope answering this probe's request
    id counts — a catch-all that echoes some other JSON-RPC message, or a stream
    carrying unrelated notifications, is not an answer. Anything else — an HTML
    login page, a reverse proxy's catch-all, an empty 200 — yields ``None``.
    """
    text = raw.decode("utf-8", "replace").strip()
    if not text:
        return None
    candidates = [text]
    # SSE: an event is the block up to a blank line, and its payload is every
    # ``data:`` line in that block joined with newlines — a pretty-printed
    # reply legitimately spans several of them.
    for event in _SSE_EVENT_BOUNDARY.split(text):
        data_lines = [
            line[5:].removeprefix(" ")
            for line in event.splitlines()
            if line.startswith("data:")
        ]
        if data_lines:
            candidates.append("\n".join(data_lines).strip())
    for candidate in candidates:
        if not candidate.startswith("{"):
            continue
        try:
            payload = json.loads(candidate)
        except ValueError:
            continue
        if (isinstance(payload, dict) and payload.get("jsonrpc") == "2.0"
                and payload.get("id") == _INITIALIZE_REQUEST["id"]):
            return payload
    return None


def _socket_of(response):
    """Find the socket under an ``http.client`` response, or ``None``.

    ``HTTPResponse.fp`` is a ``BufferedReader`` over ``SocketIO``, whose
    ``_sock`` is the connection. Private, but stable across 3.11–3.13; when the
    shape differs (tests, other openers) the outer deadline check still bounds
    the probe to at most one extra socket timeout.
    """
    raw = getattr(getattr(response, "fp", None), "raw", None)
    sock = getattr(raw, "_sock", None)
    return sock if callable(getattr(sock, "settimeout", None)) else None


def _read_jsonrpc_reply(response, deadline: float) -> dict | None:
    """Read the body as it arrives and stop as soon as our reply has.

    A streamable-HTTP server that answers over ``text/event-stream`` commonly
    leaves the stream open after the initialize event, so a single
    ``read(n)`` would block until the socket timeout and call a working server
    unhealthy. ``read1`` returns whatever bytes are available after one
    underlying read, and the buffer is re-parsed after each — that returns the
    moment the reply is complete regardless of whether the server frames
    events with CR, LF or CRLF, and a plain JSON body simply reads to EOF. The
    byte cap and the deadline both still hold.
    """
    buf = bytearray()
    sock = _socket_of(response)
    while len(buf) < _MAX_PROBE_BODY_BYTES:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        if sock is not None:
            # Make every blocking read obey the one total deadline, instead of
            # each inheriting the full socket timeout — a server that stalls
            # right before the deadline would otherwise double the probe time.
            sock.settimeout(remaining)
        chunk = response.read1(_MAX_PROBE_BODY_BYTES - len(buf))
        if not chunk:
            break
        buf += chunk
        payload = _jsonrpc_from_body(bytes(buf))
        if payload is not None:
            return payload
    return _jsonrpc_from_body(bytes(buf))


def _initialize_result(payload: dict | None) -> dict | None:
    """Return the ``initialize`` result only if it is complete.

    The spec makes ``protocolVersion``, ``capabilities`` and ``serverInfo`` all
    required. A result missing any of them did not prove negotiation happened.
    """
    result = (payload or {}).get("result")
    if not isinstance(result, dict):
        return None
    version = result.get("protocolVersion")
    if not isinstance(version, str) or not _PROTOCOL_VERSION.fullmatch(version):
        return None
    if not isinstance(result.get("capabilities"), dict):
        return None
    server_info = result.get("serverInfo")
    if not isinstance(server_info, dict) or not isinstance(server_info.get("name"), str):
        return None
    if not server_info["name"].strip():
        return None
    return result


def _ok_result(payload: dict | None, code: int) -> tuple[str, str]:
    """Grade a 2xx reply. A 2xx alone proves only that *something* answered.

    Healthy verdicts are deliberately silent in the panel, so calling an HTML
    login page or a proxy catch-all healthy would hide a server that cannot
    serve a single tool. Only a complete ``initialize`` result to *our* request
    earns HEALTHY.
    """
    if payload is None:
        return UNKNOWN, f"HTTP {code}, not an MCP response"
    if isinstance(payload.get("error"), dict):
        # It speaks MCP and refused to initialize: a real, actionable failure.
        return UNHEALTHY, f"HTTP {code}, initialize rejected"
    if _initialize_result(payload) is not None:
        return HEALTHY, f"HTTP {code}"
    return UNKNOWN, f"HTTP {code}, unrecognized initialize result"


def _status_result(code: int, payload: dict | None = None) -> tuple[str, str]:
    detail = f"HTTP {code}"
    if code in _AUTH_STATUSES:
        return NEEDS_AUTH, detail
    if 200 <= code < 300:
        return _ok_result(payload, code)
    if 300 <= code < 400 or code in _PROTOCOL_MISMATCH_STATUSES:
        return UNKNOWN, detail
    return UNHEALTHY, detail


def _transport_detail(exc: BaseException) -> str:
    reason = getattr(exc, "reason", None)
    if isinstance(exc, TimeoutError) or isinstance(reason, TimeoutError):
        return "timed out"
    return "unreachable"


def _probe_http(url: str, cfg: dict) -> tuple[str, str]:
    # Validate at the point of use: config is a trust boundary here, and
    # urlopen() would happily follow file:// or ftp:// out of a config file.
    scheme = urllib_parse.urlsplit(url).scheme.lower()
    if scheme not in {"http", "https"}:
        return UNHEALTHY, "unsupported url scheme"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    configured = cfg.get("headers")
    if isinstance(configured, dict):
        for key, value in configured.items():
            if isinstance(key, str) and isinstance(value, str):
                headers[key] = value
    request = urllib_request.Request(
        url,
        data=json.dumps(_INITIALIZE_REQUEST).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    session_id = None
    protocol_version = None
    # One absolute budget for the whole probe — connect, headers, body and the
    # session-ending DELETE — so no phase can add its own full timeout on top.
    deadline = time.monotonic() + PROBE_TIMEOUT_S
    try:
        with _urlopen(request, timeout=PROBE_TIMEOUT_S) as response:
            code = int(getattr(response, "status", None) or response.getcode())
            session_id = response.headers.get("Mcp-Session-Id")
            payload = _read_jsonrpc_reply(response, deadline)
            result = _initialize_result(payload)
            if result is not None:
                protocol_version = result["protocolVersion"]
            return _status_result(code, payload)
    except urllib_error.HTTPError as exc:
        return _status_result(int(exc.code))
    except (urllib_error.URLError, OSError, ValueError) as exc:
        return UNHEALTHY, _transport_detail(exc)
    finally:
        if session_id:
            _end_session(url, headers, session_id, protocol_version, deadline)


def _end_session(url: str, headers: dict, session_id: str, protocol_version: str | None,
                 deadline: float) -> None:
    """Terminate the session our ``initialize`` just opened.

    A stateful streamable-HTTP server allocates a session per ``initialize``
    and hands back ``Mcp-Session-Id``. Walking away would leave one abandoned
    session per probe until the server expires it. The spec's client-side
    termination is a DELETE carrying that id and, once negotiated, the
    ``MCP-Protocol-Version`` every post-initialize request must carry — a
    server that enforces it would otherwise 400 the DELETE and keep the
    session. A server that does not support termination answers 405; either
    way the outcome does not change the verdict.
    """
    terminate_headers = {**headers, "Mcp-Session-Id": session_id}
    if protocol_version:
        terminate_headers["MCP-Protocol-Version"] = protocol_version
    request = urllib_request.Request(
        url,
        headers=terminate_headers,
        method="DELETE",
    )
    # Best effort inside what is left of the probe's budget; a session the
    # server keeps is the lesser harm next to a probe that overruns the panel.
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        logger.debug("MCP health probe out of time to end session for %r", url)
        return
    try:
        with _urlopen(request, timeout=remaining):
            pass
    except Exception:
        logger.debug("MCP health probe could not end session for %r", url, exc_info=True)


def _probe_stdio(command: str, env) -> tuple[str, str]:
    # The agent spawns with the server's configured env merged over its own,
    # so a PATH set there is where the executable may actually live.
    path = os.environ.get("PATH")
    if isinstance(env, dict) and isinstance(env.get("PATH"), str):
        path = env["PATH"]
    if shutil.which(command, path=path):
        # Spawning the server to speak MCP at it would be a side effect, not a
        # check. ``connected`` from the agent registry is the real liveness
        # signal for stdio; the caller folds that in.
        return UNKNOWN, "stdio server not probed"
    return UNHEALTHY, f"command not found: {os.path.basename(command) or command}"


def probe_server(name: str, cfg: dict) -> tuple[str, str]:
    """Return ``(health, detail)`` for one server config. Never raises for bad config."""
    if not isinstance(cfg, dict):
        return UNHEALTHY, "invalid config"
    url = cfg.get("url")
    if isinstance(url, str) and url.strip():
        return _probe_http(url.strip(), cfg)
    command = cfg.get("command")
    if isinstance(command, str) and command.strip():
        return _probe_stdio(command.strip(), cfg.get("env"))
    return UNHEALTHY, "invalid config"


def _fingerprint(cfg) -> str:
    """Identify the exact config a verdict was measured against.

    Two servers that share a name but not a url/token are different servers, and
    editing one in place makes the old verdict describe something that no longer
    exists. Identical configs deliberately collide: that really is one server.
    """
    try:
        canonical = json.dumps(cfg, sort_keys=True, default=str)
    except Exception:
        canonical = repr(cfg)
    return hashlib.sha256(canonical.encode("utf-8", "replace")).hexdigest()[:16]


def _run_check(name: str, cfg: dict, fingerprint: str) -> None:
    try:
        try:
            health, detail = probe_server(name, cfg)
        except Exception:
            logger.debug("MCP health check for %r failed", name, exc_info=True)
            health, detail = UNKNOWN, "health check failed"
        with _LOCK:
            _STATE[(name, fingerprint)] = {
                "health": health,
                "detail": detail,
                "checked_at": time.time(),
            }
    finally:
        with _LOCK:
            _IN_FLIGHT.discard((name, fingerprint))


def refresh_and_read(servers: dict) -> dict[str, dict]:
    """Schedule due probes and return the verdicts that match ``servers`` *now*.

    Every configured name gets a row. ``pending`` is true while a probe for
    that name is in flight; ``health``/``detail``/``checked_at`` are present
    once a verdict for this exact config exists.

    ``servers`` is the set of servers that *should* be checked — the caller has
    already dropped disabled ones. Nothing outside that set is scheduled or
    read back, so toggling a server off both stops checking it and hides its
    stale verdict; the entry itself lives on only until its interval lapses.

    A verdict is only ever returned for the exact config it was measured
    against. Entries are keyed by the fingerprint of the config that produced
    them, so editing a server's url/headers/command, or switching to a profile
    whose same-named server points somewhere else, neither returns the old
    server's verdict nor waits out the interval before re-probing. A probe
    already in flight when the config changes still publishes — under its own
    identity, where it is simply not read for the new one.
    """
    if not isinstance(servers, dict):
        servers = {}
    now = time.monotonic()
    due: list[tuple[str, dict, str]] = []
    current = {str(name): _fingerprint(cfg) for name, cfg in servers.items()}
    configs = {str(name): (cfg if isinstance(cfg, dict) else {}) for name, cfg in servers.items()}
    with _LOCK:
        # Prune by expiry only, never by "not in this request": a sibling
        # profile's servers — same name or a different one — must keep their
        # verdict and interval slot across a switch, or alternating profiles
        # start an initialize/DELETE cycle every time. Past the interval an
        # identity would be re-probed anyway, so that is where it is dropped;
        # the read below is what filters to the identities configured *now*.
        for key in list(_STARTED_AT):
            if (now - _STARTED_AT[key]) >= HEALTH_INTERVAL_S and key[1] != current.get(key[0]):
                _STARTED_AT.pop(key, None)
                _STATE.pop(key, None)
        for name, fingerprint in current.items():
            key = (name, fingerprint)
            if key in _IN_FLIGHT:
                continue
            started = _STARTED_AT.get(key)
            if started is not None and (now - started) < HEALTH_INTERVAL_S:
                continue
            if len(_IN_FLIGHT) >= MAX_CONCURRENT_PROBES:
                # Process-wide cap on threads and sockets. A deferred server
                # keeps its stale/absent slot, so it reads as pending below and
                # the panel's next read schedules it once a slot frees up.
                continue
            _IN_FLIGHT.add(key)
            _STARTED_AT[key] = now
            due.append((name, configs[name], fingerprint))
        # Read and in-flight state come out of the same lock hold, so a row
        # can never say "settled" while its refresh is actually running: an
        # expired verdict stays visible (no flicker to unknown every interval)
        # but is flagged pending until the new one is published. A server that
        # is due but was deferred by the cap is pending for the same reason.
        readable = {}
        for name, fingerprint in current.items():
            key = (name, fingerprint)
            row = dict(_STATE.get(key) or {})
            started = _STARTED_AT.get(key)
            row["pending"] = (
                key in _IN_FLIGHT
                or started is None
                or (now - started) >= HEALTH_INTERVAL_S
            )
            readable[name] = row
    for name, cfg, fingerprint in due:
        try:
            threading.Thread(
                target=_run_check,
                args=(name, cfg, fingerprint),
                name=f"mcp-health-{name}"[:60],
                daemon=True,
            ).start()
        except Exception:
            logger.debug("could not start MCP health thread for %r", name, exc_info=True)
            with _LOCK:
                _IN_FLIGHT.discard((name, fingerprint))
                # Release the interval slot too, or the unstarted probe looks
                # "recently scheduled" for 120s and the panel's bounded
                # re-reads exhaust themselves waiting on a verdict that never
                # comes. The next read retries instead.
                _STARTED_AT.pop((name, fingerprint), None)
    return readable


def snapshot() -> dict[str, dict]:
    """Return a copy of the current per-server health verdicts."""
    with _LOCK:
        return {name: dict(row) for name, row in _STATE.items()}


def in_flight() -> set[str]:
    """Names with a probe currently running (any identity)."""
    with _LOCK:
        return {name for name, _ in _IN_FLIGHT}


def reset() -> None:
    """Drop all cached health state (tests, and config reloads that rename servers)."""
    with _LOCK:
        _STATE.clear()
        _STARTED_AT.clear()
