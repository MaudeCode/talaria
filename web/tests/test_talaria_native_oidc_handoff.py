import base64
import hashlib
import io
import json
import threading
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils


class FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class RouteFakeHandler:
    def __init__(self):
        self.headers = FakeHeaders({"Host": "server.example", "Content-Length": "0"})
        self.rfile = io.BytesIO()
        self.wfile = io.BytesIO()
        self.request = SimpleNamespace()
        self.status = None
        self.sent_headers = []
        self.client_address = ("127.0.0.1", 12345)

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.sent_headers.append((key, value))

    def end_headers(self):
        pass

    def json_body(self):
        return json.loads(self.wfile.getvalue())

    def header_values(self, name):
        return [value for key, value in self.sent_headers if key.lower() == name.lower()]


@pytest.fixture(autouse=True)
def clear_native_flows(monkeypatch):
    import api.auth_oidc as auth_oidc

    monkeypatch.setattr(auth_oidc, "is_oidc_enabled", lambda: True)
    auth_oidc._pending_flows.clear()
    getattr(auth_oidc, "_native_flows", {}).clear()
    getattr(auth_oidc, "_native_exchange_codes", {}).clear()
    yield
    auth_oidc._pending_flows.clear()
    getattr(auth_oidc, "_native_flows", {}).clear()
    getattr(auth_oidc, "_native_exchange_codes", {}).clear()


def pkce_pair(seed="talaria-test-verifier"):
    verifier = base64.urlsafe_b64encode(hashlib.sha256(seed.encode()).digest()).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


def begin_flow(auth_oidc, *, origin="https://server.example", state="app-state-123456"):
    verifier, challenge = pkce_pair(state)
    result = auth_oidc.begin_native_authorization(
        origin,
        "talaria://oidc-callback",
        state,
        challenge,
    )
    return result, verifier


def post_json(routes, path, payload):
    body = json.dumps(payload).encode()
    handler = RouteFakeHandler()
    handler.rfile = io.BytesIO(body)
    handler.headers["Content-Length"] = str(len(body))
    routes.handle_post(handler, SimpleNamespace(path=path))
    return handler


def signed_id_token(auth_oidc, private_key, nonce, email):
    header = auth_oidc._b64u(b'{"alg":"ES256","kid":"test-key"}')
    claims = auth_oidc._b64u(json.dumps({
        "iss": "https://issuer.example",
        "aud": "test-client",
        "exp": time.time() + 300,
        "iat": time.time(),
        "nonce": nonce,
        "sub": "synthetic-user",
        "email": email,
    }, separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}".encode("ascii")
    der_signature = private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der_signature)
    signature = auth_oidc._b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"{header}.{claims}.{signature}"


def ec_jwk(auth_oidc, private_key):
    numbers = private_key.public_key().public_numbers()
    return {
        "kid": "test-key",
        "kty": "EC",
        "alg": "ES256",
        "crv": "P-256",
        "x": auth_oidc._b64u(numbers.x.to_bytes(32, "big")),
        "y": auth_oidc._b64u(numbers.y.to_bytes(32, "big")),
    }


def configure_route_flow(monkeypatch, auth_oidc):
    monkeypatch.setenv("HERMES_WEBUI_SECURE", "1")
    monkeypatch.setenv("HERMES_WEBUI_OIDC_ISSUER", "https://issuer.example")
    monkeypatch.setenv("HERMES_WEBUI_OIDC_CLIENT_ID", "test-client")
    monkeypatch.setenv("HERMES_WEBUI_OIDC_ALLOW_CLAIM", "email")
    monkeypatch.setenv("HERMES_WEBUI_OIDC_ALLOW_VALUES", "allowed@example.com")
    private_key = ec.generate_private_key(ec.SECP256R1())
    token = {"value": ""}
    monkeypatch.setattr(auth_oidc, "_get_discovery_document", lambda _issuer: {
        "issuer": "https://issuer.example",
        "authorization_endpoint": "https://issuer.example/authorize",
        "token_endpoint": "https://issuer.example/token",
        "jwks_uri": "https://issuer.example/jwks",
    })
    monkeypatch.setattr(auth_oidc, "_post_form_json", lambda *_args, **_kwargs: {
        "id_token": token["value"]
    })
    monkeypatch.setattr(auth_oidc, "_get_jwks_document", lambda *_args, **_kwargs: {
        "keys": [ec_jwk(auth_oidc, private_key)]
    })
    return private_key, token


