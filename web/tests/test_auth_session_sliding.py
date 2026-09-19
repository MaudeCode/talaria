"""Sliding login lifetime through the auth gate and real HTTP response headers."""
import io
import json
import os
from concurrent.futures import ThreadPoolExecutor
from email.parser import BytesParser
from http.cookies import SimpleCookie
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import urlparse

import pytest

import api.auth as auth
import api.config as config
import api.profiles as profiles
from server import Handler


DAY = 86400


@pytest.fixture
def clock(monkeypatch, tmp_path):
    now = SimpleNamespace(value=1_800_000_000.0)
    monkeypatch.setattr(auth.time, "time", lambda: now.value)
    monkeypatch.setattr(auth, "STATE_DIR", tmp_path)
    monkeypatch.setattr(auth, "_SESSIONS_FILE", tmp_path / ".sessions.json")
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(auth, "_sessions", {})
    monkeypatch.setattr(auth, "_SIGNING_KEY_CACHE", b"sliding-session-test-key")
    monkeypatch.setattr(auth, "load_settings", lambda: config._read_raw_settings_file())
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    monkeypatch.setenv("HERMES_WEBUI_SESSION_TTL", str(30 * DAY))
    monkeypatch.setenv("HERMES_WEBUI_SECURE", "true")
    monkeypatch.setenv("HERMES_WEBUI_COOKIE_NAME", "sliding_test_session")
    monkeypatch.delenv("HERMES_WEBUI_SESSION_SLIDING", raising=False)
    monkeypatch.delenv("HERMES_WEBUI_TRUSTED_AUTH_HEADER", raising=False)
    profiles.clear_request_profile()
    yield now
    profiles.clear_request_profile()


def request(cookie, path="/api/sessions", status=200, handler=None):
    handler = handler or Handler.__new__(Handler)
    auth.reset_trusted_auth_request_state(handler)
    handler.headers = {"Cookie": f"{auth._resolve_cookie_name()}={cookie}"}
    handler.request = SimpleNamespace()
    handler.request_version = "HTTP/1.1"
    handler.requestline = f"GET {path} HTTP/1.1"
    handler.command = "GET"
    handler.path = path
    handler.wfile = io.BytesIO()
    handler.log_request = lambda *args: None
    if auth.check_auth(handler, urlparse(path)):
        handler.send_response(status)
        handler.send_header("Content-Length", "0")
        handler.end_headers()
    wire = handler.wfile.getvalue()
    headers = BytesParser().parsebytes(wire.split(b"\r\n", 1)[1])
    cookies = SimpleCookie()
    for value in headers.get_all("Set-Cookie", []):
        cookies.load(value)
    return handler, int(wire.split(b" ")[1]), cookies


def expiry(cookie):
    return auth._session_expiry(auth._sessions.get(cookie.rsplit(".", 1)[0]))


def test_activity_keeps_session_alive_for_120_days_but_inactivity_expires(clock):
    active = auth.create_session(auth_type="password")
    idle = auth.create_session(auth_type="password")
    start = clock.value
    for day in (29, 58, 87, 116, 120):
        clock.value = start + day * DAY
        _, status, cookies = request(active)
        assert status == 200
        assert expiry(active) == clock.value + 30 * DAY
        assert cookies[auth._resolve_cookie_name()]["max-age"] == str(30 * DAY)
        if day == 29:
            clock.value = start + 31 * DAY
            assert request(idle)[1] == 401
    assert not auth.verify_session(idle)


