"""HWEB-64: plugin consumers wait for the registry instead of reading it empty.

load_plugins() runs last in run_deferred_startup(), behind session recovery and
the pip repair. STARTUP_READY is already set by then, so /api/plugins and the
plugin-page router were admitted against an empty registry — the UI hid the
Plugins tab and an enabled plugin's page 404'd until discovery published.
PLUGINS_READY gates exactly those consumers; nothing else waits on it.
"""
from __future__ import annotations

import json
import time

from tests import test_hweb35_deferred_startup as _hweb35

GATE_WAIT_SECONDS = _hweb35.GATE_WAIT_SECONDS
# Re-export the HWEB-35 boot fixture so pytest finds it in this module.
boot_server = _hweb35.boot_server


def _boot_into_plugin_discovery(boot_server, **kwargs):
    """Start a server and park it inside load_plugins() with recovery settled."""
    from api import startup

    boot = boot_server(**kwargs)
    boot.release_plugins.clear()
    boot.release_recovery.set()
    assert startup.STARTUP_READY.wait(timeout=15), "readiness never set after recovery"
    assert boot.plugins_started.wait(timeout=15), "deferred startup never reached plugins"
    assert not startup.PLUGINS_READY.is_set(), "plugin readiness set before discovery ran"
    return boot


def test_api_plugins_is_not_authoritative_during_discovery(boot_server):
    """An empty pre-publish registry must surface as 'not ready', never as empty."""
    from api import startup

    boot = _boot_into_plugin_discovery(boot_server)

    started = time.monotonic()
    status, headers, body = boot.get("/api/plugins", timeout=10)
    elapsed = time.monotonic() - started
    assert status == 503, f"expected 503 while discovery runs, got {status}: {body}"
    payload = json.loads(body)
    assert payload.get("phase") == "plugin discovery"
    # Same retry marker as the recovery gate, so static/workspace.js's api()
    # retries this instead of committing an empty plugin list.
    assert payload.get("condition") == "startup_recovery"
    assert headers.get("Retry-After") == "5"
    assert GATE_WAIT_SECONDS <= elapsed < 8, f"gate must wait its bound then answer; took {elapsed:.2f}s"

    boot.release_plugins.set()
    assert startup.PLUGINS_READY.wait(timeout=15), "plugin readiness never released"
    status, _headers, body = boot.get("/api/plugins", timeout=15)
    assert status == 200, f"expected success once discovery finished, got {status}: {body}"
    assert "plugins" in json.loads(body)


def test_enabled_plugin_page_does_not_404_during_discovery(boot_server, monkeypatch, tmp_path):
    """The page router iterates the registry; before publication it saw nothing."""
    from api import plugins, routes, startup

    dashboard = tmp_path / "demo" / "dashboard"
    (dashboard / "dist").mkdir(parents=True)
    (dashboard / "dist" / "index.html").write_text("<!doctype html><title>demo</title>")
    monkeypatch.setattr(plugins, "PLUGIN_MANIFESTS", {})
    monkeypatch.setattr(plugins, "_PLUGIN_STATIC_ROOTS", {})
    monkeypatch.setattr(routes, "_dashboard_plugin_enabled", lambda name: name == "demo")

    boot = _boot_into_plugin_discovery(boot_server)

    status, headers, body = boot.get("/demo", timeout=10)
    assert status == 503, f"undiscovered plugin page must not 404, got {status}: {body}"
    # A navigation or sandboxed iframe load has no api() to retry for it, so the
    # 503 is an HTML document that retries itself until the real page serves.
    assert "text/html" in headers.get("Content-Type", ""), headers
    assert headers.get("Retry-After") == "5"
    assert 'http-equiv="refresh"' in body, body
    # The in-app plugin iframe is same-origin; the shared security headers
    # (X-Frame-Options: DENY, frame-ancestors 'none') would block this document
    # from loading in it, so the refresh would never run.
    assert "X-Frame-Options" not in headers, headers
    assert "frame-ancestors" not in headers.get("Content-Security-Policy", ""), headers

    # Discovery publishes, exactly as load_plugins() does, then releases.
    plugins.PLUGIN_MANIFESTS.update({"demo": {"name": "demo", "label": "Demo", "tab": {"path": "/demo"}}})
    plugins._PLUGIN_STATIC_ROOTS.update({"demo": dashboard})
    boot.release_plugins.set()
    assert startup.PLUGINS_READY.wait(timeout=15), "plugin readiness never released"

    status, headers, body = boot.get("/demo", timeout=15)
    assert status == 200, f"plugin page must serve once published, got {status}: {body}"
    assert "text/html" in headers.get("Content-Type", "")
    assert "demo" in body
    status, _headers, _body = boot.get("/dashboard-plugins/demo/dist/index.html", timeout=15)
    assert status == 200, "plugin asset must serve once published"