@pytest.mark.parametrize(
    "callback",
    [
        "https://attacker.example/oidc-callback",
        "javascript:alert(1)",
        "evilapp://oidc-callback",
        "talaria://wrong-host",
        "talaria://oidc-callback/extra",
        "talaria://user@oidc-callback",
        "talaria://oidc-callback?code=seeded",
    ],
)
def test_native_start_rejects_unsafe_callback_urls(callback):
    import api.auth_oidc as auth_oidc

    _, challenge = pkce_pair()
    with pytest.raises(auth_oidc.OIDCAuthError, match="callback"):
        auth_oidc.begin_native_authorization(
            "https://server.example", callback, "app-state-123456", challenge
        )


def test_native_exchange_is_server_flow_state_and_pkce_bound_and_single_use():
    import api.auth_oidc as auth_oidc

    start, verifier = begin_flow(auth_oidc)
    callback = auth_oidc.finish_native_authorization(
        "https://server.example",
        start["flow_id"],
        subject="user-123",
        email="user@example.com",
    )
    query = parse_qs(urlparse(callback).query)

    assert query["state"] == ["app-state-123456"]
    assert query["flow_id"] == [start["flow_id"]]
    assert query["server_id"] == [start["server_id"]]
    assert "session" not in callback.lower()
    assert "token" not in callback.lower()

    result = auth_oidc.exchange_native_authorization(
        "https://server.example",
        query["flow_id"][0],
        query["code"][0],
        query["state"][0],
        verifier,
    )
    assert result == {
        "subject": "user-123",
        "email": "user@example.com",
        "bound_profile": None,
    }
    with pytest.raises(auth_oidc.OIDCAuthError, match="Invalid or expired"):
        auth_oidc.exchange_native_authorization(
            "https://server.example",
            query["flow_id"][0],
            query["code"][0],
            query["state"][0],
            verifier,
        )


def test_provider_authorization_state_is_linked_to_exact_native_flow(monkeypatch):
    import api.auth_oidc as auth_oidc

    start, _ = begin_flow(auth_oidc)
    monkeypatch.setattr(
        auth_oidc,
        "_require_oidc_config",
        lambda: {
            "issuer": "https://issuer.example",
            "client_id": "client",
            "client_secret": "",
            "redirect_uri": "",
            "scopes": ["openid"],
        },
    )
    monkeypatch.setattr(
        auth_oidc,
        "_get_discovery_document",
        lambda _issuer: {"authorization_endpoint": "https://issuer.example/authorize"},
    )

    redirect = auth_oidc.build_authorization_redirect(
        "https://server.example", native_flow_id=start["flow_id"]
    )
    provider_state = parse_qs(urlparse(redirect).query)["state"][0]

    assert auth_oidc._pending_flows[provider_state]["native_flow_id"] == start["flow_id"]


def test_cancel_cannot_land_between_native_validation_and_provider_state_store(monkeypatch):
    import api.auth_oidc as auth_oidc

    start, _ = begin_flow(auth_oidc)
    entered_validation = threading.Event()
    release_validation = threading.Event()
    real_normalize = auth_oidc._normalize_server_origin

    def blocking_normalize(value):
        entered_validation.set()
        assert release_validation.wait(timeout=2)
        return real_normalize(value)

    monkeypatch.setattr(auth_oidc, "_normalize_server_origin", blocking_normalize)
    errors = []

    def store_provider_state():
        try:
            auth_oidc._store_pending_flow(
                "provider-state",
                {
                    "created_at": auth_oidc.time.time(),
                    "native_flow_id": start["flow_id"],
                },
                request_base_url="https://server.example",
            )
        except Exception as exc:  # pragma: no cover - surfaced by the assertion below
            errors.append(exc)

    store_thread = threading.Thread(target=store_provider_state)
    store_thread.start()
    assert entered_validation.wait(timeout=2)
    cancel_thread = threading.Thread(
        target=auth_oidc.cancel_native_authorization,
        args=(start["flow_id"], "app-state-123456"),
    )
    cancel_thread.start()
    release_validation.set()
    store_thread.join(timeout=2)
    cancel_thread.join(timeout=2)

    assert not store_thread.is_alive()
    assert not cancel_thread.is_alive()
    assert errors == []
    assert "provider-state" not in auth_oidc._pending_flows
    assert start["flow_id"] not in auth_oidc._native_flows


