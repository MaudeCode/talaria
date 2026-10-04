"""TAL-398: the device-code sign-in lifecycle with synthetic provider steps: no Agent, network, or real credential."""

from __future__ import annotations

import contextlib
import pathlib
import threading
import time

import pytest

from talaria_sidecar.errors import InvalidParams, RpcError
from talaria_sidecar.methods import oauth


class Provider:
    """Scripted (begin, wait, save): ``wait`` blocks until the test answers for the user, then returns or raises."""

    def __init__(self, *, expires_in: int = 900):
        self.expires_in = expires_in
        self.answer: threading.Event = threading.Event()
        self.outcome: object = {"access_token": "synthetic-access"}
        self.saved: list[tuple[pathlib.Path, dict]] = []
        self.homes: list[pathlib.Path] = []
        self.client: object | None = None

    def steps(self):
        def begin():
            return {"user_code": "ABCD-1234", "verification_url": "https://auth.example.test/device", "expires_in": self.expires_in, "interval": 1}, {"device_code": "synthetic-device"}

        def wait(flow, state):
            assert state == {"device_code": "synthetic-device"}
            assert self.answer.wait(5)
            if self.client is not None:  # the provider's token endpoint answers through the watched client
                oauth._Watched(self.client, flow).post("https://auth.example.test/token")
            if isinstance(self.outcome, BaseException):
                raise self.outcome
            return self.outcome

        def save(flow, state, tokens):
            self.saved.append((self.homes[-1], tokens))

        return begin, wait, save


@pytest.fixture
def provider(monkeypatch):
    p = Provider()

    @contextlib.contextmanager
    def scoped(home):
        p.homes.append(pathlib.Path(home))
        yield home

    monkeypatch.setattr(oauth, "scoped_home", scoped)
    monkeypatch.setattr(oauth, "_FLOWS", {})
    return p


