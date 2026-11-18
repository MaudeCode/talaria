"""Native guest sign-in through real oauth.* RPCs, over the release's plain device login."""

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
    """The portal's device-code and token routes. The token request is held until the test answers it."""

    def __init__(self) -> None:
        self.paths: list[str] = []
        self.asked = threading.Event()
        self.answered = threading.Event()
        self.token = jwt({"sub": "user-synthetic", "email": "user@example.test", "scope": "inference:invoke", "exp": int(time.time()) + 86400})

    def answer(self, method: str, path: str, body: dict) -> tuple[int, dict]:
        self.paths.append(path)
        if path == "/api/oauth/device/code":
            return 200, {"device_code": "device-1", "user_code": "USER-1", "verification_uri": "https://portal.example.test/device",
                         "verification_uri_complete": f"{self.origin}/device?code=USER-1", "expires_in": 600, "interval": 1}
        if path == "/api/oauth/token":
            self.asked.set()
            assert self.answered.wait(30)
            return 200, {"access_token": self.token, "refresh_token": "refresh-1", "token_type": "Bearer", "expires_in": 86400, "scope": "inference:invoke"}
        return 404, {"error": "not_found"}


@pytest.fixture
def portal():
    return NousPortal()


@pytest.fixture
def signing_in(hermes_home, portal):
    """A sidecar over a profile holding a connector guest of the synthetic portal."""
    with serve(portal, bearer=False) as origin:
        portal.origin = origin
        (hermes_home / "auth.json").write_text(json.dumps({"version": 1, "providers": {"nous": {**GUEST, "portal_base_url": origin}}}), encoding="utf-8")
        proc = SidecarProcess(hermes_home, env={"HERMES_PORTAL_BASE_URL": origin})
        try:
            assert proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
            yield proc, origin
        finally:
            portal.answered.set()
            proc.close()
            assert all(secret not in "".join(proc.stderr_lines) for secret in (GUEST["anon_token"], portal.token, "refresh-1"))


def nous(hermes_home) -> dict:
    return json.loads((hermes_home / "auth.json").read_text())["providers"]["nous"]


def until(condition, explain):
    """``condition()`` once it holds, failing under the suite's 60 s ceiling with ``explain()``."""
    deadline = time.monotonic() + 60
    while not (value := condition()):
        assert time.monotonic() < deadline, explain()
        time.sleep(0.05)
    return value


def test_an_approved_guest_sign_in_promotes_the_guest_to_the_account(signing_in, hermes_home, portal):
    proc, origin = signing_in
    flow = proc.result("oauth.start", {"profile_home": str(hermes_home), "provider": "nous"}, timeout=60)
    assert (flow["user_code"], flow["verification_url"], flow["expires_in"], flow["interval"]) == ("USER-1", f"{origin}/device?code=USER-1", 600, 1)
    assert portal.asked.wait(30)
    portal.answered.set()  # the user approved the transfer in the browser

    def settled():
        view = proc.result("oauth.poll", {"profile_home": str(hermes_home), "flow_id": flow["flow_id"]})
        return view if view["status"] != "pending" else None

    view = until(settled, lambda: portal.paths)
    assert view["status"] == "approved", view
    assert view.get("nous_account", {}).get("email") == "u***@example.test", view
    account = nous(hermes_home)
    assert account["auth_method"] == "oauth_device_code" and account["access_token"] == portal.token
    assert "anon_token" not in account
    assert portal.paths.count("/api/oauth/token") == 1
    assert all(secret not in json.dumps([flow, view]) for secret in (GUEST["anon_token"], portal.token, "refresh-1"))


def test_a_guest_sign_in_cancelled_after_the_transfer_persists_nothing(signing_in, hermes_home, portal):
    proc, _ = signing_in
    flow = proc.result("oauth.start", {"profile_home": str(hermes_home), "provider": "nous"}, timeout=60)
    assert portal.asked.wait(30)
    view = proc.result("oauth.cancel", {"profile_home": str(hermes_home), "flow_id": flow["flow_id"]})
    assert view["status"] == "cancelled"
    portal.answered.set()  # the transfer completes in the browser after the cancel
    # The flow thread logs its ending once the native sign-in has consumed the late token; a save would have come first.
    ended = f"sign-in ended cancelled (flow={flow['flow_id'][:6]})"
    until(lambda: any(ended in line for line in proc.stderr_lines) or nous(hermes_home)["auth_method"] != "anonymous",
          lambda: proc.stderr_lines[-10:])
    assert portal.paths.count("/api/oauth/token") == 1
    assert proc.result("oauth.poll", {"profile_home": str(hermes_home), "flow_id": flow["flow_id"]})["status"] == "cancelled"
    assert nous(hermes_home)["auth_method"] == "anonymous"