@pytest.mark.parametrize("payload", [{}, {"flow_id": "short", "state": "short"}])
def test_malformed_cancel_preserves_browser_and_native_state(payload):
    import api.auth_oidc as auth_oidc
    import api.routes as routes

    active, _ = begin_flow(auth_oidc)
    completed, _ = begin_flow(auth_oidc, state="exchange-state-123")
    callback = auth_oidc.finish_native_authorization(
        "https://server.example", completed["flow_id"], subject="user", email=""
    )
    exchange_code = parse_qs(urlparse(callback).query)["code"][0]
    auth_oidc._pending_flows.update({
        "browser-state": {"created_at": time.time(), "native_flow_id": None},
        "provider-state": {
            "created_at": time.time(),
            "native_flow_id": active["flow_id"],
        },
    })

    handler = post_json(routes, "/api/auth/oidc/native/cancel", payload)

    assert handler.status == 200
    assert handler.json_body() == {"ok": False}
    assert set(auth_oidc._pending_flows) == {"browser-state", "provider-state"}
    assert active["flow_id"] in auth_oidc._native_flows
    assert exchange_code in auth_oidc._native_exchange_codes


def test_native_start_capacity_preserves_live_flows_and_expiry_frees_space(monkeypatch):
    import api.auth_oidc as auth_oidc
    import api.routes as routes

    now = 1_000.0
    monkeypatch.setattr(auth_oidc, "_MAX_PENDING_FLOWS", 2)
    monkeypatch.setattr(auth_oidc.time, "time", lambda: now)
    first, _ = begin_flow(auth_oidc, state="first-capacity-state")
    second, _ = begin_flow(auth_oidc, state="second-capacity-state")
    _, challenge = pkce_pair("third-capacity-state")
    payload = {
        "callback_url": "talaria://oidc-callback",
        "state": "third-capacity-state",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }

    saturated = post_json(routes, "/api/auth/oidc/native/start", payload)

    assert saturated.status == 429
    assert set(auth_oidc._native_flows) == {first["flow_id"], second["flow_id"]}

    now += auth_oidc._NATIVE_FLOW_TTL_SECONDS + 1
    admitted = post_json(routes, "/api/auth/oidc/native/start", payload)

    assert admitted.status == 200
    assert set(auth_oidc._native_flows) == {admitted.json_body()["flow_id"]}


def test_wrong_server_or_verifier_consumes_only_that_exchange_code():
    import api.auth_oidc as auth_oidc

    first, first_verifier = begin_flow(auth_oidc, state="first-state-123456")
    second, second_verifier = begin_flow(auth_oidc, state="second-state-12345")
    third, third_verifier = begin_flow(auth_oidc, state="third-state-123456")
    first_query = parse_qs(urlparse(auth_oidc.finish_native_authorization(
        "https://server.example", first["flow_id"], subject="first", email=""
    )).query)
    second_query = parse_qs(urlparse(auth_oidc.finish_native_authorization(
        "https://server.example", second["flow_id"], subject="second", email=""
    )).query)
    third_query = parse_qs(urlparse(auth_oidc.finish_native_authorization(
        "https://server.example", third["flow_id"], subject="third", email=""
    )).query)

    with pytest.raises(auth_oidc.OIDCAuthError, match="server"):
        auth_oidc.exchange_native_authorization(
            "https://other.example",
            first["flow_id"],
            first_query["code"][0],
            "first-state-123456",
            first_verifier,
        )
    with pytest.raises(auth_oidc.OIDCAuthError, match="Invalid or expired"):
        auth_oidc.exchange_native_authorization(
            "https://server.example",
            first["flow_id"],
            first_query["code"][0],
            "first-state-123456",
            first_verifier,
        )

    assert auth_oidc.exchange_native_authorization(
        "https://server.example",
        second["flow_id"],
        second_query["code"][0],
        "second-state-12345",
        second_verifier,
    )["subject"] == "second"

    with pytest.raises(auth_oidc.OIDCAuthError, match="PKCE"):
        auth_oidc.exchange_native_authorization(
            "https://server.example",
            third["flow_id"],
            third_query["code"][0],
            "third-state-123456",
            third_verifier[:-1] + ("A" if third_verifier[-1] != "A" else "B"),
        )
    with pytest.raises(auth_oidc.OIDCAuthError, match="Invalid or expired"):
        auth_oidc.exchange_native_authorization(
            "https://server.example",
            third["flow_id"],
            third_query["code"][0],
            "third-state-123456",
            third_verifier,
        )