def settle(home, flow_id, *, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        view = oauth.poll(home, flow_id)
        if view["status"] != "pending":
            return view
        time.sleep(0.01)
    raise AssertionError("flow never ended")


def start(provider: Provider, home, name: str = "openai-codex") -> dict:
    return oauth.start(pathlib.Path(home), name, providers={name: provider.steps()})


def test_an_approved_flow_saves_the_credential_under_its_own_home(provider, tmp_path):
    flow = start(provider, tmp_path)
    assert flow == {"flow_id": flow["flow_id"], "provider": "openai-codex", "status": "pending", "user_code": "ABCD-1234", "verification_url": "https://auth.example.test/device", "expires_in": 900, "interval": 1}
    assert oauth.poll(tmp_path, flow["flow_id"])["status"] == "pending"
    assert provider.saved == []
    provider.answer.set()
    assert settle(tmp_path, flow["flow_id"]) == {"flow_id": flow["flow_id"], "provider": "openai-codex", "status": "approved", "error": None}
    assert provider.saved == [(tmp_path, {"access_token": "synthetic-access"})]


def test_a_declined_flow_ends_denied_and_saves_nothing(provider, tmp_path):
    class Response:
        status_code = 400

        def json(self):
            return {"error": "access_denied", "error_description": "The user denied the request"}

    class Client:
        def post(self, *args, **kwargs):
            return Response()

    provider.client = Client()
    provider.outcome = RuntimeError("Sign-in did not complete: the user denied the request.\n  Details: access_denied")
    flow = start(provider, tmp_path, "nous")
    provider.answer.set()
    assert settle(tmp_path, flow["flow_id"]) == {"flow_id": flow["flow_id"], "provider": "nous", "status": "denied", "error": "Sign-in was declined."}
    assert provider.saved == []


def test_an_agent_denial_code_and_an_expiry_are_classified(provider, tmp_path):
    class AuthError(RuntimeError):
        def __init__(self, message, code):
            super().__init__(message)
            self.code = code

    provider.outcome = AuthError("MiniMax OAuth reported an error.", "authorization_denied")
    flow = start(provider, tmp_path, "minimax-oauth")
    provider.answer.set()
    assert settle(tmp_path, flow["flow_id"])["status"] == "denied"

    provider.answer.clear()
    provider.outcome = TimeoutError("Timed out waiting for device authorization.")
    flow = start(provider, tmp_path, "minimax-oauth")
    provider.answer.set()
    assert settle(tmp_path, flow["flow_id"]) == {"flow_id": flow["flow_id"], "provider": "minimax-oauth", "status": "expired", "error": "The sign-in code expired before it was approved."}

    provider.answer.clear()
    provider.outcome = RuntimeError("OpenAI device sign-in returned HTTP 500.\nsecond line")
    flow = start(provider, tmp_path)
    provider.answer.set()
    assert settle(tmp_path, flow["flow_id"])["error"] == "OpenAI device sign-in returned HTTP 500."
    assert provider.saved == []


def test_a_cancel_wins_over_an_approval_that_arrives_after_it(provider, tmp_path):
    flow = start(provider, tmp_path)
    assert oauth.cancel(tmp_path, flow["flow_id"])["status"] == "cancelled"
    provider.answer.set()  # the user approves in the browser after cancelling here
    time.sleep(0.1)
    assert oauth.poll(tmp_path, flow["flow_id"])["status"] == "cancelled"
    assert provider.saved == []
    # A cancelled flow's next provider call stops instead of polling on.
    with pytest.raises(oauth._Stop):
        oauth._Watched(object(), oauth._FLOWS[flow["flow_id"]]).post("https://auth.example.test/token")


def test_a_pending_flow_past_its_code_expiry_ends_expired_and_cannot_save_later(provider, tmp_path, monkeypatch):
    flow = start(provider, tmp_path)
    monkeypatch.setattr(oauth.time, "time", lambda: oauth._FLOWS[flow["flow_id"]].expires_at + oauth._EXPIRY_GRACE + 1)
    assert oauth.poll(tmp_path, flow["flow_id"])["status"] == "expired"
    monkeypatch.undo()
    provider.answer.set()
    time.sleep(0.1)
    assert provider.saved == []


def test_a_flow_is_invisible_to_another_profile_home(provider, tmp_path):
    flow = start(provider, tmp_path / "a")
    with pytest.raises(RpcError) as missing:
        oauth.poll(tmp_path / "b", flow["flow_id"])
    assert missing.value.data["condition"] == "oauth_flow_not_found"
    with pytest.raises(RpcError):
        oauth.cancel(tmp_path / "b", flow["flow_id"])
    assert oauth.poll(tmp_path / "a", flow["flow_id"])["status"] == "pending"
    provider.answer.set()
    settle(tmp_path / "a", flow["flow_id"])


def test_a_new_start_supersedes_the_pending_flow_for_the_same_home_and_provider(provider, tmp_path):
    first = start(provider, tmp_path)
    other_home = start(provider, tmp_path / "other")
    second = start(provider, tmp_path)
    assert oauth.poll(tmp_path, first["flow_id"])["status"] == "cancelled"
    assert oauth.poll(tmp_path / "other", other_home["flow_id"])["status"] == "pending"
    provider.answer.set()
    assert settle(tmp_path, second["flow_id"])["status"] == "approved"
    assert settle(tmp_path / "other", other_home["flow_id"])["status"] == "approved"
    assert sorted(home.name for home, _ in provider.saved) == sorted([tmp_path.name, "other"])


def test_an_unknown_provider_and_a_failed_start_are_errors(provider, tmp_path):
    with pytest.raises(InvalidParams):
        oauth.start(tmp_path, "anthropic")

    def begin():
        raise RuntimeError("OpenAI rejected the device-code login request.\n(HTTP 400)")

    with pytest.raises(RpcError) as failed:
        oauth.start(tmp_path, "openai-codex", providers={"openai-codex": (begin, None, None)})
    assert str(failed.value) == "OpenAI rejected the device-code login request."
    assert failed.value.data["condition"] == "oauth_failed"

    def hostile():
        return {"user_code": "ABCD-1234", "verification_url": "javascript:alert(1)", "expires_in": 900, "interval": 1}, {}

    with pytest.raises(RpcError, match="invalid sign-in link"):
        oauth.start(tmp_path, "openai-codex", providers={"openai-codex": (hostile, None, None)})
    assert oauth._FLOWS == {}
