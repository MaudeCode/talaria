"""HWEB-35: the listening socket must bind before startup recovery runs.

Session recovery, agent dependency repair and watcher/plugin startup all used to
run in front of ``QuietHTTPServer(...)``, so a restart could leave the port
unreachable for as long as a full session scan — worst case, a pip install with
a 120s timeout. They now run on a background thread behind the bind, and only
requests that read recovered session state wait on a readiness event.

Each test drives the real ``server.main()`` with a gate wedged into recovery, so
the assertions are about the production startup ordering rather than a stand-in.
"""

from __future__ import annotations

import json
import socket
import threading
import time
import urllib.error
import urllib.request

import pytest

# Bound for the 503 path: the readiness wait is shortened so a test observes the
# timeout in well under a second instead of the production 10s.
GATE_WAIT_SECONDS = 0.5


class _Boot:
    """Handle on one in-process server started from ``server.main()``."""

    def __init__(self, recovery_error, plugins_error=None):
        self.recovery_error = recovery_error
        self.recovery_started = threading.Event()
        self.release_recovery = threading.Event()
        # Plugin discovery runs after recovery; released by default so tests
        # that only exercise the recovery gate never wait on it.
        self.plugins_error = plugins_error
        self.plugins_started = threading.Event()
        self.release_plugins = threading.Event()
        self.release_plugins.set()
        self.deferred_finished = threading.Event()
        self.auto_install_calls = []
        self.httpd = None
        self.main_thread = None

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def connect(self, timeout=5):
        return socket.create_connection(
            ("127.0.0.1", self.httpd.server_address[1]), timeout=timeout
        )

    def get(self, path, timeout=10):
        """Return ``(status, headers, body_text)``, treating 4xx/5xx as results."""
        try:
            with urllib.request.urlopen(self.base + path, timeout=timeout) as resp:
                return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read().decode("utf-8", "replace")


@pytest.fixture
def boot_server(monkeypatch):
    """Start ``server.main()`` on an ephemeral port with recovery held open.

    Every startup side effect that reaches outside the process (crash hooks, fd
    limits, credential chmod, watcher, plugins, drain threads) is stubbed; the
    bind, the readiness event and the deferred-startup ordering are real.
    """
    import server

    from api import background_process, config, gateway_watcher, plugins
    from api import session_lifecycle, session_recovery, startup, talaria_relay

    boots = []

    def _start(*, recovery_error=None, plugins_error=None):
        boot = _Boot(recovery_error, plugins_error)

        def fake_recovery(*_args, **_kwargs):
            boot.recovery_started.set()
            assert boot.release_recovery.wait(timeout=30), "recovery gate never released"
            if boot.recovery_error is not None:
                raise boot.recovery_error
            return {"restored": 0, "scanned": 0}

        def fake_load_plugins(*_args, **_kwargs):
            boot.plugins_started.set()
            assert boot.release_plugins.wait(timeout=30), "plugin gate never released"
            if boot.plugins_error is not None:
                raise boot.plugins_error

        monkeypatch.setattr(session_recovery, "recover_all_sessions_on_startup", fake_recovery)
        monkeypatch.setattr(config, "verify_hermes_imports", lambda: (True, [], {}))
        monkeypatch.setattr(config, "print_startup_config", lambda *a, **k: None)
        monkeypatch.setattr(
            startup, "auto_install_agent_deps", lambda: boot.auto_install_calls.append(1)
        )
        monkeypatch.setattr(server, "install_crash_visibility", lambda *a, **k: None)
        monkeypatch.setattr(server, "_ignore_sigpipe", lambda: None)
        monkeypatch.setattr(server, "_raise_fd_soft_limit", lambda *a, **k: {})
        monkeypatch.setattr(server, "fix_credential_permissions", lambda: None)
        # The readiness gate sits behind auth; auth itself is not under test.
        monkeypatch.setattr(server, "check_auth", lambda handler, parsed: True)
        monkeypatch.setattr(gateway_watcher, "start_watcher", lambda *a, **k: None)
        monkeypatch.setattr(gateway_watcher, "stop_watcher", lambda *a, **k: None)
        monkeypatch.setattr(background_process, "start_drain_thread", lambda *a, **k: False)
        monkeypatch.setattr(background_process, "stop_drain_thread", lambda *a, **k: None)
        monkeypatch.setattr(background_process, "start_session_channel_reaper", lambda *a, **k: False)
        monkeypatch.setattr(background_process, "stop_session_channel_reaper", lambda *a, **k: None)
        monkeypatch.setattr(session_lifecycle, "drain_all_on_shutdown", lambda *a, **k: None)
        monkeypatch.setattr(plugins, "load_plugins", fake_load_plugins)
        # Last call in run_deferred_startup — signals the thread ran to the end.
        monkeypatch.setattr(
            talaria_relay,
            "start_talaria_relay_publisher",
            lambda *a, **k: boot.deferred_finished.set(),
        )

        real_server_cls = server.QuietHTTPServer

        def capture(*args, **kwargs):
            boot.httpd = real_server_cls(*args, **kwargs)
            return boot.httpd

        monkeypatch.setattr(server, "QuietHTTPServer", capture)
        monkeypatch.setattr(server, "HOST", "127.0.0.1")
        monkeypatch.setattr(server, "PORT", 0)  # ephemeral; real port read back off httpd
        monkeypatch.setattr(startup, "STARTUP_READY", threading.Event())
        monkeypatch.setattr(startup, "PLUGINS_READY", threading.Event())
        monkeypatch.setattr(startup, "STARTUP_WAIT_SECONDS", GATE_WAIT_SECONDS)

        boot.main_thread = threading.Thread(target=server.main, daemon=True)
        boot.main_thread.start()
        deadline = time.monotonic() + 15
        while boot.httpd is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert boot.httpd is not None, "server.main() never bound a socket"
        boots.append(boot)
        return boot

    yield _start

    for boot in boots:
        boot.release_recovery.set()
        boot.release_plugins.set()
        if boot.httpd is not None:
            boot.httpd.shutdown()
        if boot.main_thread is not None:
            boot.main_thread.join(timeout=15)