def test_wrong_state_flow_and_cross_wired_concurrent_codes_fail_closed():
    import api.auth_oidc as auth_oidc

    wrong_state, wrong_state_verifier = begin_flow(auth_oidc, state="wrong-state-target")
    wrong_state_query = parse_qs(urlparse(auth_oidc.finish_native_authorization(
        "https://server.example", wrong_state["flow_id"], subject="state", email=""
    )).query)
    with pytest.raises(auth_oidc.OIDCAuthError, match="state"):
        auth_oidc.exchange_native_authorization(
            "https://server.example",
            wrong_state["flow_id"],
            wrong_state_query["code"][0],
            "different-state-123",
            wrong_state_verifier,
        )
    with pytest.raises(auth_oidc.OIDCAuthError, match="Invalid or expired"):
        auth_oidc.exchange_native_authorization(
            "https://server.example",
            wrong_state["flow_id"],
            wrong_state_query["code"][0],
            "wrong-state-target",
            wrong_state_verifier,
        )

    first, first_verifier = begin_flow(auth_oidc, state="cross-first-state")
    second, second_verifier = begin_flow(auth_oidc, state="cross-second-state")
    first_query = parse_qs(urlparse(auth_oidc.finish_native_authorization(
        "https://server.example", first["flow_id"], subject="first", email=""
    )).query)
    second_query = parse_qs(urlparse(auth_oidc.finish_native_authorization(
        "https://server.example", second["flow_id"], subject="second", email=""
    )).query)

    with pytest.raises(auth_oidc.OIDCAuthError, match="flow"):
        auth_oidc.exchange_native_authorization(
            "https://server.example",
            second["flow_id"],
            first_query["code"][0],
            "cross-first-state",
            first_verifier,
        )
    assert auth_oidc.exchange_native_authorization(
        "https://server.example",
        second["flow_id"],
        second_query["code"][0],
        "cross-second-state",
        second_verifier,
    )["subject"] == "second"


def test_cancel_and_expiry_cannot_be_reused(monkeypatch):
    import api.auth_oidc as auth_oidc

    now = 1_000.0
    monkeypatch.setattr(auth_oidc.time, "time", lambda: now)
    cancelled, _ = begin_flow(auth_oidc, state="cancel-state-12345")
    assert auth_oidc.cancel_native_authorization(cancelled["flow_id"], "cancel-state-12345")
    with pytest.raises(auth_oidc.OIDCAuthError, match="Invalid or expired"):
        auth_oidc.finish_native_authorization(
            "https://server.example", cancelled["flow_id"], subject="user", email=""
        )

    expired, _ = begin_flow(auth_oidc, state="expiry-state-12345")
    now += auth_oidc._NATIVE_FLOW_TTL_SECONDS + 1
    with pytest.raises(auth_oidc.OIDCAuthError, match="Invalid or expired"):
        auth_oidc.finish_native_authorization(
            "https://server.example", expired["flow_id"], subject="user", email=""
        )

    exchange, verifier = begin_flow(auth_oidc, state="exchange-state-123")
    callback = auth_oidc.finish_native_authorization(
        "https://server.example", exchange["flow_id"], subject="user", email=""
    )
    query = parse_qs(urlparse(callback).query)
    now += auth_oidc._NATIVE_EXCHANGE_TTL_SECONDS + 1
    with pytest.raises(auth_oidc.OIDCAuthError, match="Invalid or expired"):
        auth_oidc.exchange_native_authorization(
            "https://server.example",
            exchange["flow_id"],
            query["code"][0],
            "exchange-state-123",
            verifier,
        )


