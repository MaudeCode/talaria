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
from talaria_sidecar.methods import oauth, providers as provider_methods


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
    # Each test installs its own provider steps; the module's table is restored afterwards.
    monkeypatch.setattr(oauth, "PROVIDERS", dict(oauth.PROVIDERS))
    monkeypatch.setattr(provider_methods, "installed_plugin_profiles", lambda: [])
    return p


def settle(home, flow_id, *, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        view = oauth.poll(home, flow_id)
        if view["status"] != "pending":
            return view
        time.sleep(0.01)
    raise AssertionError("flow never ended")


def wait_until(condition, *, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "condition never held"
        time.sleep(0.01)


def start(provider: Provider, home, name: str = "openai-codex") -> dict:
    oauth.PROVIDERS[name] = provider.steps()
    return oauth.start(pathlib.Path(home), name)


def worker(flow_id: str) -> threading.Thread:
    """The flow's own worker thread, taken while it still waits on the provider."""
    return next(t for t in threading.enumerate() if t.name == f"oauth-{flow_id[:6]}")


def finished(thread: threading.Thread) -> bool:
    thread.join(5)
    return not thread.is_alive()


def test_an_approved_flow_saves_the_credential_under_its_own_home(provider, tmp_path):
    flow = start(provider, tmp_path)
    assert flow == {"flow_id": flow["flow_id"], "provider": "openai-codex", "status": "pending", "user_code": "ABCD-1234", "verification_url": "https://auth.example.test/device", "expires_in": 900, "interval": 1}
    assert oauth.poll(tmp_path, flow["flow_id"])["status"] == "pending"
    assert provider.saved == []
    provider.answer.set()
    assert settle(tmp_path, flow["flow_id"]) == {"flow_id": flow["flow_id"], "provider": "openai-codex", "status": "approved", "error": None}
    assert provider.saved == [(tmp_path, {"access_token": "synthetic-access"})]


@pytest.mark.parametrize("ending", ["approved", "cancelled", "denied", "expired", "error", "late"])
def test_provider_device_flow_honors_state_interval_and_terminal_outcome(provider, monkeypatch, tmp_path, ending):
    now, waits, states, workers = [1000.0], [], [], []
    monkeypatch.setattr(oauth.time, "time", lambda: now[0])
    monkeypatch.setattr(oauth.threading, "Thread", lambda *, target, args, **kw: types.SimpleNamespace(start=lambda: workers.append(lambda: target(*args))))

    def begin():
        return {"user_code": "PLUGIN-42", "verification_url": "https://device.example.test/login", "expires_in": 90, "interval": 3, "state": 0}

    def poll(state):
        states.append((provider.homes[-1], state))
        if state == 0:
            return {"status": "pending", "interval": 7, "state": 1}
        if ending == "late":
            now[0] += 100
        return {"status": "approved" if ending == "late" else ending, "credential": {"token": "test-only"}}

    profile = types.SimpleNamespace(name="device-test", start_device_login=begin, poll_device_login=poll,
                                    save_device_login=lambda credential: provider.saved.append((provider.homes[-1], credential)))
    monkeypatch.setattr(provider_methods, "installed_plugin_profiles", lambda: [("test-plugin", profile)])
    try:
        started = oauth.start(tmp_path, "device-test")
    except RpcError as exc:
        started = {"error": str(exc)}
    assert started.get("user_code") == "PLUGIN-42", started
    flow = oauth._FLOWS[started["flow_id"]]

    class ClockEvent:
        stopped = False

        def set(self):
            self.stopped = True

        def is_set(self):
            return self.stopped

        def wait(self, interval):
            waits.append(interval)
            now[0] += interval
            if ending == "cancelled":
                oauth.cancel(tmp_path, started["flow_id"])
            return self.stopped

    flow.cancelled = ClockEvent()
    workers[0]()
    assert oauth.poll(tmp_path, started["flow_id"])["status"] == ("expired" if ending == "late" else ending)
    assert waits == ([3] if ending == "cancelled" else [3, 7])
    assert states == ([] if ending == "cancelled" else [(tmp_path, 0), (tmp_path, 1)])
    assert provider.saved == ([(tmp_path, {"token": "test-only"})] if ending == "approved" else [])


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
    run = worker(flow["flow_id"])
    assert oauth.cancel(tmp_path, flow["flow_id"])["status"] == "cancelled"
    provider.answer.set()  # the user approves in the browser after cancelling here
    assert finished(run)
    assert oauth.poll(tmp_path, flow["flow_id"])["status"] == "cancelled"
    assert provider.saved == []
    # A cancelled flow's next provider call stops instead of polling on.
    with pytest.raises(oauth._Stop):
        oauth._Watched(object(), oauth._FLOWS[flow["flow_id"]]).post("https://auth.example.test/token")


def test_a_pending_flow_past_its_code_expiry_ends_expired_and_cannot_save_later(provider, tmp_path, monkeypatch):
    flow = start(provider, tmp_path)
    run = worker(flow["flow_id"])
    with monkeypatch.context() as clock:
        clock.setattr(oauth.time, "time", lambda: oauth._FLOWS[flow["flow_id"]].expires_at + oauth._EXPIRY_GRACE + 1)
        assert oauth.poll(tmp_path, flow["flow_id"])["status"] == "expired"
    provider.answer.set()
    assert finished(run)
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
    run = worker(first["flow_id"])
    seen = []

    def begin():
        seen.append(oauth.poll(tmp_path, first["flow_id"])["status"])
        raise RuntimeError("provider unavailable")

    oauth.PROVIDERS["openai-codex"] = (begin, None, None)
    with pytest.raises(RpcError):
        oauth.start(tmp_path, "openai-codex")
    assert seen == ["cancelled"]
    provider.answer.set()  # the old code is approved after the replacement began
    assert finished(run)
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
            oauth.start(tmp_path, "openai-codex")
        except RpcError as exc:
            outcome["error"] = exc

    oauth.PROVIDERS["openai-codex"] = (slow_begin, *provider.steps()[1:])
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

    oauth.PROVIDERS["openai-codex"] = (begin, None, None)
    with pytest.raises(RpcError) as failed:
        oauth.start(tmp_path, "openai-codex")
    assert str(failed.value) == "OpenAI rejected the device-code login request."
    assert failed.value.data["condition"] == "oauth_failed"

    def hostile():
        return {"user_code": "ABCD-1234", "verification_url": "javascript:alert(1)", "expires_in": 900, "interval": 1}, {}

    oauth.PROVIDERS["openai-codex"] = (hostile, None, None)
    with pytest.raises(RpcError, match="invalid sign-in link"):
        oauth.start(tmp_path, "openai-codex")
    assert oauth._FLOWS == {}


# ── TAL-985 / TAL-991: the real Nous steps against a stub of the Agent's native sign-in ──


def state(kind: str, *, ok: bool = False, precondition: bool = False, copy: str = "", **fields) -> types.SimpleNamespace:
    """A stand-in for one ``anon_auth.SignInState``."""
    return types.SimpleNamespace(kind=kind, ok=ok, precondition=precondition, copy=copy, copy_terminal=f"{copy} (terminal)", **fields)


CODE = state("code", link="https://portal.example.test/claim/GUEST-42", code="GUEST-42", expires_in=600, interval=2)


class SignIn:
    """A scripted ``anon_auth.run_sign_in`` with the supported Agents' declaration: yields ``first``, waits for the
    user's answer, then yields ``ending`` or persists through the caller's guard, waits for the account to settle and
    yields ``settled`` (``completed`` by default). Cancels reach it only through that guard and the ``cancelled``
    callable it was handed, as after a connector transfer."""

    def __init__(self, first=CODE, ending=None, settled=None):
        self.first, self.ending = first, ending
        self.settled = settled or state("completed", ok=True)
        self.answer = threading.Event()
        self.settle = threading.Event()
        # Set once the flow's worker drives the sign-in past its code, so the flow is bound into its cancel check.
        self.waiting = threading.Event()
        self.kwargs: dict = {}
        self.persisted: list = []
        self.closed = False
        self.settled_count = 0

    def __call__(self, *, cancelled, persist_guard, scope, replace_account=False):
        assert replace_account is True
        self.kwargs = dict(cancelled=cancelled, persist_guard=persist_guard, scope=scope, replace_account=replace_account)
        return self.run(cancelled=cancelled, persist_guard=persist_guard, scope=scope)

    def run(self, *, cancelled, persist_guard, scope):
        try:
            with scope():
                pass
            yield self.first
            if self.first.kind != "code":
                return
            self.waiting.set()
            yield state("waiting")
            assert self.answer.wait(5)
            if self.ending is not None:
                yield self.ending
                return
            with scope() as home, persist_guard() as may_persist:
                if may_persist:
                    self.persisted.append(home)
            if not may_persist:
                yield state("superseded", copy="A newer sign-in code replaced this one.")
                return
            assert self.settle.wait(5)
            self.settled_count += 1
            yield self.settled
        finally:
            self.closed = True


def stub_agent(monkeypatch, sign_in: SignIn) -> None:
    """Installs a ``hermes_cli.anon_auth`` whose ``run_sign_in`` is ``sign_in``; the account read is the projection's."""
    anon_auth = types.ModuleType("hermes_cli.anon_auth")
    anon_auth.run_sign_in = sign_in
    package = types.ModuleType("hermes_cli")
    package.anon_auth = anon_auth
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.anon_auth", anon_auth)
    monkeypatch.setattr(oauth.nous_account, "read", lambda *args: None)


def test_nous_signs_in_through_the_agent_and_a_cancel_after_the_save_cannot_undo_it(provider, monkeypatch, tmp_path):
    sign_in = SignIn()
    stub_agent(monkeypatch, sign_in)
    flow = oauth.start(tmp_path, "nous")
    assert flow == {"flow_id": flow["flow_id"], "provider": "nous", "status": "pending", "user_code": "GUEST-42", "verification_url": "https://portal.example.test/claim/GUEST-42", "expires_in": 600, "interval": 2}
    # A signed-in profile signs in again through the same native sign-in.
    assert sign_in.kwargs["replace_account"] is True
    sign_in.answer.set()
    wait_until(lambda: sign_in.persisted)
    assert sign_in.persisted == [tmp_path]  # under the flow's own home
    # Saved but not yet settled: the flow is still pending, and a cancel can no longer undo the save.
    assert oauth.poll(tmp_path, flow["flow_id"])["status"] == "pending"
    assert oauth.cancel(tmp_path, flow["flow_id"])["status"] == "pending"
    assert sign_in.kwargs["cancelled"]() is False
    sign_in.settle.set()
    assert settle(tmp_path, flow["flow_id"]) == {"flow_id": flow["flow_id"], "provider": "nous", "status": "approved", "error": None}
    assert sign_in.closed and sign_in.settled_count == 1
    assert oauth.poll(tmp_path, flow["flow_id"])["status"] == "approved"
    assert sign_in.settled_count == 1


def test_a_nous_sign_in_that_fails_to_settle_after_the_save_ends_in_error(provider, monkeypatch, tmp_path):
    sign_in = SignIn(settled=state("failed", copy="Sign-in didn't finish. Try again whenever you're ready."))
    stub_agent(monkeypatch, sign_in)
    flow = oauth.start(tmp_path, "nous")
    sign_in.answer.set()
    sign_in.settle.set()
    assert settle(tmp_path, flow["flow_id"]) == {"flow_id": flow["flow_id"], "provider": "nous", "status": "error", "error": "Sign-in didn't finish. Try again whenever you're ready."}


@pytest.mark.parametrize(("ending", "status", "error"), [
    (state("failed", copy="Something's still finishing up on your account."), "error", "Something's still finishing up on your account."),
    (state("declined", copy="No problem, you're still on the free Nous service."), "denied", "Sign-in was declined."),
    (state("timed_out", copy="That sign-in link has expired."), "expired", "The sign-in code expired before it was approved."),
])
def test_a_nous_sign_in_that_ends_without_an_account_is_the_flows_ending(provider, monkeypatch, tmp_path, ending, status, error):
    sign_in = SignIn(ending=ending)
    stub_agent(monkeypatch, sign_in)
    flow = oauth.start(tmp_path, "nous")
    sign_in.answer.set()
    assert settle(tmp_path, flow["flow_id"]) == {"flow_id": flow["flow_id"], "provider": "nous", "status": status, "error": error}
    assert sign_in.persisted == []


@pytest.mark.parametrize("stop", ["cancel", "expire", "supersede"])
def test_a_cancelled_nous_sign_in_persists_nothing(provider, monkeypatch, tmp_path, stop):
    sign_in = SignIn()
    stub_agent(monkeypatch, sign_in)
    flow = oauth.start(tmp_path, "nous")
    assert sign_in.waiting.wait(5)  # the worker is draining the sign-in
    assert sign_in.kwargs["cancelled"]() is False
    status = "expired" if stop == "expire" else "cancelled"
    if stop == "cancel":
        assert oauth.cancel(tmp_path, flow["flow_id"])["status"] == status
    elif stop == "expire":
        oauth._FLOWS[flow["flow_id"]].expires_at = time.time() - oauth._EXPIRY_GRACE - 1
        assert oauth.poll(tmp_path, flow["flow_id"])["status"] == status
    else:
        newer = start(provider, tmp_path, "nous")
        provider.answer.set()
        assert settle(tmp_path, newer["flow_id"])["status"] == "approved"
    assert sign_in.kwargs["cancelled"]() is True
    sign_in.answer.set()  # the transfer completes in the browser after the cancel
    wait_until(lambda: sign_in.closed)
    assert oauth.poll(tmp_path, flow["flow_id"])["status"] == status
    assert sign_in.persisted == []


@pytest.mark.parametrize(("first", "condition"), [
    (state("already_signed_in", ok=True, precondition=True, copy="Already signed in."), "oauth_unsupported"),
    (state("failed", copy="The Nous service couldn't be reached."), "oauth_failed"),
])
def test_a_nous_sign_in_that_cannot_start_is_refused(provider, monkeypatch, tmp_path, first, condition):
    sign_in = SignIn(first=first)
    stub_agent(monkeypatch, sign_in)
    with pytest.raises(RpcError) as refused:
        oauth.start(tmp_path, "nous")
    assert refused.value.data["condition"] == condition
    assert str(refused.value) == first.copy
    assert sign_in.closed and oauth._FLOWS == {}


def test_native_completion_cannot_adopt_an_account_replaced_during_settlement(provider, monkeypatch, tmp_path):
    native = SignIn()
    stub_agent(monkeypatch, native)
    current = ["original-account"]
    monkeypatch.setattr(oauth.nous_account, "read", lambda *args: {"account_id": current[0]})
    flow = oauth.start(tmp_path, "nous")
    native.answer.set()
    wait_until(lambda: native.persisted)
    current[0] = "replacement-account"
    native.settle.set()
    assert settle(tmp_path, flow["flow_id"]) == {"flow_id": flow["flow_id"], "provider": "nous", "status": "approved", "error": None, "nous_account": None}


def test_native_start_errors_use_safe_copy(provider, monkeypatch, tmp_path, caplog):
    first = state("failed", copy="Sign-in didn't finish. Try again whenever you're ready.")
    first.copy_terminal = "Sign-in failed: credential=synthetic-secret"
    native = SignIn(first=first)
    stub_agent(monkeypatch, native)
    with pytest.raises(RpcError) as refused:
        oauth.start(tmp_path, "nous")
    assert str(refused.value) == first.copy
    assert "synthetic-secret" not in caplog.text
    assert native.closed and oauth._FLOWS == {}
