"""TAL-398: the device-code sign-in lifecycle with synthetic provider steps: no Agent, network, or real credential."""

from __future__ import annotations

import contextlib
import pathlib
import sys
import threading
import time
import types

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
    monkeypatch.setattr(oauth, "_GENERATIONS", {})
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


def test_the_old_flow_is_cancelled_before_the_new_code_request(provider, tmp_path):
    first = start(provider, tmp_path)
    seen = []

    def begin():
        seen.append(oauth.poll(tmp_path, first["flow_id"])["status"])
        raise RuntimeError("provider unavailable")

    with pytest.raises(RpcError):
        oauth.start(tmp_path, "openai-codex", providers={"openai-codex": (begin, None, None)})
    assert seen == ["cancelled"]
    provider.answer.set()  # the old code is approved after the replacement began
    time.sleep(0.1)
    assert provider.saved == []


def test_overlapping_starts_publish_only_the_newest(provider, tmp_path):
    release = threading.Event()
    entered = threading.Event()
    outcome: dict = {}

    def slow_begin():
        entered.set()
        assert release.wait(5)
        return provider.steps()[0]()

    def older():
        try:
            oauth.start(tmp_path, "openai-codex", providers={"openai-codex": (slow_begin, *provider.steps()[1:])})
        except RpcError as exc:
            outcome["error"] = exc

    thread = threading.Thread(target=older)
    thread.start()
    assert entered.wait(5)
    newer = start(provider, tmp_path)  # begins after the older request but answers first
    release.set()
    thread.join(5)
    assert outcome["error"].data["condition"] == "oauth_superseded"
    assert oauth.poll(tmp_path, newer["flow_id"])["status"] == "pending"
    assert [f.flow_id for f in oauth._FLOWS.values()] == [newer["flow_id"]]
    provider.answer.set()
    assert settle(tmp_path, newer["flow_id"])["status"] == "approved"


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


# ── TAL-985 / TAL-991: the real Nous steps against stub Agent modules of either release shape ──


def state(kind: str, *, ok: bool = False, precondition: bool = False, copy: str = "", **fields) -> types.SimpleNamespace:
    """A stand-in for one ``anon_auth.SignInState``."""
    return types.SimpleNamespace(kind=kind, ok=ok, precondition=precondition, copy=copy, copy_terminal=f"{copy} (terminal)", **fields)


CODE = state("code", link="https://portal.example.test/claim/GUEST-42", code="GUEST-42", expires_in=600, interval=2)


class SignIn:
    """A scripted ``anon_auth.run_sign_in``: yields ``first``, waits for the user's answer, then yields ``ending`` or
    persists through the caller's guard and yields ``completed``. Cancels reach it only through that guard and the
    ``cancelled`` callable it was handed, as after a connector transfer."""

    def __init__(self, first=CODE, ending=None):
        self.first, self.ending = first, ending
        self.answer = threading.Event()
        self.kwargs: dict = {}
        self.persisted: list = []
        self.closed = False

    def __call__(self, **kwargs):
        self.kwargs = kwargs
        return self.run(**kwargs)

    def run(self, *, cancelled, cancel_wins_after_promotion, persist_guard, scope):
        try:
            with scope():
                pass
            yield self.first
            if self.first.kind != "code":
                return
            yield state("waiting")
            assert self.answer.wait(5)
            if self.ending is not None:
                yield self.ending
                return
            with scope() as home, persist_guard() as may_persist:
                if may_persist:
                    self.persisted.append(home)
            yield state("completed", ok=True) if may_persist else state("superseded", copy="A newer sign-in code replaced this one.")
        finally:
            self.closed = True


def stub_agent(monkeypatch, *, guest: bool, shape: str, sign_in: SignIn | None = None) -> list[tuple]:
    """Installs ``hermes_cli.anon_auth`` shaped like v0.22.0 (``guest_allowed``, ``run_sign_in``) or v0.21.x
    (``guest_enabled`` only) and a ``hermes_cli.auth`` whose device-code request and plain save are recorded."""
    anon_auth = types.ModuleType("hermes_cli.anon_auth")
    anon_auth.has_guest = lambda: guest
    if shape == "0.22":
        anon_auth.guest_allowed = lambda: True
        anon_auth.run_sign_in = sign_in or SignIn()
    else:
        anon_auth.guest_enabled = lambda: True
    requests: list[tuple] = []

    def request_device_code(client, portal, client_id, scope):
        requests.append((portal, client_id, scope))
        return {"user_code": "NOUS-1234", "verification_uri_complete": "https://portal.example.test/device?code=NOUS-1234", "expires_in": 900, "interval": 5, "device_code": "synthetic-device"}

    auth = types.ModuleType("hermes_cli.auth")
    auth.PROVIDER_REGISTRY = {"nous": types.SimpleNamespace(portal_base_url="https://portal.example.test/", client_id="synthetic-client", scope="inference")}
    auth._request_device_code = request_device_code
    auth.refresh_nous_oauth_from_state = lambda auth_state, **kwargs: auth_state
    auth.persist_nous_credentials = lambda full_state: requests.append(("plain save", full_state))
    anon_auth.settle_after_upgrade = lambda full_state: None
    package = types.ModuleType("hermes_cli")
    package.anon_auth, package.auth = anon_auth, auth
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.anon_auth", anon_auth)
    monkeypatch.setitem(sys.modules, "hermes_cli.auth", auth)
    monkeypatch.setattr(oauth, "_client", lambda timeout: contextlib.nullcontext(object()))
    monkeypatch.delenv("HERMES_PORTAL_BASE_URL", raising=False)
    monkeypatch.delenv("NOUS_PORTAL_BASE_URL", raising=False)
    return requests