def test_cancel_after_provider_success_invalidates_exchange_code():
    import api.auth_oidc as auth_oidc

    start, verifier = begin_flow(auth_oidc, state="cancel-code-state")
    callback = auth_oidc.finish_native_authorization(
        "https://server.example", start["flow_id"], subject="user", email=""
    )
    query = parse_qs(urlparse(callback).query)

    assert not auth_oidc.cancel_native_authorization(start["flow_id"], "wrong-state-12345")
    assert query["code"][0] in auth_oidc._native_exchange_codes
    assert auth_oidc.cancel_native_authorization(start["flow_id"], "cancel-code-state")
    with pytest.raises(auth_oidc.OIDCAuthError, match="Invalid or expired"):
        auth_oidc.exchange_native_authorization(
            "https://server.example",
            start["flow_id"],
            query["code"][0],
            "cancel-code-state",
            verifier,
        )


def test_auth_status_advertises_native_handoff_only_with_oidc(monkeypatch):
    import api.auth as auth
    import api.passkeys as passkeys
    import api.routes as routes

    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    monkeypatch.setattr(auth, "is_oidc_auth_enabled", lambda: True)
    monkeypatch.setattr(auth, "_passkey_feature_flag_enabled", lambda: False)
    monkeypatch.setattr(auth, "get_password_hash", lambda: None)
    monkeypatch.setattr(auth, "parse_cookie", lambda _handler: None)
    monkeypatch.setattr(passkeys, "registered_credentials", lambda: [])

    handler = RouteFakeHandler()
    routes.handle_get(handler, urlparse("https://server.example/api/auth/status"))

    assert handler.status == 200
    assert handler.json_body()["oidc_native_handoff_enabled"] is True


def test_native_exchange_route_sets_normal_http_only_session_cookie():
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.routes as routes

    start, verifier = begin_flow(auth_oidc, origin="http://server.example")
    callback = auth_oidc.finish_native_authorization(
        "http://server.example",
        start["flow_id"],
        subject="user-123",
        email="user@example.com",
    )
    query = parse_qs(urlparse(callback).query)
    body = json.dumps({
        "flow_id": start["flow_id"],
        "code": query["code"][0],
        "state": "app-state-123456",
        "code_verifier": verifier,
    }).encode()

    handler = RouteFakeHandler()
    handler.rfile = io.BytesIO(body)
    handler.headers["Content-Length"] = str(len(body))
    routes.handle_post(handler, SimpleNamespace(path="/api/auth/oidc/native/exchange"))

    assert handler.status == 200
    assert handler.json_body() == {"ok": True}
    [cookie] = handler.header_values("Set-Cookie")
    assert auth.COOKIE_NAME in cookie
    assert "HttpOnly" in cookie
    cookie_value = cookie.split(";", 1)[0].split("=", 1)[1]
    assert auth.verify_session(cookie_value)
    session_info = auth.get_session_info(cookie_value)
    assert session_info["auth_type"] == "oidc"
    assert session_info["username"] == "user@example.com"
    assert session_info["bound_profile"] is None
    auth.invalidate_session(cookie_value)


