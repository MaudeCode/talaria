"""Run on the Agent interpreter: sign in to a plugin-declared OAuth client through the sidecar's methods (TAL-1276).

A test plugin in the disposable ``HERMES_HOME`` declares one client whose authorize and token URLs point at a stub IdP
served over HTTPS on loopback, with a CA this probe creates and exports through ``SSL_CERT_FILE``. The probe plays the
browser: it reads the authorize link, has the IdP issue a code bound to its PKCE challenge, and delivers the redirect
through the loopback listener or as a pasted address. Prints one JSON line of outcomes.
"""

from __future__ import annotations

import base64
import contextlib
import datetime
import hashlib
import io
import ipaddress
import json
import logging
import os
import ssl
import sys
import tempfile
import threading
import time
import types
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

sys.path.append(sys.argv[1])

from cryptography import x509  # noqa: E402 - the Agent pins cryptography
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402

HOME = Path(os.environ["HERMES_HOME"])
CERTS = Path(tempfile.mkdtemp(prefix="oauth-probe-ca-"))
PROVIDER = "plugin:oauth-probe:synthetic"
CLIENT_ID = "synthetic-client"


def _certificates() -> tuple[Path, Path, Path]:
    """A throwaway CA and a 127.0.0.1 server certificate it signed."""
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key, leaf_key = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "oauth probe CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5))
          .not_valid_after(now + datetime.timedelta(hours=1)).add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
          .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False, data_encipherment=False, key_agreement=False,
                                       key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    leaf = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])).issuer_name(ca_name)
            .public_key(leaf_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(now + datetime.timedelta(hours=1)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    paths = CERTS / "ca.pem", CERTS / "leaf.pem", CERTS / "leaf.key"
    paths[0].write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    paths[1].write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    paths[2].write_bytes(leaf_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return paths


CA, LEAF, LEAF_KEY = _certificates()
os.environ["SSL_CERT_FILE"] = str(CA)
# On macOS the Agent's default verification pins certifi's bundle instead of honouring SSL_CERT_FILE; point certifi at
# the test CA so its real verification path still runs, against a CA the IdP's certificate chains to.
import certifi  # noqa: E402

certifi.where = lambda: str(CA)


class IdP:
    """A stub authorization server: issues one code per authorize link and exchanges it once for its PKCE verifier."""

    def __init__(self):
        self.codes: dict[str, dict] = {}
        self.issued: list[str] = []
        self.exchanges = 0
        idp = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                form = {k: v[0] for k, v in parse_qs(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()).items()}
                grant = idp.codes.pop(form.get("code", ""), None)
                verifier = form.get("code_verifier", "")
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
                ok = (self.path == "/token" and grant is not None and form.get("grant_type") == "authorization_code" and form.get("client_id") == CLIENT_ID
                      and form.get("redirect_uri") == grant["redirect_uri"] and challenge == grant["challenge"])
                idp.exchanges += 1
                body = {"access_token": f"synthetic-access-{idp.exchanges}", "refresh_token": f"synthetic-refresh-{idp.exchanges}", "expires_in": 3600,
                        "token_type": "Bearer", "scope": "read"} if ok else {"error": "invalid_grant"}
                if ok:
                    idp.issued += [body["access_token"], body["refresh_token"]]
                payload = json.dumps(body).encode()
                self.send_response(200 if ok else 400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format: str, *args) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(LEAF, LEAF_KEY)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f"https://127.0.0.1:{self.server.server_address[1]}"

    def approve(self, authorize_url: str, *, state: str | None = None) -> str:
        """What the browser is sent to after the user approves: the redirect URI with a fresh code and the state."""
        query = {k: v[0] for k, v in parse_qs(urlparse(authorize_url).query).items()}
        code = f"synthetic-code-{len(self.codes) + len(self.issued)}"
        self.codes[code] = {"redirect_uri": query["redirect_uri"], "challenge": query["code_challenge"]}
        self.issued.append(code)
        return f"{query['redirect_uri']}?{urlencode({'code': code, 'state': query['state'] if state is None else state})}"


idp = IdP()
plugin = HOME / "plugins" / "oauth-probe"
plugin.mkdir(parents=True)
(plugin / "__init__.py").write_text("def register(ctx):\n    pass\n")
(plugin / "plugin.yaml").write_text(
    "name: oauth-probe\nversion: 1.0.0\ndescription: Synthetic OAuth client\nrequires_env:\n  - OAUTH_PROBE_CLIENT_ID\n"
    f"oauth:\n  - id: synthetic\n    authorize_url: {idp.origin}/authorize\n    token_url: {idp.origin}/token\n    scopes: [read]\n"
    "    client_id_env: OAUTH_PROBE_CLIENT_ID\n    hosts: [api.synthetic.test]\n")
(HOME / ".env").write_text(f"OAUTH_PROBE_CLIENT_ID={CLIENT_ID}\n")

logs = io.StringIO()
handler = logging.StreamHandler(logs)
handler.setLevel(logging.DEBUG)
logging.getLogger().addHandler(handler)
logging.getLogger().setLevel(logging.DEBUG)

from talaria_sidecar.methods import build_methods, oauth  # noqa: E402

methods = build_methods(types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
responses: list = []


def call(method: str, **params) -> dict:
    """One sidecar method under the probe's home; an RPC error comes back as its condition."""
    try:
        result = methods[method](None, {"profile_home": str(HOME), **params})
    except Exception as exc:  # noqa: BLE001 - recorded, so a missing method is an assertion and not a crash
        result = {"raised": (getattr(exc, "data", None) or {}).get("condition") or type(exc).__name__}
    responses.append(result)
    return result


def settle(flow_id: str) -> str:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        view = call("oauth.poll", flow_id=flow_id)
        if view.get("status") != "pending":
            return view.get("status") or view.get("raised")
        time.sleep(0.05)
    return "still pending"


def grant() -> dict | None:
    try:
        section = json.loads((HOME / "auth.json").read_text()).get("plugin_oauth") or {}
    except FileNotFoundError:
        return None
    return section.get("oauth-probe:synthetic")


def agent_status() -> str:
    """``hermes auth status oauth-probe:synthetic``: the Agent's own answer."""
    from hermes_cli.plugin_oauth import handle_auth_action

    from talaria_sidecar.home import scoped_home

    out = io.StringIO()
    with scoped_home(HOME), contextlib.redirect_stdout(out):
        handle_auth_action("status", types.SimpleNamespace(), "oauth-probe:synthetic")
    return out.getvalue().splitlines()[0].split(": ", 1)[1] if out.getvalue() else ""


def client_state() -> dict:
    listing = call("plugins.oauth_status")
    rows = {row["key"]: row["clients"] for row in listing.get("plugins", [])} if "plugins" in listing else {}
    return {"supported": listing.get("supported"), "clients": rows.get("oauth-probe")}


def start() -> dict:
    return call("oauth.start", provider=PROVIDER)


out: dict = {"before": client_state()}
if not out["before"]["supported"]:
    out["start"] = start().get("raised")
    print(json.dumps(out))
    sys.exit(0)

# 1. The browser runs on this host: its redirect reaches the loopback listener.
flow = start()
out["start_fields"] = sorted(flow)
out["start_hosts"] = [flow.get("authorize_host"), flow.get("token_host")]
out["redirect_is_loopback"] = urlparse(flow.get("redirect_uri", "")).hostname
urllib.request.urlopen(idp.approve(flow["verification_url"]), timeout=10).read()
out["loopback"] = settle(flow["flow_id"])
out["loopback_grant"] = sorted(grant() or {})
out["loopback_agent_status"] = agent_status()
out["loopback_state"] = client_state()["clients"]

# 2. Sign-out removes the grant.
out["logout"] = call("plugins.oauth_logout", key="oauth-probe", id="synthetic")
out["logout_grant"] = grant()
out["logout_agent_status"] = agent_status()
out["logout_state"] = client_state()["clients"]

# 3. The browser runs elsewhere: the user pastes the address it was sent to.
flow = start()
submitted = call("oauth.submit_redirect", flow_id=flow["flow_id"], url=idp.approve(flow["verification_url"]))
out["paste_submitted"] = submitted.get("status") or submitted.get("raised")
out["paste"] = settle(flow["flow_id"])
out["paste_agent_status"] = agent_status()
out["paste_state"] = [c["state"] for c in client_state()["clients"]]
call("plugins.oauth_logout", key="oauth-probe", id="synthetic")

# 4. Failures write no grant.
flow = start()
call("oauth.submit_redirect", flow_id=flow["flow_id"], url=idp.approve(flow["verification_url"], state="not-this-flow"))
out["wrong_state"] = [settle(flow["flow_id"]), grant()]

flow = start()
foreign = urlparse(idp.approve(flow["verification_url"]))._replace(netloc=f"attacker.example:{urlparse(flow['redirect_uri']).port}").geturl()
refused = call("oauth.submit_redirect", flow_id=flow["flow_id"], url=foreign)
out["foreign_host"] = [refused.get("raised"), call("oauth.poll", flow_id=flow["flow_id"])["status"], grant()]
call("oauth.cancel", flow_id=flow["flow_id"])

flow = start()
redirect = idp.approve(flow["verification_url"])
oauth._FLOWS[flow["flow_id"]].expires_at = time.time() - 1  # the Agent's timeout_seconds ran out before the approval
out["expired"] = [settle(flow["flow_id"]), call("oauth.submit_redirect", flow_id=flow["flow_id"], url=redirect).get("raised"), grant()]

flow = start()
redirect = idp.approve(flow["verification_url"])
cancelled = call("oauth.cancel", flow_id=flow["flow_id"])["status"]
refused = call("oauth.submit_redirect", flow_id=flow["flow_id"], url=redirect).get("raised")
time.sleep(0.5)  # the listener closes once the worker sees the cancel
try:
    urllib.request.urlopen(redirect, timeout=5).read()
    listener = "answered"
except OSError:
    listener = "closed"
out["cancelled"] = [cancelled, refused, listener, call("oauth.poll", flow_id=flow["flow_id"])["status"], grant()]

# 5. With a pinned redirect port, a replacing start and a retry right after a cancel bind once the old listener closed.
import dataclasses  # noqa: E402
import socket  # noqa: E402

from hermes_cli import plugin_oauth  # noqa: E402

with socket.socket() as probe_socket:
    probe_socket.bind(("127.0.0.1", 0))
    pinned = probe_socket.getsockname()[1]
unpinned = plugin_oauth._pkce_config
plugin_oauth._pkce_config = lambda *a, **k: dataclasses.replace(unpinned(*a, **k), redirect_port=pinned)
first = start()
second = start()  # replaces the first flow while its listener holds the port
call("oauth.cancel", flow_id=second.get("flow_id", ""))
third = start()  # right after a cancel
out["pinned_port"] = [f.get("status") or f.get("raised") for f in (first, second, third)] + [urlparse(third.get("redirect_uri", "")).port == pinned]
call("oauth.cancel", flow_id=third.get("flow_id", ""))
plugin_oauth._pkce_config = unpinned

# 6. No secret leaves through a response or a log line; ``state`` only appears inside the authorize link it belongs to.
start_links = {r["verification_url"] for r in responses if isinstance(r, dict) and "verification_url" in r}
public = json.dumps([{k: v for k, v in r.items() if k != "verification_url"} if isinstance(r, dict) else r for r in responses])
states = [parse_qs(urlparse(link).query)["state"][0] for link in start_links]
secrets_seen = [s for s in [*idp.issued, *states] if s in public or s in logs.getvalue()]
out["leaks"] = secrets_seen
out["link_has_verifier"] = any("code_verifier" in link for link in start_links)
print(json.dumps(out))
