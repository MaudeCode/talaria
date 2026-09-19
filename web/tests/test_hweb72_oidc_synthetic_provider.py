"""HWEB-72 — browser and HTTP OIDC login against a test-owned provider over TLS.

Everything the WebUI talks to here is synthetic and fixture-owned: a stdlib
``ThreadingHTTPServer`` identity provider on loopback HTTPS (discovery,
authorize, token, JWKS; ES256 tokens signed with ``cryptography``), a private
CA whose leaf certificates front both the provider and a real ``server.py``
child started with ``HERMES_WEBUI_TLS_CERT/KEY``, and headless Chromium.

Trust is established the way an operator would do it, not by patching product
code: the child trusts the temporary CA through ``SSL_CERT_FILE`` and opts the
loopback issuer host into ``webui_oidc.trusted_private_hosts``. The Chromium
context ignores certificate errors for the generated leaf; that is the only
certificate exception, it is confined to this test context, and nothing here
claims browser trust-store coverage.

Issuer host: ``idp.localhost``. Chromium, glibc/systemd-resolved and macOS all
resolve ``*.localhost`` to loopback without touching DNS, and the product
deliberately refuses to trust the bare ``localhost`` name.

Local run::

    ./scripts/test.sh tests/test_hweb72_oidc_synthetic_provider.py -v

Playwright + Chromium missing locally -> the module skips. In CI
(``GITHUB_ACTIONS``) or with ``HERMES_WEBUI_OIDC_E2E_REQUIRED=1`` every missing
prerequisite, failed boot or missing provider traffic is a hard failure.
Server log, provider request log and failure screenshots land under the
pytest basetemp (``pytest --basetemp`` / ``/tmp/pytest-of-<user>/``).
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import http.cookies
import http.server
import ipaddress
import json
import os
import pathlib
import secrets
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

REPO = pathlib.Path(__file__).resolve().parents[1]
IDP_HOST = "idp.localhost"
WEBUI_HOST = "localhost"
CLIENT_ID = "hermes-webui-synthetic-client"
ALLOW_GROUP = "hermes-users"
SESSION_COOKIE = "hermes_session"
PROFILE_COOKIE = "hermes_profile"
NATIVE_CALLBACK = "talaria://oidc-callback"
REQUIRED = bool(os.environ.get("GITHUB_ACTIONS") or os.environ.get("HERMES_WEBUI_OIDC_E2E_REQUIRED"))

IDENTITIES = {
    "alice": {"sub": "sub-alice", "email": "alice@synthetic.test", "groups": [ALLOW_GROUP]},
    "bob": {"sub": "sub-bob", "email": "bob@synthetic.test", "groups": [ALLOW_GROUP]},
    "root": {"sub": "sub-root", "email": "root@synthetic.test", "groups": [ALLOW_GROUP]},
    "mallory": {"sub": "sub-mallory", "email": "mallory@synthetic.test", "groups": ["outsiders"]},
    "nogroup": {"sub": "sub-nogroup", "email": "nogroup@synthetic.test"},
    "unmapped": {"sub": "sub-unmapped", "email": "unmapped@synthetic.test", "groups": [ALLOW_GROUP]},
}
# mallory and nogroup are mapped on purpose: admission must be the only thing
# that keeps them out, so bypassing the allowlist cannot hide behind the map.
PROFILE_MAP = {"sub-alice": "alice", "sub-bob": "bob", "sub-root": "default", "sub-mallory": "alice", "sub-nogroup": "bob"}
MARKERS = {"default": "HWEB72-MARKER-default", "alice": "HWEB72-MARKER-alice", "bob": "HWEB72-MARKER-bob"}


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _free_port() -> int:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _prerequisite_failed(message: str):
    if REQUIRED:
        pytest.fail(message)
    pytest.skip(message)


# ── PKI ──────────────────────────────────────────────────────────────────────

def _key_usage(**flags: bool) -> x509.KeyUsage:
    names = ("digital_signature", "content_commitment", "key_encipherment", "data_encipherment",
             "key_agreement", "key_cert_sign", "crl_sign", "encipher_only", "decipher_only")
    return x509.KeyUsage(**{name: flags.get(name, False) for name in names})


def _make_pki(out: pathlib.Path) -> dict[str, str]:
    now = dt.datetime.now(dt.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "HWEB-72 synthetic test CA")])

    def builder(subject):
        return (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(ca_name)
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=1))
        )

    ca_cert = (
        builder(ca_name)
        .public_key(ca_key.public_key())
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(_key_usage(key_cert_sign=True, crl_sign=True), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    # OpenSSL 3 rejects a chain whose leaf lacks an Authority Key Identifier.
    authority_key_id = x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key())
    paths = {"ca": str(out / "ca.pem")}
    (out / "ca.pem").write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))

    def leaf(name: str, sans: list) -> None:
        key = ec.generate_private_key(ec.SECP256R1())
        cert = (
            builder(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)]))
            .public_key(key.public_key())
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(_key_usage(digital_signature=True, key_agreement=True), critical=True)
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(authority_key_id, critical=False)
            .sign(ca_key, hashes.SHA256())
        )
        (out / f"{name}.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (out / f"{name}-key.pem").write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        paths[f"{name}_cert"] = str(out / f"{name}.pem")
        paths[f"{name}_key"] = str(out / f"{name}-key.pem")

    leaf("idp", [x509.DNSName(IDP_HOST)])
    leaf("webui", [x509.DNSName(WEBUI_HOST), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))])
    return paths


# ── Synthetic provider ──────────────────────────────────────────────────────

def _ec_jwk(kid: str, key) -> dict:
    numbers = key.public_key().public_numbers()
    return {
        "kty": "EC", "crv": "P-256", "use": "sig", "alg": "ES256", "kid": kid,
        "x": _b64u(numbers.x.to_bytes(32, "big")), "y": _b64u(numbers.y.to_bytes(32, "big")),
    }


def _sign_es256(key, kid: str, claims: dict) -> str:
    header = _b64u(json.dumps({"alg": "ES256", "typ": "JWT", "kid": kid}).encode())
    payload = _b64u(json.dumps(claims).encode())
    signing_input = f"{header}.{payload}"
    r, s = utils.decode_dss_signature(key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256())))
    return f"{signing_input}.{_b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


class SyntheticProvider:
    """Loopback HTTPS OpenID provider with fixture-controlled scenarios."""

    def __init__(self, certfile: str, keyfile: str):
        self.port = _free_port()
        self.issuer = f"https://{IDP_HOST}:{self.port}"
        self.lock = threading.Lock()
        self.keys = [("kid-1", ec.generate_private_key(ec.SECP256R1()))]
        self.redirect_uris: set[str] = set()
        self.codes: dict[str, dict] = {}
        self.requests: list[str] = []
        self.issued_tokens: list[str] = []  # every id_token and access_token value ever minted
        self.reset()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile, keyfile)
        self.httpd = _TLSServer(("127.0.0.1", self.port), _ProviderHandler, ctx, self)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True, name="hweb72-idp")
        self.thread.start()

    def reset(self) -> None:
        """Scenario controls. Only the fixture touches these, never a product route."""
        self.identity = "alice"
        self.authorize_error: str | None = None
        self.claim_overrides: dict = {}
        self.sign_with: tuple | None = None          # (kid, private_key) rogue signer
        self.token_response: tuple[int, bytes] | None = None  # one-shot raw token reply
        self.jwks_response: bytes | None = None       # raw JWKS reply while set

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def rotate_key(self) -> str:
        kid = f"kid-{len(self.keys) + 1}"
        with self.lock:
            self.keys.append((kid, ec.generate_private_key(ec.SECP256R1())))
        return kid

    def count(self, entry: str) -> int:
        return self.requests.count(entry)

    def mint_id_token(self, record: dict) -> str:
        now = int(time.time())
        claims = {
            "iss": self.issuer, "aud": CLIENT_ID, "iat": now, "exp": now + 300,
            "nonce": record["nonce"], **IDENTITIES[record["identity"]], **record["claims"],
        }
        kid, key = record["signer"]
        return _sign_es256(key, kid, claims)


class _TLSServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, ssl_context, provider):
        super().__init__(addr, handler)
        self.ssl_context = ssl_context
        self.provider = provider

    def handle_error(self, request, client_address):
        # Chromium preconnects and drops sockets; an aborted handshake is noise.
        if not isinstance(sys.exc_info()[1], (ssl.SSLError, ConnectionError, TimeoutError)):
            super().handle_error(request, client_address)


class _ProviderHandler(http.server.BaseHTTPRequestHandler):
    def setup(self):
        # Per-connection handshake in the request thread so an idle socket can
        # never stall the accept loop.
        self.request = self.server.ssl_context.wrap_socket(self.request, server_side=True)
        super().setup()

    def log_message(self, *args):
        pass

    def _reply(self, status: int, body: bytes, content_type="application/json", location=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if location:
            self.send_header("Location", location)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict):
        self._reply(status, json.dumps(payload).encode())

    def do_GET(self):
        p = self.server.provider
        parsed = urllib.parse.urlsplit(self.path)
        p.requests.append(f"GET {parsed.path}")
        if parsed.path == "/.well-known/openid-configuration":
            return self._json(200, {
                "issuer": p.issuer,
                "authorization_endpoint": p.issuer + "/authorize",
                "token_endpoint": p.issuer + "/token",
                "jwks_uri": p.issuer + "/jwks",
                "response_types_supported": ["code"],
                "id_token_signing_alg_values_supported": ["ES256"],
                "code_challenge_methods_supported": ["S256"],
            })
        if parsed.path == "/jwks":
            if p.jwks_response is not None:
                return self._reply(200, p.jwks_response)
            with p.lock:
                keys = [_ec_jwk(kid, key) for kid, key in p.keys]
            return self._json(200, {"keys": keys})
        if parsed.path == "/authorize":
            return self._authorize(urllib.parse.parse_qs(parsed.query))
        self._json(404, {"error": "not_found"})

    def _authorize(self, query: dict):
        p = self.server.provider
        get = lambda name: query.get(name, [""])[0]  # noqa: E731
        redirect_uri = get("redirect_uri")
        problems = []
        if get("response_type") != "code":
            problems.append("response_type must be code")
        if get("client_id") != CLIENT_ID:
            problems.append("unknown client_id")
        if redirect_uri not in p.redirect_uris:
            problems.append(f"unregistered redirect_uri {redirect_uri!r}")
        if get("code_challenge_method") != "S256" or len(get("code_challenge")) != 43:
            problems.append("S256 code_challenge required")
        if "openid" not in get("scope").split():
            problems.append("scope must include openid")
        if not get("state") or not get("nonce"):
            problems.append("state and nonce are required")
        if problems:
            # A malformed WebUI authorization request must surface loudly, never
            # as a redirect the client could mistake for progress.
            return self._reply(400, "\n".join(problems).encode(), content_type="text/plain")
        if p.authorize_error:
            params = {"error": p.authorize_error, "error_description": "synthetic provider declined", "state": get("state")}
            return self._reply(302, b"", location=redirect_uri + "?" + urllib.parse.urlencode(params))
        code = secrets.token_urlsafe(24)
        with p.lock:
            p.codes[code] = {
                "redirect_uri": redirect_uri, "nonce": get("nonce"), "challenge": get("code_challenge"),
                "identity": p.identity, "claims": dict(p.claim_overrides), "signer": p.sign_with or p.keys[-1],
            }
        location = redirect_uri + "?" + urllib.parse.urlencode({"code": code, "state": get("state")})
        self._reply(302, b"", location=location)

    def do_POST(self):
        p = self.server.provider
        parsed = urllib.parse.urlsplit(self.path)
        p.requests.append(f"POST {parsed.path}")
        if parsed.path != "/token":
            return self._json(404, {"error": "not_found"})
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        form = {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}
        if p.token_response is not None:
            status, body = p.token_response
            p.token_response = None
            return self._reply(status, body)
        with p.lock:
            record = p.codes.pop(form.get("code", ""), None)  # single use
        verifier = form.get("code_verifier", "")
        if (
            record is None
            or form.get("grant_type") != "authorization_code"
            or form.get("client_id") != CLIENT_ID
            or form.get("redirect_uri") != record["redirect_uri"]
            or _b64u(hashlib.sha256(verifier.encode("ascii")).digest()) != record["challenge"]
        ):
            return self._json(400, {"error": "invalid_grant"})
        id_token, access_token = p.mint_id_token(record), secrets.token_urlsafe(16)
        with p.lock:
            p.issued_tokens += [id_token, access_token]
        self._json(200, {"id_token": id_token, "access_token": access_token, "token_type": "Bearer"})


# ── HTTP client ─────────────────────────────────────────────────────────────

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Response:
    def __init__(self, status: int, headers, body: bytes):
        self.status, self.headers, self.body = status, headers, body

    def json(self) -> dict:
        return json.loads(self.body.decode("utf-8"))

    @property
    def location(self) -> str:
        return self.headers.get("Location") or ""

    def set_cookies(self) -> dict[str, http.cookies.Morsel]:
        jar = http.cookies.SimpleCookie()
        for header in self.headers.get_all("Set-Cookie") or []:
            jar.load(header)
        return dict(jar)


class HttpClient:
    """urllib client with an explicit cookie dict; never follows redirects."""

    def __init__(self, base: str, cafile: str, issuer: str = ""):
        self.base, self.issuer = base, issuer
        self.cookies: dict[str, str] = {}
        self.last_callback = ""
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=cafile)),
            urllib.request.ProxyHandler({}),  # loopback only; ignore ambient *_PROXY
            _NoRedirect(),
        )

    def request(self, method: str, url: str, *, data=None, headers=None) -> Response:
        url = url if "://" in url else self.base + url
        hdrs = dict(headers or {})
        # Host-only cookies, like a browser: the WebUI jar never travels to the provider.
        same_origin = url.startswith(self.base + "/") or url == self.base
        if self.cookies and same_origin:
            hdrs["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        body = None
        if data is not None:
            body = json.dumps(data).encode()
            hdrs["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
        try:
            resp = self.opener.open(req, timeout=20)
        except urllib.error.HTTPError as exc:
            resp = exc
        response = Response(resp.status, resp.headers, resp.read())
        for name, morsel in (response.set_cookies().items() if same_origin else ()):
            if morsel.value and morsel["max-age"] != "0":
                self.cookies[name] = morsel.value
            else:
                self.cookies.pop(name, None)
        return response

    def get(self, url: str, **kw) -> Response:
        return self.request("GET", url, **kw)

    def post(self, url: str, data=None, **kw) -> Response:
        return self.request("POST", url, data=data if data is not None else {}, **kw)


# ── WebUI child ─────────────────────────────────────────────────────────────

class WebUI:
    def __init__(self, root: pathlib.Path, pki: dict[str, str], provider: SyntheticProvider):
        self.root, self.pki, self.provider = root, pki, provider
        self.state = root / "state"
        self.port = _free_port()
        self.base = f"https://{WEBUI_HOST}:{self.port}"
        self.log_path = root / "webui.log"
        self.proc: subprocess.Popen | None = None
        for sub in ("no-agent", "plugins", "workspace", "profiles/alice", "profiles/bob"):
            (self.state / sub).mkdir(parents=True, exist_ok=True)
        (self.state / "no-agent" / "run_agent.py").write_text("# agent-free sentinel\n")
        (self.state / "SOUL.md").write_text(MARKERS["default"] + "\n")
        for name in ("alice", "bob"):
            (self.state / "profiles" / name / "SOUL.md").write_text(MARKERS[name] + "\n")
        self.write_policy(PROFILE_MAP)
        provider.redirect_uris.add(self.base + "/api/auth/oidc/callback")

    def write_policy(self, profile_map: dict[str, str]) -> None:
        # JSON is valid YAML; this is the operator config the child reads.
        policy = {
            "webui_oidc": {
                "issuer": self.provider.issuer, "client_id": CLIENT_ID,
                "allow_claim": "groups", "allow_values": [ALLOW_GROUP],
                "profile_map": profile_map, "trusted_private_hosts": [IDP_HOST],
            }
        }
        (self.state / "config.yaml").write_text(json.dumps(policy, indent=2) + "\n")

    def _env(self) -> dict[str, str]:
        dropped = {"HERMES_WEBUI_PASSWORD", "HERMES_WEBUI_SECURE", "HERMES_WEBUI_TRUST_FORWARDED_PROTO",
                   "HERMES_WEBUI_GROUP_PROFILE_MAP", "HERMES_MODEL", "OPENAI_MODEL", "LLM_MODEL",
                   # The module hard-codes the default cookie names.
                   "HERMES_WEBUI_COOKIE_NAME", "HERMES_WEBUI_PROFILE_COOKIE_NAME", "WEBUI_PROFILE_COOKIE_NAME"}
        env = {
            k: v for k, v in os.environ.items()
            if not (k.endswith("_API_KEY") or k.startswith("HERMES_WEBUI_OIDC_")
                    or k.startswith("HERMES_WEBUI_TRUSTED_") or k.upper().endswith("_PROXY") or k in dropped)
        }
        env.update({
            "HERMES_WEBUI_PORT": str(self.port), "HERMES_WEBUI_HOST": "127.0.0.1",
            "HERMES_WEBUI_TLS_CERT": self.pki["webui_cert"], "HERMES_WEBUI_TLS_KEY": self.pki["webui_key"],
            "SSL_CERT_FILE": self.pki["ca"],
            "HERMES_WEBUI_STATE_DIR": str(self.state), "HERMES_HOME": str(self.state),
            "HERMES_BASE_HOME": str(self.state), "HERMES_CONFIG_PATH": str(self.state / "config.yaml"),
            "HERMES_WEBUI_DEFAULT_WORKSPACE": str(self.state / "workspace"),
            "HERMES_WEBUI_PLUGINS_DIR": str(self.state / "plugins"),
            "HERMES_WEBUI_AGENT_DIR": str(self.state / "no-agent"),
            "HERMES_WEBUI_PYTHON": sys.executable, "HERMES_WEBUI_SKIP_ONBOARDING": "1",
            # Belt and braces with the *_PROXY strip above: provider traffic stays on loopback.
            "NO_PROXY": f"{IDP_HOST},{WEBUI_HOST},127.0.0.1", "no_proxy": f"{IDP_HOST},{WEBUI_HOST},127.0.0.1",
        })
        return env

    def client(self) -> HttpClient:
        return HttpClient(self.base, self.pki["ca"], self.provider.issuer)

    def start(self, timeout: float = 45.0) -> None:
        with open(self.log_path, "a", encoding="utf-8") as log:
            self.proc = subprocess.Popen(
                [sys.executable, str(REPO / "server.py")], cwd=str(REPO), env=self._env(),
                stdout=log, stderr=subprocess.STDOUT,
            )
        deadline = time.monotonic() + timeout
        probe = self.client()
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                pytest.fail(f"WebUI exited during boot (code {self.proc.returncode})\n{self.log_tail()}")
            try:
                if probe.get("/health").status == 200:
                    return
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(0.25)
        self.stop()
        pytest.fail(f"WebUI did not answer {self.base}/health over TLS within {timeout}s\n{self.log_tail()}")

    def stop(self) -> None:
        if self.proc is None or self.proc.poll() is not None:
            return
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)

    def log_tail(self, limit: int = 3000) -> str:
        try:
            return self.log_path.read_text(encoding="utf-8", errors="replace")[-limit:]
        except OSError:
            return "<no server log>"


# ── Fixtures ────────────────────────────────────────────────────────────────

class Stack:
    def __init__(self, root, pki, provider, webui, playwright, browser):
        self.root, self.pki, self.provider, self.webui = root, pki, provider, webui
        self.playwright, self.browser = playwright, browser


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        _prerequisite_failed("playwright is not installed; pip install playwright && playwright install chromium")
    # Fail closed: a hosts-file or split-DNS override that points either fixture
    # name anywhere but loopback would send synthetic traffic off-box.
    for host in (IDP_HOST, WEBUI_HOST):
        try:
            import socket

            addresses = {info[4][0] for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        except OSError as exc:
            _prerequisite_failed(f"{host} does not resolve on this host: {exc}")
        if not addresses or not all(ipaddress.ip_address(a.split("%", 1)[0]).is_loopback for a in addresses):
            _prerequisite_failed(f"{host} must resolve only to loopback, got {sorted(addresses)}")
        if "127.0.0.1" not in addresses:  # both services bind IPv4 loopback
            _prerequisite_failed(f"{host} must resolve to 127.0.0.1, got {sorted(addresses)}")
    root = tmp_path_factory.mktemp("hweb72-oidc")
    print(f"HWEB-72 artifacts: {root}")
    pki = _make_pki(root)
    provider = SyntheticProvider(pki["idp_cert"], pki["idp_key"])
    webui = WebUI(root, pki, provider)
    playwright = browser = None
    try:
        playwright = sync_playwright().start()
        try:
            browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        except Exception as exc:  # missing browser binary
            _prerequisite_failed(f"Chromium unavailable for Playwright: {exc}")
        webui.start()
        yield Stack(root, pki, provider, webui, playwright, browser)
    finally:
        webui.stop()
        provider.stop()
        if browser is not None:
            browser.close()
        if playwright is not None:
            playwright.stop()
        (root / "provider-requests.log").write_text("\n".join(provider.requests) + "\n")


@pytest.fixture(autouse=True)
def _scenario(stack):
    stack.provider.reset()
    if stack.webui.proc is None or stack.webui.proc.poll() is not None:
        pytest.fail(f"fixture-owned WebUI is not running\n{stack.webui.log_tail()}")
    yield
    stack.provider.reset()


@contextmanager
def browser_page(stack: Stack, name: str):
    """Fresh context per scenario; screenshot on failure; always closed."""
    context = stack.browser.new_context(ignore_https_errors=True)
    # Only the two fixture origins exist for this browser: anything else (CDN
    # assets on the app shell, telemetry, a misrouted provider) is aborted, so
    # the gate never waits on the network it does not own.
    fixture_origins = (stack.webui.base + "/", stack.provider.issuer + "/")
    context.route(lambda url: not url.startswith(fixture_origins), lambda route: route.abort())
    page = context.new_page()
    try:
        yield page
    except BaseException:
        try:
            page.screenshot(path=str(stack.root / f"{name}.png"))
        except Exception:
            pass
        raise
    finally:
        context.close()


# ── Flow helpers ────────────────────────────────────────────────────────────

def start_login(client: HttpClient, next_path: str | None = None) -> str:
    query = "?next=" + urllib.parse.quote(next_path, safe="/") if next_path else ""
    resp = client.get("/api/auth/oidc/start" + query)
    assert resp.status == 302, (resp.status, resp.body[:300])
    assert resp.location.startswith(client.issuer + "/authorize?"), resp.location
    return resp.location


def provider_callback(client: HttpClient, auth_url: str) -> str:
    resp = client.get(auth_url)
    assert resp.status == 302, (resp.status, resp.body[:300])
    assert resp.location.startswith(client.base + "/api/auth/oidc/callback?"), resp.location
    return resp.location


def http_login(stack: Stack, identity: str, client: HttpClient | None = None, next_path=None) -> tuple[HttpClient, Response]:
    """Drive start -> provider -> callback with plain HTTP and return the callback response."""
    stack.provider.identity = identity
    client = client or stack.webui.client()
    client.last_callback = provider_callback(client, start_login(client, next_path))
    return client, client.get(client.last_callback)


def assert_logged_in(client: HttpClient, profile: str | None) -> None:
    status = client.get("/api/auth/status").json()
    assert status["logged_in"] is True and status["auth_type"] == "oidc", status
    assert status["bound_profile"] == profile, status
    memory = client.get("/api/memory")
    assert memory.status == 200, (memory.status, memory.body[:200])
    if profile:
        assert MARKERS[profile] in memory.json()["soul"]
        assert not any(m in memory.json()["soul"] for p, m in MARKERS.items() if p != profile)


def assert_no_session(client: HttpClient, resp: Response) -> None:
    assert resp.status >= 400, (resp.status, resp.headers.get("Location"))
    assert resp.json().get("error"), resp.body[:300]
    assert SESSION_COOKIE not in resp.set_cookies() and SESSION_COOKIE not in client.cookies
    assert client.get("/api/auth/status").json()["logged_in"] is False
    assert client.get("/api/memory").status == 401


def native_start(client: HttpClient) -> dict:
    verifier = secrets.token_urlsafe(48)
    state = secrets.token_urlsafe(24)
    resp = client.post("/api/auth/oidc/native/start", {
        "callback_url": NATIVE_CALLBACK, "state": state,
        "code_challenge": _b64u(hashlib.sha256(verifier.encode("ascii")).digest()),
        "code_challenge_method": "S256",
    })
    assert resp.status == 200, (resp.status, resp.body[:300])
    flow = resp.json()
    assert flow["authorization_url"].startswith(client.base + "/api/auth/oidc/start?native_flow=")
    return {"verifier": verifier, "state": state, **flow}


def native_authorize_http(stack: Stack, client: HttpClient, flow: dict) -> dict:
    """Walk the browser half of a native flow over HTTP and parse the app callback."""
    resp = client.get(flow["authorization_url"])
    assert resp.status == 302, (resp.status, resp.body[:300])
    callback = client.get(provider_callback(client, resp.location))
    assert callback.status == 302 and callback.location.startswith(NATIVE_CALLBACK + "?"), (callback.status, callback.location)
    assert SESSION_COOKIE not in callback.set_cookies()
    return {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(callback.location).query).items()}


def native_exchange(client: HttpClient, flow: dict, app_callback: dict, *, verifier=None, state=None) -> Response:
    return client.post("/api/auth/oidc/native/exchange", {
        "flow_id": app_callback.get("flow_id", ""), "code": app_callback.get("code", ""),
        "state": state if state is not None else flow["state"],
        "code_verifier": verifier if verifier is not None else flow["verifier"],
    })


# ── 1. Browser happy path ───────────────────────────────────────────────────

def test_browser_sso_login_sets_secure_cookie_and_authenticates(stack: Stack):
    base = stack.webui.base
    with browser_page(stack, "browser-happy-path") as page:
        urls: list[str] = []
        page.on("request", lambda req: urls.append(req.url))
        page.goto(base + "/login?next=/session/hweb72", wait_until="domcontentloaded")
        link = page.locator("#oidc-login")
        # The SPA renders the href resolved against the mount root; compare the resolved path and query.
        from urllib.parse import parse_qs, urlparse
        href = urlparse(link.get_attribute("href") or "")
        assert href.path.endswith("/api/auth/oidc/start")
        assert parse_qs(href.query).get("next") == ["/session/hweb72"]
        link.click()
        page.wait_for_url(base + "/session/hweb72", wait_until="commit", timeout=15000)

        cookies = {c["name"]: c for c in page.context.cookies(base)}
        session = cookies[SESSION_COOKIE]
        assert session["httpOnly"] is True and session["secure"] is True and session["sameSite"] == "Lax", session
        profile = cookies[PROFILE_COOKIE]

        status = page.request.get(base + "/api/auth/status").json()
        assert status["logged_in"] is True and status["bound_profile"] == "alice", status
        memory = page.request.get(base + "/api/memory")
        assert memory.status == 200 and MARKERS["alice"] in memory.json()["soul"]

        callbacks = [u for u in urls if "/api/auth/oidc/callback" in u]
        assert len(callbacks) == 1 and "code=" in callbacks[0], callbacks
        assert any(u.startswith(stack.provider.issuer + "/authorize?") for u in urls), urls
        assert stack.provider.issued_tokens, "the provider must have minted tokens for this login"
        secrets_never_in_urls = (SESSION_COOKIE, session["value"], PROFILE_COOKIE, profile["value"], "id_token",
                                 *stack.provider.issued_tokens)
        for url in urls:
            assert not any(secret in url for secret in secrets_never_in_urls), url
    for entry in ("GET /.well-known/openid-configuration", "GET /authorize", "POST /token", "GET /jwks"):
        assert stack.provider.count(entry) >= 1, stack.provider.requests


# ── 2. Profile binding and isolation ────────────────────────────────────────

def test_identities_bind_to_distinct_profiles_and_cannot_cross_over(stack: Stack):
    alice, resp = http_login(stack, "alice")
    assert resp.status == 302 and resp.location == "/"
    assert_logged_in(alice, "alice")
    bob, _ = http_login(stack, "bob")
    assert_logged_in(bob, "bob")

    signed_alice_profile = alice.cookies[PROFILE_COOKIE]
    # A forged or foreign profile cookie is discarded: the session stays usable,
    # stays pinned to its bound profile, and the server re-issues the signed
    # bound-profile cookie (HMAC over the session token, so it is byte-identical).
    for forged in ("bob", "bob." + signed_alice_profile.split(".", 1)[1], bob.cookies[PROFILE_COOKIE]):
        alice.cookies[PROFILE_COOKIE] = forged
        memory = alice.get("/api/memory")
        assert memory.status == 200, (forged, memory.status, memory.body[:200])
        assert MARKERS["alice"] in memory.json()["soul"] and MARKERS["bob"] not in memory.body.decode(), forged
        assert memory.set_cookies()[PROFILE_COOKIE].value == signed_alice_profile, forged
        assert alice.cookies[PROFILE_COOKIE] == signed_alice_profile
        active = alice.get("/api/profile/active")
        assert active.status == 200 and active.json()["name"] == "alice", (forged, active.body[:200])
    alice.cookies[PROFILE_COOKIE] = signed_alice_profile
    switch = alice.post("/api/profile/switch", {"name": "bob"})
    assert switch.status == 403, (switch.status, switch.body[:200])
    assert_logged_in(alice, "alice")

    root, _ = http_login(stack, "root")
    assert_logged_in(root, "default")
    for client in (alice, bob, root):
        owner_only = client.get("/api/auth/passkeys")  # read-only owner gate
        assert owner_only.status == 403, (owner_only.status, owner_only.body[:200])
        assert client.get("/api/auth/status").json()["can_manage_server"] is False


# ── 3. Denied logins leave nothing behind ───────────────────────────────────

@pytest.mark.parametrize("case", ["mallory", "nogroup", "unmapped", "provider_error"])
def test_denied_login_leaves_no_session_and_next_valid_login_succeeds(stack: Stack, case: str):
    identity = "alice" if case == "provider_error" else case
    stack.provider.authorize_error = "access_denied" if case == "provider_error" else None
    client, resp = http_login(stack, identity)
    assert_no_session(client, resp)
    assert resp.status == (401 if case == "provider_error" else 403), resp.body[:200]
    stack.provider.authorize_error = None
    _, resp = http_login(stack, "alice", client=client)
    assert resp.status == 302
    assert_logged_in(client, "alice")


# ── 4. Tampered callbacks ───────────────────────────────────────────────────

def _tamper(stack: Stack, case: str) -> None:
    p = stack.provider
    if case == "nonce":
        p.claim_overrides = {"nonce": "not-the-login-nonce"}
    elif case == "issuer":
        p.claim_overrides = {"iss": "https://rogue.localhost"}
    elif case == "audience":
        p.claim_overrides = {"aud": "some-other-client"}
    elif case == "signature":
        p.sign_with = ("kid-1", ec.generate_private_key(ec.SECP256R1()))
    elif case == "expired":
        p.claim_overrides = {"exp": int(time.time()) - 3600}


@pytest.mark.parametrize("case", ["state", "nonce", "issuer", "audience", "signature", "expired", "reused_code"])
def test_tampered_callback_fails_without_minting_cookie(stack: Stack, case: str):
    client = stack.webui.client()
    if case == "state":
        # A real, unused provider code paired with a forged state: only the
        # state check stands between this request and a minted session.
        stack.provider.identity = "alice"
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(provider_callback(client, start_login(client))).query))
        query["state"] = "forged-" + query["state"]
        resp = client.get("/api/auth/oidc/callback?" + urllib.parse.urlencode(query))
        assert resp.status == 401, (resp.status, resp.body[:200])
    elif case == "reused_code":
        client, first = http_login(stack, "alice")
        assert first.status == 302
        used_code = urllib.parse.parse_qs(urllib.parse.urlsplit(client.last_callback).query)["code"][0]
        client = stack.webui.client()
        fresh_state = urllib.parse.parse_qs(urllib.parse.urlsplit(start_login(client)).query)["state"][0]
        resp = client.get("/api/auth/oidc/callback?" + urllib.parse.urlencode({"state": fresh_state, "code": used_code}))
        assert stack.provider.count("POST /token") >= 2
    else:
        _tamper(stack, case)
        client, resp = http_login(stack, "alice")
    assert_no_session(client, resp)
    assert resp.status in (401, 502), (case, resp.status, resp.body[:200])


# ── 5. Native flow ──────────────────────────────────────────────────────────

def browser_hop(page, url: str) -> dict:
    """Issue one hop from the browser context and capture its redirect unfollowed.

    Chromium follows redirect chains internally and never reports the final hop
    to a custom scheme, so the test drives each hop as its own navigation: the
    request still goes through the browser's network stack and cookie jar, and
    the ``talaria://`` redirect is captured before the browser can dispatch it.
    """
    captured: dict = {}

    def handler(route):
        response = route.fetch(max_redirects=0)
        captured.update(status=response.status, location=response.headers.get("location", ""))
        route.fulfill(status=200, content_type="text/plain", body="hop captured by test")

    page.route(lambda candidate: candidate == url, handler)
    page.goto(url, wait_until="domcontentloaded")
    page.unroute(lambda candidate: candidate == url)
    assert "hop captured" in page.content()
    return captured


def test_native_flow_completes_through_browser_and_separate_client(stack: Stack):
    base = stack.webui.base
    app = stack.webui.client()
    flow = native_start(app)
    with browser_page(stack, "native-flow") as page:
        start = browser_hop(page, flow["authorization_url"])
        assert start["status"] == 302 and start["location"].startswith(stack.provider.issuer + "/authorize?"), start
        authorized = browser_hop(page, start["location"])
        assert authorized["status"] == 302 and authorized["location"].startswith(base + "/api/auth/oidc/callback?"), authorized
        callback = browser_hop(page, authorized["location"])
        assert callback["status"] == 302 and callback["location"].startswith(NATIVE_CALLBACK + "?"), callback
        assert not [c for c in page.context.cookies(base) if c["name"] == SESSION_COOKIE]
    app_callback = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(callback["location"]).query).items()}
    assert set(app_callback) == {"code", "state", "flow_id", "server_id"}, app_callback  # nothing else rides along
    assert app_callback["state"] == flow["state"] and app_callback["flow_id"] == flow["flow_id"]
    assert app_callback["server_id"] == flow["server_id"] and "id_token" not in callback["location"]
    assert not any(token in callback["location"] for token in stack.provider.issued_tokens)

    exchange = native_exchange(app, flow, app_callback)
    assert exchange.status == 200 and exchange.json() == {"ok": True}, (exchange.status, exchange.body[:200])
    session = exchange.set_cookies()[SESSION_COOKIE]
    assert session["httponly"] and session["secure"] and session["samesite"] == "Lax", session
    assert_logged_in(app, "alice")
    replay = native_exchange(stack.webui.client(), flow, app_callback)
    assert replay.status == 401


@pytest.mark.parametrize("case", ["wrong_verifier", "wrong_state", "wrong_origin", "cancelled"])
def test_native_exchange_rejects_bad_proofs_without_session(stack: Stack, case: str):
    app = stack.webui.client()
    browser_half = stack.webui.client()
    flow = native_start(app)
    app_callback = native_authorize_http(stack, browser_half, flow)
    if case == "cancelled":
        cancel = app.post("/api/auth/oidc/native/cancel", {"flow_id": flow["flow_id"], "state": flow["state"]})
        assert cancel.status == 200 and cancel.json()["ok"] is True
        resp = native_exchange(app, flow, app_callback)
    elif case == "wrong_origin":
        other = HttpClient(f"https://127.0.0.1:{stack.webui.port}", stack.pki["ca"], stack.provider.issuer)
        resp = native_exchange(other, flow, app_callback)
        app.cookies.update(other.cookies)
    elif case == "wrong_state":
        resp = native_exchange(app, flow, app_callback, state=secrets.token_urlsafe(24))
    else:
        resp = native_exchange(app, flow, app_callback, verifier=secrets.token_urlsafe(48))
    assert resp.status == 401, (case, resp.status, resp.body[:200])
    assert SESSION_COOKIE not in resp.set_cookies() and SESSION_COOKIE not in app.cookies
    # A rejected proof consumed the code; the correct proof no longer works either.
    assert native_exchange(app, flow, app_callback).status == 401
    assert app.get("/api/auth/status").json()["logged_in"] is False


# ── 6. Key rotation and provider failures ───────────────────────────────────

def test_key_rotation_refreshes_jwks_and_provider_faults_do_not_poison_later_logins(stack: Stack):
    client, resp = http_login(stack, "alice")
    assert resp.status == 302
    before = stack.provider.count("GET /jwks")
    new_kid = stack.provider.rotate_key()
    client, resp = http_login(stack, "alice")
    assert resp.status == 302, resp.body[:200]
    assert_logged_in(client, "alice")
    assert stack.provider.count("GET /jwks") == before + 1, "new kid must trigger exactly one JWKS refresh"

    stack.provider.sign_with = ("kid-ghost", ec.generate_private_key(ec.SECP256R1()))
    client, resp = http_login(stack, "alice")
    assert_no_session(client, resp)
    stack.provider.sign_with = None

    stack.provider.rotate_key()
    stack.provider.jwks_response = b"<html>not a jwks</html>"
    client, resp = http_login(stack, "alice")
    assert_no_session(client, resp)
    stack.provider.jwks_response = None
    client, resp = http_login(stack, "alice", client=client)
    assert resp.status == 302, resp.body[:200]
    assert_logged_in(client, "alice")

    for status, body in ((200, b"this is not json"), (400, b'{"error":"invalid_grant"}')):
        stack.provider.token_response = (status, body)
        client, resp = http_login(stack, "alice")
        assert_no_session(client, resp)
        assert resp.status == 502
        assert stack.provider.token_response is None, "fault must have been consumed by the token call"
        client, resp = http_login(stack, "alice", client=client)
        assert resp.status == 302, resp.body[:200]
        assert_logged_in(client, "alice")
    assert new_kid in {kid for kid, _ in stack.provider.keys}


# ── 7. Logout, restart, policy change ───────────────────────────────────────

def test_logout_restart_and_policy_change_govern_existing_sessions(stack: Stack):
    client, _ = http_login(stack, "alice")
    old_cookie = client.cookies[SESSION_COOKIE]
    logout = client.post("/api/auth/logout")
    assert logout.status == 200 and logout.set_cookies()[SESSION_COOKIE]["max-age"] == "0"
    client.cookies[SESSION_COOKIE] = old_cookie
    assert client.get("/api/memory").status == 401

    client, _ = http_login(stack, "bob")
    assert_logged_in(client, "bob")
    stack.webui.stop()
    stack.webui.start()
    assert_logged_in(client, "bob")  # sessions persist in .sessions.json across restarts

    try:
        stack.webui.write_policy({"sub-alice": "alice", "sub-bob": "bob"})
        rejected = client.get("/api/memory")
        assert rejected.status == 401, (rejected.status, rejected.body[:200])
        assert client.get("/api/auth/status").json()["logged_in"] is False
        client, resp = http_login(stack, "bob", client=client)
        assert resp.status == 302
        assert_logged_in(client, "bob")
    finally:
        stack.webui.write_policy(PROFILE_MAP)


# ── 8. Cross-wired flows ────────────────────────────────────────────────────

def test_cross_wired_browser_and_native_flows_cannot_exchange_identity(stack: Stack):
    browser_client = stack.webui.client()
    stack.provider.identity = "alice"
    browser_cb = provider_callback(browser_client, start_login(browser_client))
    browser_q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(browser_cb).query).items()}

    app = stack.webui.client()
    native_client = stack.webui.client()
    stack.provider.identity = "bob"
    flow = native_start(app)
    resp = native_client.get(flow["authorization_url"])
    native_cb = provider_callback(native_client, resp.location)
    native_q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(native_cb).query).items()}

    swapped = browser_client.get("/api/auth/oidc/callback?" + urllib.parse.urlencode({"state": browser_q["state"], "code": native_q["code"]}))
    assert_no_session(browser_client, swapped)
    crossed = native_client.get("/api/auth/oidc/callback?" + urllib.parse.urlencode({"state": native_q["state"], "code": browser_q["code"]}))
    assert crossed.status == 302 and crossed.location.startswith(NATIVE_CALLBACK + "?"), (crossed.status, crossed.location)
    failed = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(crossed.location).query).items()}
    assert failed.get("error") == "authentication_failed" and "code" not in failed, failed
    assert SESSION_COOKIE not in native_client.cookies and SESSION_COOKIE not in browser_client.cookies
    for code in (native_q["code"], browser_q["code"]):
        exchange = native_exchange(app, flow, {"flow_id": flow["flow_id"], "code": code})
        assert exchange.status == 401 and SESSION_COOKIE not in app.cookies
    # Both provider codes are spent; neither side can retry with the leftovers.
    assert browser_client.get("/api/auth/oidc/callback?" + urllib.parse.urlencode(browser_q)).status >= 400
    assert app.get("/api/auth/status").json()["logged_in"] is False