def test_port_accepts_connection_before_recovery_completes(boot_server):
    """The bind must not wait on the session scan."""
    from api import startup

    boot = boot_server()
    assert boot.recovery_started.wait(timeout=15), "deferred startup never reached recovery"
    assert not startup.STARTUP_READY.is_set(), "readiness set while recovery still running"

    with boot.connect() as sock:
        assert sock is not None

    status, _headers, body = boot.get("/health", timeout=5)
    assert status == 200, f"/health must answer during recovery, got {status}: {body}"
    assert json.loads(body).get("status") == "ok"


def test_recovery_dependent_request_503s_during_startup_then_succeeds(boot_server):
    """/api/sessions waits on the readiness bound, then 503s instead of hanging."""
    from api import startup

    boot = boot_server()
    assert boot.recovery_started.wait(timeout=15), "deferred startup never reached recovery"

    started = time.monotonic()
    status, headers, body = boot.get("/api/sessions", timeout=10)
    elapsed = time.monotonic() - started
    assert status == 503, f"expected 503 while recovery runs, got {status}: {body}"
    assert headers.get("Retry-After") == "5", f"missing Retry-After: {headers}"
    assert json.loads(body).get("phase") == "session recovery"
    assert GATE_WAIT_SECONDS <= elapsed < 8, (
        f"request must wait the readiness bound then answer, not hang; took {elapsed:.2f}s"
    )

    boot.release_recovery.set()
    assert startup.STARTUP_READY.wait(timeout=15), "readiness never set after recovery"

    status, _headers, body = boot.get("/api/sessions", timeout=15)
    assert status == 200, f"expected success once recovery finished, got {status}: {body}"


def test_auto_install_not_invoked_when_agent_imports_resolve(boot_server):
    """The pip path stays behind an actual import failure."""
    boot = boot_server()
    boot.release_recovery.set()
    assert boot.deferred_finished.wait(timeout=20), "deferred startup did not run to completion"
    assert boot.auto_install_calls == [], "auto_install_agent_deps ran with all imports resolving"


def test_server_still_serves_when_background_recovery_raises(boot_server):
    """A raising recovery must release readiness, not wedge every /api/ request."""
    from api import startup

    boot = boot_server(recovery_error=RuntimeError("simulated recovery failure HWEB-35"))
    assert boot.recovery_started.wait(timeout=15), "deferred startup never reached recovery"
    boot.release_recovery.set()
    assert startup.STARTUP_READY.wait(timeout=15), "readiness never set after recovery raised"

    status, _headers, body = boot.get("/api/sessions", timeout=15)
    assert status == 200, f"server must keep serving after recovery raised, got {status}: {body}"


def test_gate_fails_open_when_no_deferred_startup_was_armed():
    """No recovery pass in flight means nothing to wait for.

    A process that never calls start_deferred_startup() — a test driving Handler
    directly, an embedder calling into the routes — must not stall every /api/
    request for the full readiness bound before 503ing.
    """
    from urllib.parse import urlparse

    from api import startup

    assert startup.STARTUP_READY.is_set(), (
        "readiness must default to set so an unarmed process serves immediately"
    )
    started = time.monotonic()
    assert startup.await_startup_ready(None, urlparse("/api/sessions")) is True
    assert time.monotonic() - started < 1, "unarmed gate must not wait on the readiness bound"


