"""Connector page reads own no auth state, even when native refresh could replace a guest."""
from __future__ import annotations

import contextlib
import sys
import types
from pathlib import Path

import pytest

from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import connectors


class AuthError(Exception):
    def __init__(self, code):
        self.code = code


@pytest.fixture
def page(monkeypatch, tmp_path):
    home = tmp_path / "profile"
    home.mkdir()
    state = types.SimpleNamespace(home=home, tokens={}, calls=[], failure=None, refreshes=0, writes=[])

    @contextlib.contextmanager
    def scoped(path):
        previous, state.home = state.home, Path(path)
        try:
            yield path
        finally:
            state.home = previous

    def create():
        state.calls.append("create")
        (state.home / "auth.json").write_text("synthetic-created-identity")

    def refreshing_token():
        state.refreshes += 1
        create()
        if isinstance(state.failure, AuthError):
            state.failure = None
        return "substitute-token"

    def peek():
        return state.tokens.get(state.home)

    entry = {"slug": "gmail", "name": "Gmail", "description": "Mail", "category": "communication", "logo_url": None}

    class Client:
        def __init__(self, *, header_provider=None):
            self.headers = header_provider or (lambda _: {"Authorization": refreshing_token()})

        def require_authentication(self):
            if not self.headers("https://portal.example.test").get("Authorization"):
                raise AuthError("NO_TOKEN")

        def request(self, name):
            self.require_authentication()
            state.calls.append(name)
            if state.failure:
                raise state.failure

        def catalog(self):
            self.request("catalog")
            return types.SimpleNamespace(connectors=[types.SimpleNamespace(model_dump=lambda **_: entry)])

        def public_catalog(self):
            state.calls.append("public_catalog")
            if state.failure:
                raise state.failure
            return types.SimpleNamespace(connectors=[types.SimpleNamespace(model_dump=lambda **_: entry)])

        def list_accounts(self):
            self.request("accounts")
            return []

        def delete_account(self, connection_id):
            self.request("remove")
            return {"connectionId": connection_id, "connector": "gmail", "status": "removed"}

        def set_policy(self, body):
            self.request("set_policy")
            state.writes.append(body)
            return types.SimpleNamespace(revision="rev-2")

        def policy(self):
            self.request("policy")
            return types.SimpleNamespace(layers=[], effective=types.SimpleNamespace(model_dump=lambda **_: {"revision": "native"}))

    for name, attrs in {
        "tools": {}, "tools.connectors": {"connectors_available": lambda: True, "ensure_guest_identity": create},
        "tools.connectors.portal": {}, "tools.connectors.portal.client": {"PortalConnectorClient": Client, "validate_slug": lambda _: None},
        "tools.connectors.portal.errors": {"InvalidConnectorSlug": ValueError},
        "tools.connectors.gateway": {}, "tools.connectors.gateway.errors": {"GatewayAuthError": AuthError},
        "tools.managed_tool_gateway": {"peek_nous_access_token": peek},
        "tools.connectors.portal.policy": {
            "InvalidMemberPolicy": ValueError,
            "compose_connector_write": lambda member, action: {"mode": "deny", "disabledConnectors": [] if action.enabled else [action.connector]},
            "compose_tools_write": lambda member, action: {"tools": {action.connector: {"disable": action.disabled_tools}}},
        },
    }.items():
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(connectors, "scoped_home", scoped)
    methods = {}
    def register(name):
        def add(fn):
            methods[name] = fn
            return fn
        return add
    connectors.register(types.SimpleNamespace(method=register))
    state.call = lambda method, **params: methods[method](None, {"profile_home": str(state.home), **params})
    state.client = Client
    return state


@pytest.mark.parametrize("identity", ["absent", "opted_out", "expired", "signed_in", "portal_failure"])
@pytest.mark.parametrize("public_catalog", [False, True])
def test_page_reads_never_provision_or_write_auth(page, identity, public_catalog, caplog):
    if not public_catalog:
        delattr(page.client, "public_catalog")
    if identity in {"expired", "signed_in", "portal_failure"}:
        page.tokens[page.home] = "synthetic-held-token"
    if identity == "expired":
        page.failure = AuthError("TOKEN_EXPIRED")
    elif identity == "portal_failure":
        page.failure = RuntimeError("portal offline synthetic-secret")
    before = list(page.home.iterdir())
    for _ in range(3):  # mount, refresh, reopen
        for method in ("connectors.catalog", "connectors.accounts", "connectors.policy.get"):
            try:
                answer = page.call(method)
            except RpcError as exc:
                assert identity != "signed_in"
                assert "synthetic-secret" not in str(exc)
            else:
                if method == "connectors.accounts":
                    assert answer == {"accounts": []}
                elif method == "connectors.catalog":
                    assert answer["connectors"][0]["slug"] == "gmail"
    assert "create" not in page.calls
    assert "synthetic-secret" not in caplog.text
    assert list(page.home.iterdir()) == before
    if identity in {"absent", "opted_out"}:
        assert page.calls == (["public_catalog"] * 3 if public_catalog else [])


def test_refresh_adopts_external_identity_and_does_not_borrow_another_profile(page, tmp_path):
    assert page.call("connectors.accounts") == {"accounts": []}
    page.tokens[page.home] = "externally-signed-in"
    assert page.call("connectors.policy.get")["effective"]["revision"] == "native"
    other = tmp_path / "other"
    other.mkdir()
    page.home = other
    assert page.call("connectors.accounts") == {"accounts": []}
    with pytest.raises(RpcError) as failure:
        page.call("connectors.policy.get")
    assert failure.value.data["condition"] == "connectors_sign_in"
    assert "create" not in page.calls
    assert list(other.iterdir()) == []


def test_only_explicit_connect_enters_the_guest_creation_gate(page, monkeypatch):
    monkeypatch.setattr(connectors, "connect", lambda home, slug: {"started": slug})
    assert page.call("connectors.connect", connector="gmail") == {"started": "gmail"}
    assert page.calls == ["create"]
    assert (page.home / "auth.json").exists()


@pytest.mark.parametrize("method,params,expected", [
    ("connectors.remove", {"connection_id": "conn-gmail"}, {"connection_id": "conn-gmail", "connector": "gmail", "status": "removed"}),
    ("connectors.policy.set", {"connector": "gmail", "expected_revision": "rev-1", "enabled": False}, {"revision": "rev-2"}),
    ("connectors.policy.set", {"connector": "gmail", "expected_revision": "rev-1", "tool": "gmail_send", "tool_enabled": False}, {"revision": "rev-2"}),
], ids=["disconnect", "connector-rule", "tool-rule"])
def test_explicit_writes_refresh_expired_credentials(page, method, params, expected):
    page.tokens[page.home] = "expired-held-token"
    page.failure = AuthError("TOKEN_EXPIRED")
    try:
        answer = page.call(method, **params)
    except RpcError as error:
        answer = error.data
    assert answer == expected
    assert page.refreshes > 0
    if method == "connectors.policy.set":
        assert page.writes[0]["expectedRevision"] == "rev-1"
