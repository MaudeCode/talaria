"""TAL-991: a Nous sign-in over a connector guest runs the supported Agent's own ``anon_auth.run_sign_in`` through
``oauth.*`` against a synthetic portal: an approval promotes the guest to the account, and a cancel after the transfer
persists nothing."""

from __future__ import annotations

import base64
import json
import threading
import time

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess
from connectors_portal import serve
from talaria_sidecar import SIDECAR_RPC_VERSION

pytestmark = pytest.mark.skipif(AGENT_DIR is None or AGENT_PYTHON is None, reason="pinned Hermes Agent checkout with venv not found")

GUEST = {"auth_method": "anonymous", "anon_token": "guest-token"}


def jwt(claims: dict) -> str:
    def b64(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    return f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64(claims)}.sig"


class NousPortal:
    """The portal's device-code, promotion and token routes. A promotion-status request is held until the test answers it."""

    def __init__(self) -> None:
        self.paths: list[str] = []
        self.asked = threading.Event()
        self.answered = threading.Event()
        self.token = jwt({"sub": "user-synthetic", "scope": "inference:invoke", "exp": int(time.time()) + 86400})

    def answer(self, method: str, path: str, body: dict) -> tuple[int, dict]:
        self.paths.append(path)
        if path == "/api/oauth/device/code":
            return 200, {"device_code": "device-1", "user_code": "USER-1", "verification_uri": "https://portal.example.test/device",
                         "verification_uri_complete": "https://portal.example.test/device?code=USER-1", "expires_in": 600, "interval": 1}
        if path == "/api/anonymous/promotion-intent":
            assert body == {"token": "guest-token", "user_code": "USER-1", "device_code": "device-1"}
            return 200, {"claim_code": "CLAIM-42", "claim_url": "/claim/CLAIM-42", "expires_in": 600, "interval": 1}
        if path == "/api/anonymous/promotion-status":
            self.asked.set()
            assert self.answered.wait(30)
            return 200, {"status": "completed", "account_email": "user@example.test"}
        if path == "/api/oauth/token":
            return 200, {"access_token": self.token, "refresh_token": "refresh-1", "token_type": "Bearer", "expires_in": 86400, "scope": "inference:invoke"}
        return 404, {"error": "not_found"}


@pytest.fixture
def portal():
    return NousPortal()


@pytest.fixture
def signing_in(hermes_home, portal):
    """A sidecar over a profile holding a connector guest of the synthetic portal."""
    with serve(portal, bearer=False) as origin:
        (hermes_home / "auth.json").write_text(json.dumps({"version": 1, "providers": {"nous": {**GUEST, "portal_base_url": origin}}}), encoding="utf-8")
        proc = SidecarProcess(hermes_home, env={"HERMES_PORTAL_BASE_URL": origin})
        try:
            assert proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
            yield proc, origin
        finally:
            portal.answered.set()
            proc.close()


def nous(hermes_home) -> dict:
    return json.loads((hermes_home / "auth.json").read_text())["providers"]["nous"]


def test_an_approved_guest_sign_in_promotes_the_guest_to_the_account(signing_in, hermes_home, portal):
    proc, origin = signing_in
    flow = proc.result("oauth.start", {"profile_home": str(hermes_home), "provider": "nous"}, timeout=60)
    assert (flow["user_code"], flow["verification_url"], flow["expires_in"], flow["interval"]) == ("CLAIM-42", f"{origin}/claim/CLAIM-42", 600, 1)
    assert portal.asked.wait(30)
    portal.answered.set()  # the user approved the transfer in the browser
    deadline = time.monotonic() + 60
    while (view := proc.result("oauth.poll", {"profile_home": str(hermes_home), "flow_id": flow["flow_id"]}))["status"] == "pending":
        assert time.monotonic() < deadline, portal.paths
        time.sleep(0.2)
    assert view["status"] == "approved", view
    account = nous(hermes_home)
    assert account["auth_method"] == "oauth_device_code" and account["access_token"] == portal.token
    assert "anon_token" not in account


def test_a_guest_sign_in_cancelled_after_the_transfer_persists_nothing(signing_in, hermes_home, portal):
    proc, _ = signing_in
    flow = proc.result("oauth.start", {"profile_home": str(hermes_home), "provider": "nous"}, timeout=60)
    assert portal.asked.wait(30)
    view = proc.result("oauth.cancel", {"profile_home": str(hermes_home), "flow_id": flow["flow_id"]})
    assert view["status"] == "cancelled"
    portal.answered.set()  # the transfer completes in the browser after the cancel
    time.sleep(2)  # the Agent asks for the account's token at once after a completed transfer it keeps
    assert "/api/oauth/token" not in portal.paths
    assert proc.result("oauth.poll", {"profile_home": str(hermes_home), "flow_id": flow["flow_id"]})["status"] == "cancelled"
    assert nous(hermes_home)["auth_method"] == "anonymous"