def test_gated_waiters_cannot_exhaust_the_request_worker_budget(boot_server):
    """Gated requests must not starve the readiness-exempt routes.

    Each waiter holds one of HTTPWorkerBudgetMixin's request-worker slots, and
    process_request() acquires those non-blocking. Without a cap on concurrent
    waiters, reconnecting tabs fill the budget and /health is overflow-rejected
    at accept time — the outage this gate exists to remove.
    """
    from api import startup

    boot = boot_server()
    assert boot.recovery_started.wait(timeout=15), "deferred startup never reached recovery"

    results = []
    threads = [
        threading.Thread(target=lambda: results.append(boot.get("/api/sessions", timeout=20)))
        for _ in range(startup.STARTUP_WAIT_SLOT_COUNT + 6)
    ]
    for t in threads:
        t.start()
    try:
        # /health must stay answerable while every gated request is outstanding.
        status, _headers, body = boot.get("/health", timeout=10)
        assert status == 200, f"/health starved by gated waiters, got {status}: {body}"
    finally:
        boot.release_recovery.set()
        for t in threads:
            t.join(timeout=30)

    over_cap = [r for r in results if r[0] == 503]
    assert over_cap, "expected the over-cap requests to 503 rather than queue"
    for status, headers, body in over_cap:
        assert headers.get("Retry-After") == "5"
        assert json.loads(body).get("condition") == "startup_recovery"


def test_startup_503_is_labelled_for_client_retry(boot_server):
    """The body carries a condition clients can branch on.

    static/workspace.js retries this and only this 503, so a one-shot bootstrap
    fetch does not commit fallback settings for the rest of the boot.
    """
    boot = boot_server()
    assert boot.recovery_started.wait(timeout=15), "deferred startup never reached recovery"

    _status, _headers, body = boot.get("/api/sessions", timeout=10)
    assert json.loads(body).get("condition") == "startup_recovery"


def test_deep_health_defers_until_recovery_settles(boot_server):
    """/health?deep=1 must not race recovery's session-index rebuild."""
    from api import startup

    boot = boot_server()
    assert boot.recovery_started.wait(timeout=15), "deferred startup never reached recovery"

    status, headers, body = boot.get("/health?deep=1", timeout=10)
    assert status == 503, f"deep health must defer during recovery, got {status}: {body}"
    payload = json.loads(body)
    assert payload.get("status") == "starting"
    assert payload.get("phase") == "session recovery"
    assert headers.get("Retry-After") == "5"
    assert "checks" not in payload, "deep probes ran while recovery was still active"

    # Plain /health stays immediate throughout.
    assert boot.get("/health", timeout=5)[0] == 200

    boot.release_recovery.set()
    assert startup.STARTUP_READY.wait(timeout=15), "readiness never set after recovery"
    assert boot.get("/health?deep=1", timeout=15)[0] in (200, 503)


def test_public_auth_endpoints_are_not_gated(boot_server):
    """A long recovery must not lock users out of an authenticated deployment.

    static/login.js posts with a bare fetch() and never sees api()'s startup
    retry, so gating the public auth surface would break login outright.
    """
    from urllib.parse import urlparse

    from api import startup
    from api.auth import PUBLIC_PATHS

    boot = boot_server()
    assert boot.recovery_started.wait(timeout=15), "deferred startup never reached recovery"

    for path in ("/api/auth/login", "/api/auth/status", "/api/auth/passkey/options",
                 "/api/auth/oidc/start", "/api/health/restart", "/api/csp-report"):
        assert path in PUBLIC_PATHS or path in startup.STARTUP_IMMEDIATE_PATHS, (
            f"{path} is neither public nor explicitly immediate"
        )
        started = time.monotonic()
        assert startup.await_startup_ready(None, urlparse(path)) is True, f"{path} was gated"
        assert time.monotonic() - started < 1, f"{path} waited on the readiness bound"

    # A genuinely session-dependent route still waits.
    assert startup.await_startup_ready is not None
    assert not startup.STARTUP_READY.is_set()


def test_agent_deps_ready_is_a_separate_readiness_dimension(boot_server):
    """Recovery readiness must not imply the pip repair has finished."""
    from api import startup

    boot = boot_server()
    assert boot.recovery_started.wait(timeout=15), "deferred startup never reached recovery"
    assert not startup.AGENT_DEPS_READY.is_set(), "dependency repair marked done before it ran"

    boot.release_recovery.set()
    assert startup.STARTUP_READY.wait(timeout=15), "readiness never set after recovery"
    assert startup.AGENT_DEPS_READY.wait(timeout=15), "dependency readiness never released"


def test_agent_unavailable_message_reflects_in_flight_dependency_repair(monkeypatch):
    """The "check sys.path" diagnostic is wrong while pip is still running."""
    from api import startup, streaming

    monkeypatch.setattr(startup, "AGENT_DEPS_READY", threading.Event())
    detail = streaming._aiagent_import_error_detail()
    assert "still being installed" in detail
    assert "sys.path" not in detail, "sent the user to troubleshoot a problem they do not have"

    startup.AGENT_DEPS_READY.set()
    settled = streaming._aiagent_import_error_detail()
    assert "sys.path" in settled, "the real diagnostic must return once repair has settled"