@pytest.mark.parametrize("ttl", [60, 30 * DAY])
def test_refresh_is_throttled_and_persisted_with_matching_cookie(clock, monkeypatch, ttl):
    monkeypatch.setenv("HERMES_WEBUI_SESSION_TTL", str(ttl))
    cookie = auth.create_session(auth_type="passkey", username="synthetic-user")
    original = expiry(cookie)
    save = Mock(wraps=auth._save_sessions)
    monkeypatch.setattr(auth, "_save_sessions", save)
    interval = min(ttl / 10, 3600)
    start = clock.value
    for second in range(1, int(interval * 3) + 1):
        clock.value = start + second
        _, status, cookies = request(cookie)
        assert status == 200
        if second % (int(interval) + 1) == 0:
            renewed = cookies[auth._resolve_cookie_name()]
            assert renewed.value == cookie
            assert renewed["max-age"] == str(ttl)
            assert renewed["httponly"] and renewed["secure"]
            assert renewed["samesite"] == "Lax" and renewed["path"] == "/"
        else:
            assert not cookies
    assert save.call_count == 2
    assert expiry(cookie) > original
    record = auth._load_sessions()[cookie.rsplit(".", 1)[0]]
    assert record["expiry"] == expiry(cookie)
    assert record["auth_type"] == "passkey"
    assert record["username"] == "synthetic-user"


@pytest.mark.parametrize("path,status", [
    ("/api/auth/status", 200), ("/api/auth/logout", 200),
    ("/health", 200), ("/api/sessions", 401), ("/api/sessions", 403),
    ("/api/sessions", 500),
])
def test_public_logout_and_failed_responses_do_not_renew(clock, monkeypatch, path, status):
    cookie = auth.create_session(auth_type="password")
    original = expiry(cookie)
    clock.value += DAY
    save = Mock(wraps=auth._save_sessions)
    monkeypatch.setattr(auth, "_save_sessions", save)
    assert request(cookie, path, status)[2] == {}
    assert expiry(cookie) == original
    save.assert_not_called()


def test_bad_signature_and_owner_denial_do_not_renew(clock):
    cookie = auth.create_session(auth_type="password", bound_profile="alice")
    original = expiry(cookie)
    clock.value += DAY
    assert request(cookie[:-1] + ("0" if cookie[-1] != "0" else "1"))[1] == 401
    assert request(cookie, "/api/shutdown")[1] == 403
    assert expiry(cookie) == original


@pytest.mark.parametrize("settings,env,enabled", [
    ({"webui": {"session_sliding": False}}, None, False),
    ({"webui": {"session_sliding": True}}, "false", False),
    ({"webui": {"session_sliding": False}}, "true", True),
    ({"webui": {"session_sliding": True}}, None, True),
])
def test_sliding_configuration(clock, monkeypatch, settings, env, enabled):
    config.SETTINGS_FILE.write_text(json.dumps(settings))
    if env is not None:
        monkeypatch.setenv("HERMES_WEBUI_SESSION_SLIDING", env)
    cookie = auth.create_session(auth_type="password")
    original = expiry(cookie)
    clock.value += 29 * DAY
    assert request(cookie)[1] == 200
    assert (expiry(cookie) > original) is enabled
    clock.value += 2 * DAY
    assert auth.verify_session(cookie) is enabled


@pytest.mark.parametrize("failure", ["stat", "read", "json", "encoding", "shape"])
def test_unreadable_sliding_policy_never_renews(clock, monkeypatch, failure):
    config.SETTINGS_FILE.write_text('{"webui": {"session_sliding": false}}')
    cookie = auth.create_session(auth_type="password")
    original = expiry(cookie)
    clock.value += DAY
    assert request(cookie)[2] == {}
    if failure in ("stat", "read"):
        method = "stat" if failure == "stat" else "read_text"
        original_method = getattr(type(config.SETTINGS_FILE), method)

        def fail_settings_read(path, *args, **kwargs):
            if path == config.SETTINGS_FILE:
                raise PermissionError("synthetic settings failure")
            return original_method(path, *args, **kwargs)

        monkeypatch.setattr(type(config.SETTINGS_FILE), method, fail_settings_read)
        # Force a cache miss for the read-error case.
        monkeypatch.setattr(config, "_settings_file_cache", {})
    else:
        config.SETTINGS_FILE.write_bytes({
            "json": b"{", "encoding": b"\xff", "shape": b"[]",
        }[failure])
    # An earlier forgiving caller must not poison the strict reader's cache.
    assert config._read_raw_settings_file() == {}
    assert request(cookie)[2] == {}
    assert expiry(cookie) == original