def test_plugins_ready_is_released_when_load_plugins_raises(boot_server):
    """A raising discovery must not leave plugin consumers 503ing forever."""
    from api import startup

    boot = _boot_into_plugin_discovery(boot_server, plugins_error=RuntimeError("bad manifest import"))
    boot.release_plugins.set()
    assert startup.PLUGINS_READY.wait(timeout=15), "plugin readiness never released after a raise"
    # The rest of deferred startup still runs behind the failed discovery.
    assert boot.deferred_finished.wait(timeout=15), "deferred startup did not run to completion"
    status, _headers, body = boot.get("/api/plugins", timeout=15)
    assert status == 200, f"/api/plugins must answer after a failed discovery, got {status}: {body}"


def test_non_plugin_routes_ignore_plugin_readiness(boot_server):
    """Only registry readers wait on PLUGINS_READY; STARTUP_READY still governs the rest."""
    boot = _boot_into_plugin_discovery(boot_server)

    started = time.monotonic()
    status, _headers, body = boot.get("/api/sessions", timeout=10)
    elapsed = time.monotonic() - started
    assert status == 200, f"non-plugin route must serve once recovery settled, got {status}: {body}"
    assert elapsed < GATE_WAIT_SECONDS, f"non-plugin route waited on the plugin gate ({elapsed:.2f}s)"
    status, _headers, _body = boot.get("/", timeout=10)
    assert status == 200, f"app shell must serve during plugin discovery, got {status}"


def test_plugin_gate_fails_open_when_no_deferred_startup_was_armed():
    """A process that never armed deferred startup has no discovery to wait for."""
    from api import startup

    assert startup.PLUGINS_READY.is_set()
    assert startup.await_plugins_ready(handler=None, parsed=None) is True


def test_a_step_escaping_its_guard_does_not_skip_plugin_discovery(monkeypatch):
    """A raise out of an earlier step must neither strand PLUGINS_READY nor
    set it without attempting discovery (an empty registry read as authoritative)."""
    import threading

    from api import plugins, startup, talaria_relay

    for name in ("STARTUP_READY", "AGENT_DEPS_READY", "PLUGINS_READY"):
        monkeypatch.setattr(startup, name, threading.Event())
    calls = []
    monkeypatch.setattr(startup, "_recover_sessions_step", lambda: calls.append("recover"))

    def deps_step_escapes_its_guard():
        # e.g. the post-repair print() hitting a closed stdout — nothing set yet.
        raise BrokenPipeError("stdout closed")

    monkeypatch.setattr(startup, "_repair_agent_deps_step", deps_step_escapes_its_guard)
    monkeypatch.setattr(startup, "_start_background_workers_step", lambda: calls.append("workers"))
    monkeypatch.setattr(plugins, "load_plugins", lambda: calls.append("load_plugins"))
    monkeypatch.setattr(talaria_relay, "start_talaria_relay_publisher", lambda: calls.append("relay"))

    thread = startup.start_deferred_startup()
    thread.join(timeout=10)
    assert not thread.is_alive()
    assert calls == ["recover", "workers", "load_plugins", "relay"], calls
    assert startup.PLUGINS_READY.is_set(), "PLUGINS_READY left armed after an earlier step raised"


def test_plugin_gate_sets_plugins_ready_only_after_discovery_was_attempted(monkeypatch):
    """PLUGINS_READY means 'discovery ran', not 'the worker exited'."""
    import threading

    from api import plugins, startup

    monkeypatch.setattr(startup, "PLUGINS_READY", threading.Event())
    seen = []

    def load_plugins():
        seen.append(startup.PLUGINS_READY.is_set())

    monkeypatch.setattr(plugins, "load_plugins", load_plugins)
    startup._load_plugins_step()
    assert seen == [False], "PLUGINS_READY was set before discovery ran"
    assert startup.PLUGINS_READY.is_set()
