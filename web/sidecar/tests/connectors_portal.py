"""A synthetic Nous Portal and connector gateway for the ``connectors.*`` tests and fixtures (TAL-818).

One local HTTP server answers both: the portal's ``/api/v1/connectors/*`` routes the Agent's ``PortalConnectorClient``
reads, and the gateway's ``/v1/connectors/*`` routes its connect operation drives. ``seed_identity`` writes a Nous
identity whose token carries the portal's ``managed_tools`` claim, so the Agent's own ``connectors_available()`` opens.
"""

from __future__ import annotations

import base64
import json
import pathlib
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

STAMP = "2026-10-14T00:00:00Z"


class Portal:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.catalog = [{"slug": "gmail", "name": "Gmail", "description": "Read and send mail.", "category": "communication", "logoUrl": None},
                        {"slug": "notion", "name": "Notion", "description": "Pages and databases.", "category": "productivity", "logoUrl": None}]
        self.accounts: dict[str, dict] = {"conn-notion": self.account("conn-notion", "notion", "active")}
        self.member = {"mode": "deny", "disabledConnectors": [], "tools": {}}
        self.revision = 1
        self.connect_count = 0

    @staticmethod
    def account(connection_id: str, connector: str, status: str) -> dict:
        return {"connectionId": connection_id, "connector": connector, "status": status, "label": f"{connector}@example.test", "alias": None,
                "active": status == "active", "disabled": False, "createdAt": STAMP, "updatedAt": STAMP}

    def policy(self) -> dict:
        revision = f"rev-{self.revision}"
        return {"layers": [{"kind": "member", "body": self.member, "revision": revision}],
                "effective": {"version": 1, "revision": revision, "issuedAtMs": 0, **self.member}}

    def answer(self, method: str, path: str, body: dict) -> tuple[int, dict]:
        with self.lock:
            if method == "GET" and path == "/api/v1/connectors/catalog":
                return 200, {"connectors": self.catalog}
            if method == "GET" and path == "/api/v1/connectors/accounts":
                return 200, {"accounts": list(self.accounts.values())}
            if method == "DELETE" and path.startswith("/api/v1/connectors/accounts/"):
                row = self.accounts.pop(path.rsplit("/", 1)[1], None)
                if row is None:
                    return 404, {"error": "connection_not_found"}
                return 200, {"connectionId": row["connectionId"], "connector": row["connector"], "status": "removed"}
            if method == "GET" and path == "/api/v1/connectors/policy":
                return 200, self.policy()
            if method == "PUT" and path == "/api/v1/connectors/policy":
                if body.get("expectedRevision") != f"rev-{self.revision}":
                    return 409, {"error": {"code": "policy_changed", "message": "policy changed"}}
                key = "connectors" if "connectors" in body else "disabledConnectors"
                tools = {**self.member["tools"], **{slug: {"disable": names} for slug, names in (body.get("tools") or {}).items()}}
                self.member = {"mode": "allow" if key == "connectors" else "deny", key: body[key], "tools": tools}
                self.revision += 1
                policy = self.policy()
                return 200, {"revision": policy["effective"]["revision"], "effective": policy["effective"]}
            if method == "GET" and path.startswith("/api/v1/connectors/") and path.endswith("/tools"):
                slug = path.split("/")[4]
                if slug not in {row["slug"] for row in self.catalog}:
                    return 404, {"error": {"code": "connector_not_found", "message": "no such connector"}}
                return 200, {"connector": slug, "toolkitVersion": "1", "etag": "etag-1", "tools": [
                    {"slug": f"{slug}_read", "name": "Read", "description": "Read items.", "facet": "read", "hints": ["readOnlyHint"], "categories": [], "noAuth": False, "deprecated": False},
                    {"slug": f"{slug}_send", "name": "Send", "description": "Send an item.", "facet": "write", "hints": [], "categories": [], "noAuth": False, "deprecated": False},
                ]}
            if method == "POST" and path == "/v1/connectors/connections":
                self.connect_count += 1
                results = []
                for slug in body.get("connectors", []):
                    connection_id = f"conn-{slug}-{self.connect_count}"
                    self.accounts[connection_id] = self.account(connection_id, slug, "pending")
                    results.append({"connector": slug, "status": "initiated", "connectUrl": f"https://vendor.example.test/authorize/{connection_id}", "connectionId": connection_id})
                return 200, {"results": results, "summary": {"total": len(results), "initiated": len(results)}}
            if method == "GET" and path.startswith("/v1/connectors/accounts/"):
                row = self.accounts.get(path.rsplit("/", 1)[1])
                return (200, row) if row else (404, {"error": "connection_not_found"})
        return 404, {"error": {"code": "not_found", "message": path}}

    def finish_authorization(self, connector: str) -> None:
        """The user completed the vendor's consent page: the pending account turns active."""
        with self.lock:
            for row in self.accounts.values():
                if row["connector"] == connector and row["status"] == "pending":
                    row.update(status="active", active=True)


@contextmanager
def serve(portal, *, bearer: bool = True):
    """Serves ``portal.answer(method, path, body)``; ``bearer`` refuses a request without a bearer token first."""
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # noqa: D102 - quiet
            pass

        def _answer(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw or b"{}")
            except ValueError:  # the OAuth device and token endpoints take a form body
                body = {key: values[0] for key, values in parse_qs(raw.decode()).items()}
            if bearer and not str(self.headers.get("Authorization") or "").startswith("Bearer "):
                status, payload = 401, {"error": {"code": "NO_TOKEN", "message": "no token"}}
            else:
                status, payload = portal.answer(self.command, self.path.split("?", 1)[0], body)
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _answer

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()


def seed_identity(home: pathlib.Path, origin: str) -> dict[str, str]:
    """A signed-in Nous identity the portal enabled connectors for; returns the env that points the Agent at ``origin``."""

    def b64(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    token = f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64({'sub': 'user-synthetic', 'exp': int(time.time()) + 86400, 'managed_tools': True})}.sig"
    state = {"access_token": token, "expires_at": "2099-01-01T00:00:00Z", "portal_base_url": origin}
    (home / "auth.json").write_text(json.dumps({"version": 1, "providers": {"nous": state}}), encoding="utf-8")
    return {"HERMES_PORTAL_BASE_URL": origin, "CONNECTOR_GATEWAY_URL": origin}
