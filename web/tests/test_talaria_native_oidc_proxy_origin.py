import base64
import hashlib
import io
import json
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest


class FakeHandler:
    def __init__(self, headers=None, body=None):
        payload = json.dumps(body or {}).encode()
        self.headers = {
            "Host": "internal.example:8787",
            "Content-Length": str(len(payload)),
            **(headers or {}),
        }
        self.rfile = io.BytesIO(payload)
        self.wfile = io.BytesIO()
        self.request = SimpleNamespace()
        self.client_address = ("127.0.0.1", 12345)
        self.status = None
        self.sent_headers = []

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.sent_headers.append((key, value))

    def end_headers(self):
        pass

    def json_body(self):
        return json.loads(self.wfile.getvalue())


@pytest.fixture(autouse=True)
def oidc_origin_environment(monkeypatch):
    import api.auth_oidc as auth_oidc
    import api.routes as routes

    for name in (
        "HERMES_WEBUI_OIDC_REDIRECT_URI",
        "HERMES_WEBUI_SECURE",
        "HERMES_WEBUI_TRUST_FORWARDED_FOR",
        "HERMES_WEBUI_TRUST_FORWARDED_HOST",
        "HERMES_WEBUI_TRUST_FORWARDED_PROTO",
        "HERMES_WEBUI_TRUSTED_PROXY_CIDRS",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(auth_oidc, "_resolve_oidc_config", lambda: {"redirect_uri": ""})
    monkeypatch.setattr(auth_oidc, "is_oidc_enabled", lambda: True)
    auth_oidc._native_flows.clear()
    routes._NATIVE_OIDC_START_RATE_LIMIT.clear()
    yield
    auth_oidc._native_flows.clear()
    routes._NATIVE_OIDC_START_RATE_LIMIT.clear()


def test_direct_host_is_the_request_origin():
    from api.routes import _request_base_url

    assert _request_base_url(FakeHandler()) == "http://internal.example:8787"


def test_untrusted_forwarded_origin_is_ignored():
    from api.routes import _request_base_url

    handler = FakeHandler({
        "X-Forwarded-Host": "public.example",
        "X-Forwarded-Proto": "https",
    })

    assert _request_base_url(handler) == "http://internal.example:8787"


def test_trusted_forwarded_host_and_proto_define_the_public_origin(monkeypatch):
    from api.routes import _request_base_url

    monkeypatch.setenv("HERMES_WEBUI_TRUST_FORWARDED_HOST", "1")
    monkeypatch.setenv("HERMES_WEBUI_TRUST_FORWARDED_PROTO", "1")
    handler = FakeHandler({
        "X-Forwarded-Host": "public.example:8443",
        "X-Forwarded-Proto": "https",
    })

    assert _request_base_url(handler) == "https://public.example:8443"


@pytest.mark.parametrize(
    "forwarded_headers",
    [
        {"X-Forwarded-Host": "public.example, attacker.example"},
        {"X-Forwarded-Host": "public.example", "X-Real-Host": "attacker.example"},
        {"X-Forwarded-Host": "[broken"},
    ],
)
def test_invalid_or_ambiguous_trusted_forwarded_host_falls_back_to_direct_host(
    monkeypatch, forwarded_headers
):
    from api.routes import _request_base_url

    monkeypatch.setenv("HERMES_WEBUI_TRUST_FORWARDED_HOST", "1")

    assert _request_base_url(FakeHandler(forwarded_headers)) == "http://internal.example:8787"


def test_configured_redirect_uri_is_the_authoritative_public_origin(monkeypatch):
    import api.auth_oidc as auth_oidc
    from api.routes import _request_base_url

    monkeypatch.setattr(
        auth_oidc,
        "_resolve_oidc_config",
        lambda: {"redirect_uri": "https://public.example:8443/api/auth/oidc/callback"},
    )

    assert _request_base_url(FakeHandler()) == "https://public.example:8443"


def test_native_start_uses_the_trusted_public_origin_for_url_and_server_id(monkeypatch):
    import api.auth_oidc as auth_oidc
    import api.routes as routes

    monkeypatch.setenv("HERMES_WEBUI_TRUST_FORWARDED_HOST", "1")
    monkeypatch.setenv("HERMES_WEBUI_TRUST_FORWARDED_PROTO", "1")
    verifier = base64.urlsafe_b64encode(hashlib.sha256(b"proxy-origin").digest()).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    handler = FakeHandler(
        {
            "X-Forwarded-Host": "public.example",
            "X-Forwarded-Proto": "https",
        },
        {
            "callback_url": "talaria://oidc-callback",
            "state": "proxy-origin-state",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
    )

    routes.handle_post(handler, SimpleNamespace(path="/api/auth/oidc/native/start"))

    result = handler.json_body()
    assert handler.status == 200
    assert urlsplit(result["authorization_url"]).netloc == "public.example"
    assert result["server_id"] == auth_oidc._server_identity("https://public.example")


def test_native_start_preserves_configured_reverse_proxy_subpath(monkeypatch):
    import api.auth_oidc as auth_oidc
    import api.routes as routes

    monkeypatch.setattr(
        auth_oidc,
        "_resolve_oidc_config",
        lambda: {
            "redirect_uri": "https://public.example/hermes/api/auth/oidc/callback"
        },
    )
    handler = _native_start_handler("203.0.113.30")

    routes.handle_post(handler, SimpleNamespace(path="/api/auth/oidc/native/start"))

    result = handler.json_body()
    assert handler.status == 200
    assert result["authorization_url"].startswith(
        "https://public.example/hermes/api/auth/oidc/start?"
    )
    assert result["server_id"] == auth_oidc._server_identity("https://public.example")


def _native_start_handler(client_ip):
    verifier = base64.urlsafe_b64encode(hashlib.sha256(b"rate-limit").digest()).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    handler = FakeHandler(body={
        "callback_url": "talaria://oidc-callback",
        "state": "rate-limit-state",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    handler.client_address = (client_ip, 12345)
    return handler


def test_native_start_rate_limit_is_per_client_and_rejection_allocates_no_flow(monkeypatch):
    import api.auth_oidc as auth_oidc
    import api.routes as routes

    monkeypatch.setattr(routes, "_NATIVE_OIDC_START_RATE_LIMIT_MAX", 1)
    first = _native_start_handler("203.0.113.10")
    routes.handle_post(first, SimpleNamespace(path="/api/auth/oidc/native/start"))
    assert first.status == 200
    assert len(auth_oidc._native_flows) == 1

    rejected = _native_start_handler("203.0.113.10")
    routes.handle_post(rejected, SimpleNamespace(path="/api/auth/oidc/native/start"))
    assert rejected.status == 429
    assert len(auth_oidc._native_flows) == 1

    other_client = _native_start_handler("203.0.113.11")
    routes.handle_post(other_client, SimpleNamespace(path="/api/auth/oidc/native/start"))
    assert other_client.status == 200
    assert len(auth_oidc._native_flows) == 2


def test_native_start_rate_limit_resets_after_window(monkeypatch):
    import api.routes as routes

    monkeypatch.setattr(routes, "_NATIVE_OIDC_START_RATE_LIMIT_MAX", 1)
    handler = _native_start_handler("203.0.113.12")
    now = 1_000.0

    assert not routes._native_oidc_start_rate_limited(handler, now=now)
    assert routes._native_oidc_start_rate_limited(handler, now=now + 1)
    assert not routes._native_oidc_start_rate_limited(
        handler,
        now=now + routes._NATIVE_OIDC_START_RATE_LIMIT_WINDOW_SECONDS + 1,
    )


def test_native_start_rate_limit_uses_forwarded_client_only_from_trusted_proxy(monkeypatch):
    import api.routes as routes

    monkeypatch.setattr(routes, "_NATIVE_OIDC_START_RATE_LIMIT_MAX", 1)
    monkeypatch.setenv("HERMES_WEBUI_TRUST_FORWARDED_FOR", "1")
    first = _native_start_handler("127.0.0.1")
    first.headers["X-Forwarded-For"] = "203.0.113.20"
    second = _native_start_handler("127.0.0.1")
    second.headers["X-Forwarded-For"] = "203.0.113.21"

    assert not routes._native_oidc_start_rate_limited(first, now=1_000.0)
    assert routes._native_oidc_start_rate_limited(first, now=1_001.0)
    assert not routes._native_oidc_start_rate_limited(second, now=1_001.0)

    untrusted = _native_start_handler("198.51.100.10")
    untrusted.headers["X-Forwarded-For"] = "203.0.113.22"
    spoofed = _native_start_handler("198.51.100.10")
    spoofed.headers["X-Forwarded-For"] = "203.0.113.23"

    assert not routes._native_oidc_start_rate_limited(untrusted, now=1_000.0)
    assert routes._native_oidc_start_rate_limited(spoofed, now=1_001.0)