def test_plugin_registry_is_published_atomically(tmp_path, monkeypatch):
    """Discovery runs behind the bind, so readers must never see it half-done.

    load_plugins() used to insert into PLUGIN_MANIFESTS one entry at a time.
    Before HWEB-35 that finished before the socket bound; now an in-flight
    /api/plugins request or the plugin-page router can iterate it concurrently,
    where a partial list is wrong and a resize mid-iteration raises RuntimeError.
    """
    from api import plugins

    for i in range(25):
        d = tmp_path / f"plug{i}" / "dashboard"
        d.mkdir(parents=True)
        (d / "manifest.json").write_text(
            json.dumps({"name": f"plug{i}", "label": f"P{i}", "tab": {"path": f"/plug{i}"}})
        )
    monkeypatch.setenv("HERMES_WEBUI_PLUGINS_DIR", str(tmp_path))
    monkeypatch.setattr(plugins, "PLUGIN_MANIFESTS", {})
    monkeypatch.setattr(plugins, "_PLUGIN_STATIC_ROOTS", {})

    observed = []
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            try:
                # Same access shape as api/routes.py's plugin-page router.
                observed.append(len([n for n, _m in plugins.PLUGIN_MANIFESTS.items()]))
            except RuntimeError as exc:  # pragma: no cover - the bug being pinned
                observed.append(exc)
                return

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    try:
        plugins.load_plugins()
    finally:
        stop.set()
        t.join(timeout=10)

    assert len(plugins.PLUGIN_MANIFESTS) == 25, "discovery did not publish every plugin"
    assert not any(isinstance(o, RuntimeError) for o in observed), (
        "registry mutated while a reader iterated it"
    )
    # Every observation is either the empty pre-publish state or the full set —
    # never a partially-filled registry.
    assert set(observed) <= {0, 25}, f"reader saw a partial registry: {sorted(set(observed))}"


def test_public_share_reads_are_not_gated():
    """Public share links must survive a long recovery.

    api/shares.py serves a standalone snapshot with no recovered-session
    dependency, and static/share.js fetches it with a bare, non-retrying
    fetch() — so gating it renders a permanent "Share unavailable".
    """
    from urllib.parse import urlparse

    from api import startup

    startup.STARTUP_READY.clear()
    try:
        for path in ("/api/share/abc123", "/api/share/tok-en_09"):
            assert startup.await_startup_ready(None, urlparse(path)) is True, f"{path} gated"
        # Mutating share routes are not public and stay gated.
        for path in ("/api/share/create", "/api/share/revoke"):
            assert startup._startup_exempt(path) is False, f"{path} must stay gated"
    finally:
        startup.STARTUP_READY.set()


def test_startup_exempt_tracks_the_auth_predicate():
    """The exemption reuses api.auth.is_public_path so the rules cannot drift."""
    from api import startup
    from api.auth import is_public_path

    for path in ("/api/share/tok", "/api/auth/login", "/api/auth/status",
                 "/api/share/create", "/api/sessions", "/api/settings"):
        assert startup._startup_exempt(path) == (
            is_public_path(path) or path in startup.STARTUP_IMMEDIATE_PATHS
        ), f"{path} diverged from the auth predicate"


def test_gated_write_closes_the_connection(boot_server):
    """A rejected write leaves its body unread, so the connection must not be reused.

    Otherwise BaseHTTPRequestHandler parses the unread JSON as the next request
    line — blocking to the 30s handler timeout or answering a spurious 400/501
    while holding the request-worker slot STARTUP_WAIT_SLOTS exists to protect.
    """
    boot = boot_server()
    assert boot.recovery_started.wait(timeout=15), "deferred startup never reached recovery"

    body = json.dumps({"title": "x" * 200}).encode()
    with boot.connect(timeout=20) as sock:
        sock.sendall(
            b"POST /api/sessions HTTP/1.1\r\nHost: localhost\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        )
        sock.settimeout(20)
        chunks = []
        while True:
            try:
                data = sock.recv(4096)
            except socket.timeout as exc:  # pragma: no cover - the bug being pinned
                raise AssertionError(
                    "server held the connection open on a gated write"
                ) from exc
            if not data:
                break
            chunks.append(data)

    raw = b"".join(chunks)
    assert b"503" in raw.split(b"\r\n", 1)[0], f"expected a 503 status line, got {raw[:80]!r}"
    assert b"startup_recovery" in raw
    # Exactly one response: the unread body was not parsed as a second request.
    assert raw.count(b"HTTP/1.1 ") == 1, f"server answered the unread body too: {raw[:400]!r}"
