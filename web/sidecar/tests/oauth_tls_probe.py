"""Run on the Agent interpreter: build the sign-in HTTP client ``oauth._client`` and report how it verifies TLS.

``cert_file``: with ``SSL_CERT_FILE`` at a freshly minted CA in the test's scratch directory, whether the client completes
a TLS handshake with a loopback server whose certificate that CA signed, and verifies through the Agent's platform store.
``rotated <entry>``: certifi is imported from a stand-in environment that is then deleted, as a package manager's
environment rotation leaves a running process; reports whether ``_client`` or the xAI start (``_xai_begin``, whose
discovery is the Agent's own bare ``httpx.get``) still runs. Requests are answered in-process. Prints one JSON line.
"""

from __future__ import annotations

import datetime
import importlib
import json
import os
import shutil
import ssl
import sys
from pathlib import Path

sys.path.append(sys.argv[1])
scenario, scratch = sys.argv[2], Path(sys.argv[3])

from agent import ssl_verify  # noqa: E402

from talaria_sidecar.methods import oauth  # noqa: E402


def context(client) -> ssl.SSLContext:
    return client._transport._pool._ssl_context


def mint() -> tuple[bytes, bytes, bytes]:
    """A CA, and a ``localhost`` server certificate it signed with that certificate's key: PEM each."""
    import ipaddress

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.datetime.now(datetime.timezone.utc)

    def build(subject, issuer, public_key, signer, *extensions):
        # Key identifiers: Python 3.13+ verifies with VERIFY_X509_STRICT, which rejects a chain without them.
        builder = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer).public_key(public_key).serial_number(x509.random_serial_number())
                   .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=1))
                   .add_extension(x509.SubjectKeyIdentifier.from_public_key(public_key), critical=False)
                   .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(signer.public_key()), critical=False))
        for extension, critical in extensions:
            builder = builder.add_extension(extension, critical=critical)
        return builder.sign(signer, hashes.SHA256())

    ca_key, server_key = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Talaria test corporate CA")])
    ca = build(ca_name, ca_name, ca_key.public_key(), ca_key, (x509.BasicConstraints(ca=True, path_length=None), True),
               (x509.KeyUsage(False, False, False, False, False, True, True, False, False), True))
    server = build(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]), ca_name, server_key.public_key(), ca_key,
                   (x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), False),
                   (x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False),
                   (x509.BasicConstraints(ca=False, path_length=None), True))
    key = server_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return ca.public_bytes(serialization.Encoding.PEM), server.public_bytes(serialization.Encoding.PEM), key


def serve_tls(cert: Path, key: Path) -> int:
    """A loopback HTTPS server answering ``{}``; returns its port."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


def answer_in_process() -> None:
    """Every request is answered without a socket; the client and its SSL context are still built for real."""
    import httpx

    def handle(self, request):
        url = str(request.url)
        if url.endswith("/.well-known/openid-configuration"):
            body = {"authorization_endpoint": "https://auth.x.ai/oauth2/auth", "token_endpoint": "https://auth.x.ai/oauth2/token"}
        else:
            body = {"device_code": "device-1", "user_code": "USER-1", "verification_uri": "https://accounts.x.ai/device",
                    "verification_uri_complete": "https://accounts.x.ai/device?code=USER-1", "expires_in": 600, "interval": 5}
        return httpx.Response(200, json=body, request=request)

    httpx.HTTPTransport.handle_request = handle


if scenario == "cert_file":
    ca, cert, key = mint()
    bundle, server_cert, server_key = scratch / "corporate-ca.pem", scratch / "server.pem", scratch / "server-key.pem"
    bundle.write_bytes(ca)
    server_cert.write_bytes(cert)
    server_key.write_bytes(key)
    port = serve_tls(server_cert, server_key)
    os.environ["SSL_CERT_FILE"] = str(bundle)
    with oauth._client(15.0) as client:
        try:
            handshake = client.get(f"https://localhost:{port}/").status_code == 200
        except Exception as exc:  # noqa: BLE001 - reported to the test
            handshake = f"{type(exc).__name__}: {exc}"
        print(json.dumps({
            "handshake": handshake,
            "platform_store": not ssl_verify.install_truststore() or type(context(client)).__module__.startswith("truststore"),
        }))
elif scenario == "rotated":
    if not hasattr(ssl_verify, "certifi_bundle_path"):  # the recovery first shipped in Agent v0.22.3
        print(json.dumps({"recovers": False}))
        sys.exit(0)
    import certifi

    package = scratch / "env-a" / "certifi"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("import os\n\n\ndef where():\n    return os.path.join(os.path.dirname(__file__), 'cacert.pem')\n")
    shutil.copyfile(certifi.where(), package / "cacert.pem")
    sys.path.insert(0, str(package.parent))
    del sys.modules["certifi"]
    importlib.invalidate_caches()
    stand_in = importlib.import_module("certifi")
    assert Path(stand_in.where()).parent == package
    shutil.rmtree(package.parent)
    answer_in_process()
    try:
        if sys.argv[4] == "xai":
            display, _ = oauth._xai_begin()
            result = {"recovers": True, "built": display["user_code"] == "USER-1"}
        else:
            with oauth._client(15.0) as client:
                result = {"recovers": True, "built": int(context(client).verify_mode) == ssl.CERT_REQUIRED}
    except Exception as exc:  # noqa: BLE001 - reported to the test
        result = {"recovers": True, "built": False, "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result))