def test_legacy_record_upgrades_only_when_extended(clock):
    cookie = auth.create_session()
    token = cookie.rsplit(".", 1)[0]
    assert request(cookie)[2] == {}
    assert isinstance(auth._sessions[token], float)
    clock.value += DAY
    assert request(cookie)[2]
    assert auth._sessions[token] == {"expiry": clock.value + 30 * DAY}


def test_oidc_reconciliation_rejects_stale_policy_without_renewal(clock, monkeypatch):
    import api.auth_oidc as oidc

    cfg = {"issuer": "https://issuer.example", "allow_values": ["alice"]}
    monkeypatch.setattr(oidc, "_require_oidc_config", lambda: cfg)
    binding = oidc._oidc_profile_binding(cfg, None, owner=True)
    cookie = auth.create_session(auth_type="oidc", oidc_binding=binding)
    clock.value += DAY
    assert request(cookie)[2]
    info = auth.get_session_info(cookie)
    assert info["oidc_owner"] is True
    assert info["oidc_mapping_fingerprint"] == binding["mapping_fingerprint"]
    clock.value += DAY
    cfg["allow_values"] = ["bob"]
    assert request(cookie)[1:] == (401, {})
    assert not auth.verify_session(cookie)
    assert json.loads(auth._SESSIONS_FILE.read_text()) == {}


def test_concurrent_requests_extend_once_and_revocation_wins(clock, monkeypatch):
    cookie = auth.create_session(auth_type="password")
    clock.value += DAY
    save = Mock(wraps=auth._save_sessions)
    monkeypatch.setattr(auth, "_save_sessions", save)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(request, [cookie] * 16))
    assert sum(bool(result[2]) for result in results) == 1
    assert save.call_count == 1
    handler = results[0][0]
    clock.value += DAY
    assert auth.check_auth(handler, urlparse("/api/sessions"))
    auth.invalidate_session(cookie)
    handler.wfile = io.BytesIO()
    handler.send_response(200)
    handler.end_headers()
    assert b"Set-Cookie" not in handler.wfile.getvalue()
    assert not auth.verify_session(cookie)
    assert json.loads(auth._SESSIONS_FILE.read_text()) == {}


def test_keep_alive_does_not_reuse_refresh_candidate(clock):
    cookie = auth.create_session(auth_type="password")
    handler, _, _ = request(cookie)
    clock.value += DAY
    original = expiry(cookie)
    assert request(cookie, "/api/auth/status", handler=handler)[2] == {}
    assert expiry(cookie) == original


def test_profile_cannot_enable_sliding_for_a_fixed_lifetime(clock, monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_WEBUI_SESSION_SLIDING", "false")
    monkeypatch.setattr(profiles, "_loaded_profile_env_keys", set())
    (tmp_path / ".env").write_text("HERMES_WEBUI_SESSION_SLIDING=true\n")
    profiles._reload_dotenv(tmp_path)
    assert os.environ["HERMES_WEBUI_SESSION_SLIDING"] == "false"
    assert "HERMES_WEBUI_SESSION_SLIDING" not in profiles.get_profile_runtime_env(tmp_path)
    assert profiles.filter_runtime_env_for_gateway_parity(
        {"HERMES_WEBUI_SESSION_SLIDING": "true"}
    ) == {}


def test_trusted_session_renews_only_after_identity_reconciliation(clock, monkeypatch):
    import api.routes as routes

    monkeypatch.setenv("HERMES_WEBUI_TRUSTED_AUTH_HEADER", "Remote-User")
    monkeypatch.setattr(routes, "_raw_peer_is_trusted_proxy", lambda handler: True)
    monkeypatch.setattr(auth, "_trusted_auth_username", lambda handler: "alice")
    cookie = auth.create_session(auth_type="trusted", username="alice")
    clock.value += DAY
    assert request(cookie)[2][auth._resolve_cookie_name()].value == cookie
    clock.value += DAY
    monkeypatch.setattr(auth, "_trusted_auth_username", lambda handler: None)
    assert request(cookie)[1:] == (401, {})
    assert not auth.verify_session(cookie)