def test_composed_native_route_flow_redirects_bounded_handoff_then_sets_cookie(monkeypatch):
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.routes as routes

    private_key, token = configure_route_flow(monkeypatch, auth_oidc)
    verifier, challenge = pkce_pair("composed-success")
    start_handler = post_json(routes, "/api/auth/oidc/native/start", {
        "callback_url": "talaria://oidc-callback",
        "state": "composed-success-state",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    assert start_handler.status == 200
    start = start_handler.json_body()

    browser_handler = RouteFakeHandler()
    routes.handle_get(browser_handler, urlparse(start["authorization_url"]))
    assert browser_handler.status == 302
    [provider_location] = browser_handler.header_values("Location")
    provider_query = parse_qs(urlparse(provider_location).query)
    token["value"] = signed_id_token(
        auth_oidc, private_key, provider_query["nonce"][0], "allowed@example.com"
    )

    callback_handler = RouteFakeHandler()
    routes.handle_get(callback_handler, SimpleNamespace(
        path="/api/auth/oidc/callback",
        query=f"state={provider_query['state'][0]}&code=synthetic-code",
    ))

    assert callback_handler.status == 302
    assert callback_handler.header_values("Set-Cookie") == []
    [app_location] = callback_handler.header_values("Location")
    handoff = parse_qs(urlparse(app_location).query)
    assert set(handoff) == {"code", "state", "flow_id", "server_id"}
    assert handoff["state"] == ["composed-success-state"]
    assert handoff["flow_id"] == [start["flow_id"]]
    assert handoff["server_id"] == [start["server_id"]]

    exchange_handler = post_json(routes, "/api/auth/oidc/native/exchange", {
        "flow_id": start["flow_id"],
        "code": handoff["code"][0],
        "state": "composed-success-state",
        "code_verifier": verifier,
    })

    assert exchange_handler.status == 200
    [cookie] = exchange_handler.header_values("Set-Cookie")
    assert "HttpOnly" in cookie
    cookie_value = cookie.split(";", 1)[0].split("=", 1)[1]
    assert auth.verify_session(cookie_value)
    assert auth.get_session_info(cookie_value)["username"] == "allowed@example.com"
    auth.invalidate_session(cookie_value)


def test_composed_native_route_flow_sanitizes_allowlist_failure_and_consumes_state(monkeypatch):
    import api.auth_oidc as auth_oidc
    import api.routes as routes

    private_key, token = configure_route_flow(monkeypatch, auth_oidc)
    _, challenge = pkce_pair("composed-failure")
    start_handler = post_json(routes, "/api/auth/oidc/native/start", {
        "callback_url": "talaria://oidc-callback",
        "state": "composed-failure-state",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    start = start_handler.json_body()
    browser_handler = RouteFakeHandler()
    routes.handle_get(browser_handler, urlparse(start["authorization_url"]))
    [provider_location] = browser_handler.header_values("Location")
    provider_query = parse_qs(urlparse(provider_location).query)
    provider_state = provider_query["state"][0]
    token["value"] = signed_id_token(
        auth_oidc, private_key, provider_query["nonce"][0], "denied@example.com"
    )

    callback_handler = RouteFakeHandler()
    routes.handle_get(callback_handler, SimpleNamespace(
        path="/api/auth/oidc/callback",
        query=f"state={provider_state}&code=provider-secret-code",
    ))

    assert callback_handler.status == 302
    assert callback_handler.header_values("Set-Cookie") == []
    [app_location] = callback_handler.header_values("Location")
    callback = parse_qs(urlparse(app_location).query)
    assert set(callback) == {"error", "state", "flow_id", "server_id"}
    assert callback["error"] == ["authentication_failed"]
    assert callback["state"] == ["composed-failure-state"]
    assert "provider-secret-code" not in app_location
    assert "denied@example.com" not in app_location
    assert provider_state not in auth_oidc._pending_flows
    assert start["flow_id"] not in auth_oidc._native_flows


def test_provider_error_returns_sanitized_native_callback(monkeypatch):
    import api.auth_oidc as auth_oidc
    import api.routes as routes

    monkeypatch.setenv("HERMES_WEBUI_SECURE", "1")
    start, _ = begin_flow(auth_oidc)
    auth_oidc._store_pending_flow(
        "provider-state",
        {
            "created_at": auth_oidc.time.time(),
            "native_flow_id": start["flow_id"],
        },
        request_base_url="https://server.example",
    )
    handler = RouteFakeHandler()

    routes.handle_get(
        handler,
        SimpleNamespace(
            path="/api/auth/oidc/callback",
            query="state=provider-state&error=access_denied&error_description=secret+provider+detail",
        ),
    )

    assert handler.status == 302
    [location] = handler.header_values("Location")
    query = parse_qs(urlparse(location).query)
    assert query["error"] == ["provider_error"]
    assert query["state"] == ["app-state-123456"]
    assert "secret" not in location
    assert handler.header_values("Set-Cookie") == []