@pytest.mark.parametrize("shape", ["0.22", "0.21"])
def test_nous_without_a_guest_requests_a_device_code(monkeypatch, shape):
    requests = stub_agent(monkeypatch, guest=False, shape=shape)
    display, state = oauth._nous_begin()
    assert requests == [("https://portal.example.test", "synthetic-client", "inference")]
    assert display == {"user_code": "NOUS-1234", "verification_url": "https://portal.example.test/device?code=NOUS-1234", "expires_in": 900, "interval": 5}
    assert state["device_code"] == "synthetic-device"


def test_nous_over_a_guest_on_an_agent_without_run_sign_in_is_refused_with_the_upgrade_hint(monkeypatch):
    requests = stub_agent(monkeypatch, guest=True, shape="0.21")
    with pytest.raises(RpcError) as refused:
        oauth._nous_begin()
    assert refused.value.data["condition"] == "oauth_unsupported"
    assert "`hermes auth upgrade`" in str(refused.value)
    assert requests == []


def test_nous_over_a_guest_signs_in_through_the_agent_and_keeps_its_connected_apps(provider, monkeypatch, tmp_path):
    sign_in = SignIn()
    requests = stub_agent(monkeypatch, guest=True, shape="0.22", sign_in=sign_in)
    flow = oauth.start(tmp_path, "nous")
    assert flow == {"flow_id": flow["flow_id"], "provider": "nous", "status": "pending", "user_code": "GUEST-42", "verification_url": "https://portal.example.test/claim/GUEST-42", "expires_in": 600, "interval": 2}
    assert sign_in.kwargs["cancel_wins_after_promotion"] is True
    sign_in.answer.set()
    assert settle(tmp_path, flow["flow_id"]) == {"flow_id": flow["flow_id"], "provider": "nous", "status": "approved", "error": None}
    assert sign_in.persisted == [tmp_path]  # under the flow's own home
    assert requests == []  # neither a plain device code nor the plain save
    assert sign_in.closed


@pytest.mark.parametrize(("ending", "status", "error"), [
    (state("failed", copy="Something's still finishing up on your account."), "error", "Something's still finishing up on your account."),
    (state("declined", copy="No problem, you're still on the free Nous service."), "denied", "Sign-in was declined."),
    (state("timed_out", copy="That sign-in link has expired."), "expired", "The sign-in code expired before it was approved."),
])
def test_a_guest_sign_in_that_ends_without_an_account_is_the_flows_ending(provider, monkeypatch, tmp_path, ending, status, error):
    sign_in = SignIn(ending=ending)
    requests = stub_agent(monkeypatch, guest=True, shape="0.22", sign_in=sign_in)
    flow = oauth.start(tmp_path, "nous")
    sign_in.answer.set()
    assert settle(tmp_path, flow["flow_id"]) == {"flow_id": flow["flow_id"], "provider": "nous", "status": status, "error": error}
    assert sign_in.persisted == [] and requests == []


def test_a_cancelled_guest_sign_in_persists_nothing(provider, monkeypatch, tmp_path):
    sign_in = SignIn()
    requests = stub_agent(monkeypatch, guest=True, shape="0.22", sign_in=sign_in)
    flow = oauth.start(tmp_path, "nous")
    time.sleep(0.1)  # the worker is draining the sign-in
    assert sign_in.kwargs["cancelled"]() is False
    assert oauth.cancel(tmp_path, flow["flow_id"])["status"] == "cancelled"
    assert sign_in.kwargs["cancelled"]() is True
    sign_in.answer.set()  # the transfer completes in the browser after the cancel
    deadline = time.monotonic() + 5
    while not sign_in.closed and time.monotonic() < deadline:
        time.sleep(0.01)
    assert sign_in.closed
    assert oauth.poll(tmp_path, flow["flow_id"])["status"] == "cancelled"
    assert sign_in.persisted == [] and requests == []


@pytest.mark.parametrize(("first", "condition"), [
    (state("already_signed_in", ok=True, precondition=True, copy="Already signed in."), "oauth_unsupported"),
    (state("failed", copy="The Nous service couldn't be reached."), "oauth_failed"),
])
def test_a_guest_sign_in_that_cannot_start_is_refused(provider, monkeypatch, tmp_path, first, condition):
    sign_in = SignIn(first=first)
    stub_agent(monkeypatch, guest=True, shape="0.22", sign_in=sign_in)
    with pytest.raises(RpcError) as refused:
        oauth.start(tmp_path, "nous")
    assert refused.value.data["condition"] == condition
    assert str(refused.value) == first.copy_terminal
    assert sign_in.closed and oauth._FLOWS == {}
